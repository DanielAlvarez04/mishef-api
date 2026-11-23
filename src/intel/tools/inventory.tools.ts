import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { InventoryService } from '../../inventory/inventory.service';
import type { IntelTool } from './tool.types';

const stockSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

@Injectable()
export class InventoryTools {
  constructor(private readonly inventory: InventoryService) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'stockBajo',
        description:
          'Insumos por debajo del stock mínimo, con su existencia actual, mínimo y faltante. Úsala para preguntas de qué comprar o qué está por agotarse.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Cuántos insumos devolver (1–50). Por defecto 20.',
            },
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
            data: {
              total: alerts.length,
              items,
            },
            source: 'inventory.listAlerts',
            summary: items.length
              ? `Hay ${alerts.length} insumos bajo mínimo. El mayor faltante es ${items[0].name} (${items[0].deficit} ${items[0].unit}).`
              : 'No hay insumos por debajo del mínimo.',
          };
        },
      },
    ];
  }
}
