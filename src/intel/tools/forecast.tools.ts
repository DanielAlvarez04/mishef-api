import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { ForecastService } from '../forecast/forecast.service';
import type { IntelTool } from './tool.types';

const ingredientSchema = z
  .object({
    ingredient: z.string().trim().min(2).max(120),
  })
  .strict();

const forecastSchema = z
  .object({
    ingredient: z.string().trim().min(2).max(120).optional(),
    days: z.number().int().min(1).max(90).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const suggestionsSchema = z
  .object({
    coverDays: z.number().int().min(1).max(30).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const priceAlertsSchema = z
  .object({
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

@Injectable()
export class ForecastTools {
  constructor(
    private readonly forecast: ForecastService,
    private readonly prisma: PrismaService,
  ) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'pronosticoInsumo',
        description:
          'Pronóstico de consumo de un insumo (o de los más urgentes) con tendencia, días de cobertura y cantidad sugerida. Úsala para preguntas de qué va a faltar o cuánto comprar.',
        parameters: {
          type: 'object',
          properties: {
            ingredient: {
              type: 'string',
              description: 'Nombre o parte del nombre del insumo.',
            },
            days: {
              type: 'number',
              description: 'Días a proyectar (1-90). Por defecto 14.',
            },
            limit: {
              type: 'number',
              description: 'Máximo de insumos a devolver (1-50).',
            },
          },
          additionalProperties: false,
        },
        schema: forecastSchema,
        permission: 'purchases:read',
        execute: async (ctx, args) => {
          const input = args as {
            ingredient?: string;
            days?: number;
            limit?: number;
          };

          let ingredientId: string | undefined;

          if (input.ingredient) {
            const ingredient = await this.prisma.ingredient.findFirst({
              where: {
                organizationId: ctx.organizationId,
                isActive: true,
                name: { contains: input.ingredient, mode: 'insensitive' },
              },
              select: { id: true, name: true },
            });

            if (!ingredient) {
              return {
                ok: false,
                error: `No encontré el insumo "${input.ingredient}".`,
              };
            }

            ingredientId = ingredient.id;
          }

          const result = await this.forecast.overview(
            ctx.organizationId,
            ctx.branchId,
            {
              days: input.days,
              limit: input.limit ?? (ingredientId ? 1 : 15),
              ingredientId,
            },
          );

          const rows = result.rows.map((row) => ({
            ingredient: row.name,
            stock: row.currentStock,
            dailyAverage: row.dailyAverage,
            daysOfCover: row.daysOfCover,
            leadTimeDays: row.leadTimeDays,
            suggested: row.suggestedQuantity,
            unit: row.displayUnit,
            risk: row.risk,
            explanation: row.explanation,
          }));

          const urgent = rows.filter((row) => row.risk === 'HIGH').length;

          return {
            ok: true,
            data: { days: result.days, rows },
            source: 'forecast.overview',
            summary: rows.length
              ? `${urgent} insumo(s) en riesgo alto. El más urgente es ${rows[0].ingredient} con ${rows[0].daysOfCover ?? "sin"} días de cobertura.`
              : 'No hay consumo suficiente para pronosticar.',
          };
        },
      },
      {
        name: 'comprasSugeridas',
        description:
          'Lista de compra sugerida por insumo, calculada con el consumo reciente, el tiempo de entrega y el stock actual. Incluye explicación y costo estimado.',
        parameters: {
          type: 'object',
          properties: {
            coverDays: {
              type: 'number',
              description: 'Días de cobertura extra (1-30). Por defecto 7.',
            },
            limit: {
              type: 'number',
              description: 'Máximo de insumos (1-50).',
            },
          },
          additionalProperties: false,
        },
        schema: suggestionsSchema,
        permission: 'purchases:read',
        execute: async (ctx, args) => {
          const input = args as { coverDays?: number; limit?: number };
          const result = await this.forecast.suggestions(
            ctx.organizationId,
            ctx.branchId,
            input.coverDays,
            input.limit,
          );

          return {
            ok: true,
            data: result,
            source: 'forecast.suggestions',
            summary: result.items.length
              ? `${result.items.length} insumo(s) por comprar; costo estimado $${result.totalEstimatedCost.toFixed(2)}.`
              : 'No hay compras sugeridas: el stock cubre el consumo proyectado.',
          };
        },
      },
      {
        name: 'compararProveedores',
        description:
          'Compara el precio de un insumo entre proveedores usando las compras aprobadas. Úsala para preguntas de dónde conviene comprar.',
        parameters: {
          type: 'object',
          properties: {
            ingredient: {
              type: 'string',
              description: 'Nombre o parte del nombre del insumo.',
            },
          },
          required: ['ingredient'],
          additionalProperties: false,
        },
        schema: ingredientSchema,
        permission: 'purchases:read',
        execute: async (ctx, args) => {
          const input = args as { ingredient: string };
          const ingredient = await this.prisma.ingredient.findFirst({
            where: {
              organizationId: ctx.organizationId,
              isActive: true,
              name: { contains: input.ingredient, mode: 'insensitive' },
            },
            select: { id: true },
          });

          if (!ingredient) {
            return {
              ok: false,
              error: `No encontré el insumo "${input.ingredient}".`,
            };
          }

          const result = await this.forecast.comparison(
            ctx.organizationId,
            ingredient.id,
          );

          return {
            ok: true,
            data: result,
            source: 'forecast.comparison',
            summary: result.best
              ? `Mejor precio: ${result.best.supplierName} a $${result.best.lastCost} por ${result.ingredient.displayUnit}.`
              : 'Todavía no hay compras aprobadas de ese insumo.',
          };
        },
      },
      {
        name: 'cambiosDePrecio',
        description:
          'Cambios de precio recientes de proveedores (subidas o bajadas mayores al 5%). Úsala para preguntas de por qué subió un costo o qué proveedor cambió precios.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Máximo de alertas (1-20).',
            },
          },
          additionalProperties: false,
        },
        schema: priceAlertsSchema,
        permission: 'purchases:read',
        execute: async (ctx, args) => {
          const input = args as { limit?: number };
          const result = await this.forecast.priceAlerts(ctx.organizationId);
          const alerts = result.alerts.slice(0, input.limit ?? 10);

          return {
            ok: true,
            data: { alerts },
            source: 'forecast.priceAlerts',
            summary: alerts.length
              ? `${alerts.length} cambio(s) de precio detectados; el mayor es ${alerts[0].ingredientName} (${alerts[0].changePercent > 0 ? "+" : ""}${alerts[0].changePercent}%).`
              : 'No hay cambios de precio mayores al 5%.',
          };
        },
      },
    ];
  }
}
