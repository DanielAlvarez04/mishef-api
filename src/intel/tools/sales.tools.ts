import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DashboardService } from '../../dashboard/dashboard.service';
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

@Injectable()
export class SalesTools {
  constructor(private readonly dashboard: DashboardService) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'ventasResumen',
        description:
          'Resumen de ventas confirmadas, pedidos y ticket promedio para un periodo. Úsala para preguntas de ingresos, ventas del día, semana o mes.',
        parameters: {
          type: 'object',
          properties: periodParameters,
          additionalProperties: false,
        },
        schema: periodSchema,
        permission: 'reports:read',
        execute: async (ctx, args) => {
          const period = resolvePeriod(args as PeriodInput);
          const report = await this.dashboard.salesReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );

          return {
            ok: true,
            data: {
              totals: report.totals,
              byDay: report.byDay,
            },
            period: periodPayload(period),
            source: 'dashboard.salesReport',
            summary: `Ventas confirmadas: ${money(
              report.totals.sales,
              ctx.currency,
            )} en ${report.totals.orders} pedidos; ticket promedio ${money(
              report.totals.averageTicket,
              ctx.currency,
            )}.`,
          };
        },
      },
      {
        name: 'topPlatillos',
        description:
          'Platillos más vendidos por cantidad en un periodo. Úsala para preguntas de popularidad o para elegir qué promocionar.',
        parameters: {
          type: 'object',
          properties: {
            ...periodParameters,
            limit: {
              type: 'number',
              description: 'Cuántos platillos devolver (1–20). Por defecto 5.',
            },
          },
          additionalProperties: false,
        },
        schema: periodSchema.extend({
          limit: z.number().int().min(1).max(20).optional(),
        }),
        permission: 'reports:read',
        execute: async (ctx, args) => {
          const input = args as PeriodInput & { limit?: number };
          const period = resolvePeriod(input);
          const report = await this.dashboard.salesReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );
          const items = report.topItems.slice(0, input.limit ?? 5);

          return {
            ok: true,
            data: { items },
            period: periodPayload(period),
            source: 'dashboard.salesReport',
            summary: items.length
              ? `Más vendidos: ${items
                  .map((item) => `${item.name} (${item.quantity})`)
                  .join(', ')}.`
              : 'No hay platillos vendidos en el periodo.',
          };
        },
      },
      {
        name: 'metodosDePago',
        description:
          'Desglose de pagos confirmados por método (efectivo, tarjeta, transferencia, etc.) en un periodo.',
        parameters: {
          type: 'object',
          properties: periodParameters,
          additionalProperties: false,
        },
        schema: periodSchema,
        permission: 'reports:read',
        execute: async (ctx, args) => {
          const period = resolvePeriod(args as PeriodInput);
          const report = await this.dashboard.salesReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );

          return {
            ok: true,
            data: { methods: report.byMethod },
            period: periodPayload(period),
            source: 'dashboard.salesReport',
            summary: report.byMethod.length
              ? `Métodos: ${report.byMethod
                  .map(
                    (method) =>
                      `${method.method} ${money(method.total, ctx.currency)} (${method.count})`,
                  )
                  .join(', ')}.`
              : 'No hay pagos confirmados en el periodo.',
          };
        },
      },
    ];
  }
}
