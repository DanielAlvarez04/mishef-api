import { Injectable } from '@nestjs/common';

import { DashboardService } from '../../dashboard/dashboard.service';
import {
  periodParameters,
  periodPayload,
  periodSchema,
  resolvePeriod,
  type PeriodInput,
} from './periods';
import type { IntelTool } from './tool.types';

@Injectable()
export class KitchenTools {
  constructor(private readonly dashboard: DashboardService) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'tiemposDeCocina',
        description:
          'Tiempos de cocina en un periodo: espera, preparación, entrega, tiempo total y cumplimiento del estimado. Úsala para preguntas de velocidad o desempeño de cocina.',
        parameters: {
          type: 'object',
          properties: periodParameters,
          additionalProperties: false,
        },
        schema: periodSchema,
        permission: 'reports:read:operations',
        execute: async (ctx, args) => {
          const period = resolvePeriod(args as PeriodInput);
          const report = await this.dashboard.kitchenReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );

          return {
            ok: true,
            data: {
              totals: report.totals,
              byStatus: report.byStatus,
              byDay: report.byDay,
            },
            period: periodPayload(period),
            source: 'dashboard.kitchenReport',
            summary: report.totals.rounds
              ? `Cocina: ${report.totals.rounds} rondas; espera ${report.totals.averageWaitMinutes ?? 's/d'} min, preparación ${report.totals.averagePrepMinutes ?? 's/d'} min, entrega ${report.totals.averageDeliveryMinutes ?? 's/d'} min.`
              : 'No hay rondas de cocina en el periodo.',
          };
        },
      },
      {
        name: 'cuellosDeBotella',
        description:
          'Identifica la etapa más lenta de cocina (espera, preparación o entrega) y el cumplimiento del tiempo estimado. Úsala para preguntas de dónde se atora la operación.',
        parameters: {
          type: 'object',
          properties: periodParameters,
          additionalProperties: false,
        },
        schema: periodSchema,
        permission: 'reports:read:operations',
        execute: async (ctx, args) => {
          const period = resolvePeriod(args as PeriodInput);
          const report = await this.dashboard.kitchenReport(
            ctx.organizationId,
            period.from,
            period.to,
            ctx.branchId,
          );

          const candidates = [
            { stage: 'espera', minutes: report.totals.averageWaitMinutes },
            {
              stage: 'preparación',
              minutes: report.totals.averagePrepMinutes,
            },
            {
              stage: 'entrega',
              minutes: report.totals.averageDeliveryMinutes,
            },
          ].filter(
            (row): row is { stage: string; minutes: number } =>
              row.minutes !== null && row.minutes > 0,
          );

          const bottleneck =
            candidates.sort((a, b) => b.minutes - a.minutes)[0] ?? null;

          return {
            ok: true,
            data: {
              bottleneck,
              totals: report.totals,
              byStatus: report.byStatus,
            },
            period: periodPayload(period),
            source: 'dashboard.kitchenReport',
            summary: bottleneck
              ? `El cuello de botella es ${bottleneck.stage} (${bottleneck.minutes} min promedio); ${Math.round(
                  (report.totals.withinEstimateRate ?? 0) * 100,
                )}% dentro del estimado.`
              : 'No hay suficientes tiempos registrados para identificar un cuello de botella.',
          };
        },
      },
    ];
  }
}
