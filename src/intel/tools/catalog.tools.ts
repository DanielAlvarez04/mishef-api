import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ItemsService } from '../../catalog/items.service';
import type { IntelTool } from './tool.types';

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

const marginSchema = z
  .object({
    limit: z.number().int().min(1).max(20).optional(),
    onlyAboveTarget: z.boolean().optional(),
  })
  .strict();

@Injectable()
export class CatalogTools {
  constructor(private readonly items: ItemsService) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'margenPorPlatillo',
        description:
          'Margen y food cost por platillo a partir de la receta y el costo actual de los insumos. Úsala para preguntas de rentabilidad o para detectar platillos con margen bajo.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Cuántos platillos devolver (1–20). Por defecto 10.',
            },
            onlyAboveTarget: {
              type: 'boolean',
              description:
                'Si es true, solo devuelve los que superan el food cost objetivo (35%).',
            },
          },
          additionalProperties: false,
        },
        schema: marginSchema,
        permission: 'costs:read',
        execute: async (ctx, args) => {
          const input = args as {
            limit?: number;
            onlyAboveTarget?: boolean;
          };

          const report = await this.items.foodCost(ctx.organizationId, 0.35);

          let rows = report.items.filter((row) => row.complete);

          if (input.onlyAboveTarget) {
            rows = rows.filter((row) => row.aboveTarget);
          }

          rows = rows
            .sort((a, b) => a.marginPct - b.marginPct)
            .slice(0, input.limit ?? 10);

          return {
            ok: true,
            data: {
              target: report.target,
              summary: report.summary,
              items: rows.map((row) => ({
                name: row.name,
                price: row.price,
                netPrice: row.netPrice,
                cost: row.cost,
                margin: row.margin,
                marginPct: row.marginPct,
                foodCostPct: row.foodCostPct,
                aboveTarget: row.aboveTarget,
              })),
            },
            source: 'catalog.foodCost',
            summary: rows.length
              ? `Los platillos con menor margen son: ${rows
                  .slice(0, 5)
                  .map(
                    (row) =>
                      `${row.name} (${money(row.margin, ctx.currency)}, ${Math.round(
                        row.marginPct * 100,
                      )}% margen)`,
                  )
                  .join(', ')}.`
              : 'No hay platillos con receta completa para calcular margen.',
          };
        },
      },
    ];
  }
}
