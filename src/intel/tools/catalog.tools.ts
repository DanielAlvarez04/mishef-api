import { Injectable } from '@nestjs/common';
import { OrderRoundStatus } from '@prisma/client';
import { z } from 'zod';

import { fromCanonicalQuantity, toDisplayCost } from '../../common/units';
import { ItemsService } from '../../catalog/items.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  periodParameters,
  periodPayload,
  periodSchema,
  resolvePeriod,
  type PeriodInput,
} from './periods';
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

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const marginSchema = z
  .object({
    limit: z.number().int().min(1).max(20).optional(),
    onlyAboveTarget: z.boolean().optional(),
  })
  .strict();

const recipeSchema = z
  .object({
    item: z.string().trim().min(1).max(120),
  })
  .strict();

const menuPerformanceSchema = periodSchema.extend({
  limit: z.number().int().min(1).max(20).optional(),
});

@Injectable()
export class CatalogTools {
  constructor(
    private readonly items: ItemsService,
    private readonly prisma: PrismaService,
  ) {}

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

          const completeCount = report.items.filter((row) => row.complete)
            .length;
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
              completeCount,
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
              : input.onlyAboveTarget && completeCount > 0
                ? `Ningún platillo supera el food cost objetivo del ${Math.round(report.target * 100)}%; hay ${completeCount} platillos con receta completa.`
                : 'No hay platillos con receta completa para calcular margen.',
          };
        },
      },
      {
        name: 'costeoReceta',
        description:
          'Desglose del costo de una receta por ingrediente, con rendimiento, food cost y margen. Úsala para preguntas de cuánto cuesta preparar un platillo o qué insumo encarece una receta.',
        parameters: {
          type: 'object',
          properties: {
            item: {
              type: 'string',
              description:
                'Nombre o ID del artículo cuya receta se quiere costear.',
            },
          },
          required: ['item'],
          additionalProperties: false,
        },
        schema: recipeSchema,
        permission: 'costs:read',
        execute: async (ctx, args) => {
          const input = args as { item: string };
          const query = input.item.trim();

          const item = await this.prisma.item.findFirst({
            where: {
              organizationId: ctx.organizationId,
              isActive: true,
              OR: [
                { id: query },
                { name: { contains: query, mode: 'insensitive' } },
              ],
            },
            select: {
              id: true,
              name: true,
              price: true,
              taxRate: true,
              recipes: {
                where: { isActive: true },
                orderBy: [{ variantId: 'asc' }, { name: 'asc' }],
                select: {
                  id: true,
                  name: true,
                  variantId: true,
                  yieldQuantity: true,
                  yieldUnit: true,
                  ingredients: {
                    select: {
                      quantity: true,
                      isOptional: true,
                      label: true,
                      ingredient: {
                        select: {
                          name: true,
                          unitCost: true,
                          displayUnit: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          });

          if (!item) {
            return {
              ok: false,
              error: `No encontré un artículo activo que coincida con "${query}".`,
            };
          }

          const recipes = item.recipes.map((recipe) => {
            let totalCost = 0;
            const missing: string[] = [];

            const lines = recipe.ingredients.map((line) => {
              const displayUnit = line.ingredient.displayUnit;
              const quantity = Number(
                fromCanonicalQuantity(line.quantity, displayUnit),
              );
              const unitCost =
                line.ingredient.unitCost == null
                  ? null
                  : Number(
                      toDisplayCost(line.ingredient.unitCost, displayUnit),
                    );
              const lineCost =
                unitCost == null ? null : round(quantity * unitCost);

              if (!line.isOptional) {
                if (lineCost == null) {
                  missing.push(line.ingredient.name);
                } else {
                  totalCost += lineCost;
                }
              }

              return {
                ingredient: line.label ?? line.ingredient.name,
                quantity,
                unit: displayUnit,
                unitCost,
                lineCost,
                optional: line.isOptional,
              };
            });

            return {
              id: recipe.id,
              name: recipe.name,
              variantId: recipe.variantId,
              yieldQuantity:
                recipe.yieldQuantity == null
                  ? null
                  : Number(recipe.yieldQuantity),
              yieldUnit: recipe.yieldUnit,
              cost: round(totalCost),
              missing,
              lines,
            };
          });

          const price = Number(item.price);
          const taxRate = item.taxRate ? Number(item.taxRate) : 0;
          const netPrice = taxRate > 0 ? price / (1 + taxRate) : price;
          const baseRecipe =
            recipes.find((recipe) => recipe.variantId === null) ?? recipes[0];
          const baseCost = baseRecipe?.cost ?? 0;
          const foodCostPct = netPrice > 0 ? baseCost / netPrice : 0;
          const margin = netPrice - baseCost;
          const marginPct = netPrice > 0 ? margin / netPrice : 0;

          return {
            ok: true,
            data: {
              item: {
                id: item.id,
                name: item.name,
                price,
                netPrice: round(netPrice),
              },
              recipes,
              baseRecipeId: baseRecipe?.id ?? null,
              cost: round(baseCost),
              foodCostPct: round(foodCostPct * 10000) / 10000,
              margin: round(margin),
              marginPct: round(marginPct * 10000) / 10000,
            },
            source: 'prisma.item',
            summary: baseRecipe
              ? `${item.name}: costo de receta ${money(baseCost, ctx.currency)}, precio sin IVA ${money(netPrice, ctx.currency)}, margen ${money(margin, ctx.currency)} (${Math.round(marginPct * 100)}%).`
              : `${item.name} no tiene una receta activa para costear.`,
          };
        },
      },
      {
        name: 'desempenoDeMenus',
        description:
          'Ventas y rendimiento por menú en un periodo: ingresos, unidades, artículos vendidos y el artículo top de cada menú. Úsala para preguntas de qué menú funciona mejor.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: {
              type: 'number',
              description: 'Cuántos menús devolver (1–20). Por defecto 10.',
            },
          },
          additionalProperties: false,
        },
        schema: menuPerformanceSchema,
        permission: 'reports:read',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);

          const [menus, sales] = await Promise.all([
            this.prisma.menu.findMany({
              where: {
                organizationId: ctx.organizationId,
                isActive: true,
              },
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              select: {
                id: true,
                name: true,
                items: {
                  select: {
                    itemId: true,
                    item: { select: { name: true } },
                  },
                },
              },
            }),
            this.prisma.orderItem.groupBy({
              by: ['itemId'],
              where: {
                orderRound: {
                  status: { not: OrderRoundStatus.CANCELLED },
                  order: {
                    organizationId: ctx.organizationId,
                    ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
                    createdAt: { gte: period.from, lte: period.to },
                  },
                },
              },
              _sum: { quantity: true, subtotal: true },
            }),
          ]);

          const salesMap = new Map(
            sales.map((row) => [
              row.itemId,
              {
                quantity: row._sum.quantity ?? 0,
                revenue: round(Number(row._sum.subtotal ?? 0)),
              },
            ]),
          );

          const rows = menus
            .map((menu) => {
              let revenue = 0;
              let quantity = 0;
              let soldItems = 0;
              let topItem: { name: string; revenue: number } | null = null;

              for (const menuItem of menu.items) {
                const sale = salesMap.get(menuItem.itemId);

                if (!sale) continue;

                revenue += sale.revenue;
                quantity += sale.quantity;
                soldItems += 1;

                if (!topItem || sale.revenue > topItem.revenue) {
                  topItem = {
                    name: menuItem.item.name,
                    revenue: sale.revenue,
                  };
                }
              }

              return {
                id: menu.id,
                name: menu.name,
                revenue: round(revenue),
                quantity,
                soldItems,
                totalItems: menu.items.length,
                topItem,
              };
            })
            .filter((menu) => menu.soldItems > 0)
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, input.limit ?? 10);

          return {
            ok: true,
            data: { menus: rows },
            period: periodPayload(period),
            source: 'prisma.menu',
            summary: rows.length
              ? `El menú con más ingresos es ${rows[0].name} (${money(
                  rows[0].revenue,
                  ctx.currency,
                )}, ${rows[0].quantity} unidades).`
              : 'No hay ventas de menús en el periodo.',
          };
        },
      },
    ];
  }
}
