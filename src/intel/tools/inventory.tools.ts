import { Injectable } from '@nestjs/common';
import { InventoryMovementType, Prisma } from '@prisma/client';
import { z } from 'zod';

import { fromCanonicalQuantity } from '../../common/units';
import { DashboardService } from '../../dashboard/dashboard.service';
import { InventoryService } from '../../inventory/inventory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WasteService } from '../../waste/waste.service';
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

/** Cap de días de inventario para no mostrar cifras absurdas en insumos sin rotación. */
const MAX_DAYS_OF_INVENTORY = 3650;

const periodWithLimit = (max: number) =>
  periodSchema.extend({
    limit: z.number().int().min(1).max(max).optional(),
  });

const limitParameter = (max: number, fallback: number) => ({
  type: 'number',
  description: `Cuántos registros devolver (1–${max}). Por defecto ${fallback}.`,
});

const stockSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

@Injectable()
export class InventoryTools {
  constructor(
    private readonly inventory: InventoryService,
    private readonly dashboard: DashboardService,
    private readonly waste: WasteService,
    private readonly prisma: PrismaService,
  ) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'stockBajo',
        description:
          'Insumos por debajo del stock mínimo, con su existencia actual, mínimo y faltante. Úsala para preguntas de qué comprar o qué está por agotarse.',
        parameters: {
          type: 'object',
          properties: {
            limit: limitParameter(50, 20),
          },
          additionalProperties: false,
        },
        schema: stockSchema,
        permission: 'inventory:manage',
        execute: async (ctx, args) => {
          const input = args as { limit?: number };
          const alerts = await this.inventory.listAlerts(
            ctx.organizationId,
            ctx.branchId,
          );
          const items = alerts.slice(0, input.limit ?? 20).map((row) => ({
            name: row.name,
            currentStock: Number(row.currentStock),
            minStock: Number(row.minStock),
            deficit: Number(row.deficit),
            unit: row.displayUnit,
            unitCost: row.unitCost == null ? null : Number(row.unitCost),
            isLowStock: row.isLowStock,
          }));

          return {
            ok: true,
            data: { total: alerts.length, items },
            source: 'inventory.listAlerts',
            summary: items.length
              ? `Hay ${alerts.length} insumos bajo mínimo. El mayor faltante es ${items[0].name} (${items[0].deficit} ${items[0].unit}).`
              : 'No hay insumos por debajo del mínimo.',
          };
        },
      },
      {
        name: 'consumoPorInsumo',
        description:
          'Consumo de insumos en un periodo, calculado desde los movimientos de inventario. Úsala para preguntas de qué se está gastando más o cuánto se consumió.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: limitParameter(50, 10),
          },
          additionalProperties: false,
        },
        schema: periodWithLimit(50),
        permission: 'reports:read:operations',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);
          const report = await this.dashboard.inventoryReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );
          const consumption = report.consumption.slice(0, input.limit ?? 10);

          return {
            ok: true,
            data: {
              consumption,
              movements: report.movements,
            },
            period: periodPayload(period),
            source: 'dashboard.inventoryReport',
            summary: consumption.length
              ? `Mayor consumo: ${consumption
                  .slice(0, 5)
                  .map(
                    (row) =>
                      `${row.name} (${row.quantity} ${row.displayUnit})`,
                  )
                  .join(', ')}.`
              : 'No hay consumo de insumos registrado en el periodo.',
          };
        },
      },
      {
        name: 'mermas',
        description:
          'Mermas registradas en un periodo, con costo total, motivos y detalle por insumo. Úsala para preguntas de desperdicio o pérdidas.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: limitParameter(100, 20),
          },
          additionalProperties: false,
        },
        schema: periodWithLimit(100),
        permission: 'inventory:manage',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);
          const result = await this.waste.list(
            ctx.organizationId,
            ctx.branchId,
            period.from.toISOString(),
            period.to.toISOString(),
          );
          const items = result.items.slice(0, input.limit ?? 20);
          const topReason = result.byReason
            .slice()
            .sort((a, b) => b.cost - a.cost)[0];

          return {
            ok: true,
            data: {
              total: result.total,
              byReason: result.byReason,
              items: items.map((item) => ({
                ingredient: item.ingredientName,
                quantity: item.quantity,
                unit: item.displayUnit,
                reason: item.reason,
                cost: item.cost,
                note: item.note,
                createdAt: item.createdAt,
              })),
            },
            period: periodPayload(period),
            source: 'waste.list',
            summary: result.items.length
              ? `Merma: ${money(result.total, ctx.currency)} en ${result.items.length} registros. Principal motivo: ${topReason?.reason ?? 'sin motivo'} (${money(topReason?.cost ?? 0, ctx.currency)}).`
              : 'No hay mermas registradas en el periodo.',
          };
        },
      },
      {
        name: 'diferencias',
        description:
          'Ajustes manuales de inventario (diferencias registradas) en un periodo. Úsala para preguntas de descuadres, ajustes o diferencias entre lo teórico y lo físico.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: limitParameter(100, 50),
          },
          additionalProperties: false,
        },
        schema: periodWithLimit(100),
        permission: 'inventory:manage',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);
          const movements = await this.inventory.listMovements(
            ctx.organizationId,
            {
              type: InventoryMovementType.ADJUSTMENT,
              from: period.from,
              to: period.to,
              limit: input.limit ?? 50,
            },
            ctx.branchId,
          );

          const items = movements.map((movement) => ({
            ingredient: movement.ingredientName,
            quantity: Number(movement.quantity),
            unit: movement.displayUnit,
            reason: movement.reason,
            unitCost:
              movement.unitCost == null ? null : Number(movement.unitCost),
            createdAt: movement.createdAt.toISOString(),
          }));

          return {
            ok: true,
            data: { total: items.length, items },
            period: periodPayload(period),
            source: 'inventory.listMovements',
            summary: items.length
              ? `Hay ${items.length} ajustes manuales en el periodo. El mayor es ${items[0].ingredient} (${items[0].quantity} ${items[0].unit}).`
              : 'No hay ajustes manuales de inventario en el periodo.',
          };
        },
      },
      {
        name: 'rotacion',
        description:
          'Rotación de insumos en un periodo: consumo contra existencia actual, turnos y días de inventario. Úsala para preguntas de qué insumo rota más lento o cuánto durará el stock.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: limitParameter(50, 10),
          },
          additionalProperties: false,
        },
        schema: periodWithLimit(50),
        permission: 'inventory:manage',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);

          const grouped = await this.prisma.inventoryMovement.groupBy({
            by: ['ingredientId', 'ingredientName', 'displayUnit'],
            where: {
              organizationId: ctx.organizationId,
              ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
              type: InventoryMovementType.CONSUMPTION,
              createdAt: { gte: period.from, lte: period.to },
            },
            _sum: { quantity: true },
          });

          const ids = grouped
            .map((row) => row.ingredientId)
            .filter((id): id is string => Boolean(id));

          if (ids.length === 0) {
            return {
              ok: true,
              data: { items: [] },
              period: periodPayload(period),
              source: 'inventoryMovement.groupBy',
              summary: 'No hay consumo registrado para calcular rotación.',
            };
          }

          const ingredients = await this.prisma.ingredient.findMany({
            where: { id: { in: ids }, organizationId: ctx.organizationId },
            select: {
              id: true,
              name: true,
              currentStock: true,
              displayUnit: true,
            },
          });

          const branchStocks = ctx.branchId
            ? await this.prisma.branchStock.findMany({
                where: {
                  branchId: ctx.branchId,
                  ingredientId: { in: ids },
                },
                select: { ingredientId: true, quantity: true },
              })
            : [];

          const branchMap = new Map(
            branchStocks.map((row) => [row.ingredientId, row.quantity]),
          );
          const ingredientMap = new Map(
            ingredients.map((row) => [row.id, row]),
          );
          const periodDays = Math.max(
            1,
            (period.to.getTime() - period.from.getTime()) / 86_400_000,
          );

          const items = grouped
            .flatMap((row) => {
              const ingredient = row.ingredientId
                ? ingredientMap.get(row.ingredientId)
                : null;

              if (!ingredient) return [];

              const consumedCanonical = new Prisma.Decimal(
                row._sum.quantity ?? 0,
              ).abs();
              const stock = ctx.branchId
                ? (branchMap.get(ingredient.id) ?? new Prisma.Decimal(0))
                : ingredient.currentStock;
              const stockNumber = Number(stock);
              const consumedNumber = Number(consumedCanonical);
              const daily = consumedNumber / periodDays;
              const rawDays = daily > 0 ? stockNumber / daily : null;
              const slow =
                rawDays !== null && rawDays > MAX_DAYS_OF_INVENTORY;

              return [{
                name: ingredient.name,
                consumed: round(
                  Number(
                    fromCanonicalQuantity(
                      consumedCanonical,
                      ingredient.displayUnit,
                    ),
                  ),
                ),
                currentStock: round(
                  Number(
                    fromCanonicalQuantity(stock, ingredient.displayUnit),
                  ),
                ),
                unit: ingredient.displayUnit,
                turns:
                  stockNumber > 0
                    ? round(consumedNumber / stockNumber)
                    : null,
                daysOfInventory:
                  rawDays === null || slow ? null : round(rawDays),
                slow,
              }];
            })
            .sort((a, b) => {
              if (a.slow !== b.slow) return a.slow ? -1 : 1;
              if (a.daysOfInventory === null) return 1;
              if (b.daysOfInventory === null) return -1;
              return b.daysOfInventory - a.daysOfInventory;
            })
            .slice(0, input.limit ?? 10);

          return {
            ok: true,
            data: { items },
            period: periodPayload(period),
            source: 'inventoryMovement.groupBy',
            summary: items.length
              ? `Menor rotación: ${items
                  .slice(0, 5)
                  .map(
                    (row) =>
                      `${row.name} (${
                        row.slow
                          ? 'sin rotación en el periodo'
                          : `${row.daysOfInventory ?? 'sin'} días de inventario`
                      })`,
                  )
                  .join(', ')}.`
              : 'No hay consumo registrado para calcular rotación.',
          };
        },
      },
    ];
  }
}
