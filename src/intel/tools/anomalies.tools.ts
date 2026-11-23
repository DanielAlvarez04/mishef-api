import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AnomaliesService } from '../anomalies/anomalies.service';
import type { IntelTool } from './tool.types';

const anomaliesSchema = z
  .object({
    from: z.string().trim().min(4).max(40).optional(),
    to: z.string().trim().min(4).max(40).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

@Injectable()
export class AnomaliesTools {
  constructor(private readonly anomalies: AnomaliesService) {}

  get tools(): IntelTool[] {
    return [
      {
        name: 'anomalias',
        description:
          'Anomalías explicables de descuentos, cancelaciones, caja y mermas, con puntuación y evidencia. Úsala para preguntas de fugas, descuadres o movimientos sospechosos.',
        parameters: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'Fecha inicial ISO (YYYY-MM-DD). Por defecto 30 días atrás.',
            },
            to: {
              type: 'string',
              description: 'Fecha final ISO (YYYY-MM-DD). Por defecto hoy.',
            },
            limit: {
              type: 'number',
              description: 'Máximo de hallazgos (1-50).',
            },
          },
          additionalProperties: false,
        },
        schema: anomaliesSchema,
        permission: 'costs:read',
        execute: async (ctx, args) => {
          const input = args as {
            from?: string;
            to?: string;
            limit?: number;
          };

          const result = await this.anomalies.findings(
            ctx.organizationId,
            ctx.branchId,
            input,
          );

          return {
            ok: true,
            data: {
              summary: result.summary,
              findings: result.findings.map((finding) => ({
                type: finding.type,
                severity: finding.severity,
                score: finding.score,
                title: finding.title,
                detail: finding.detail,
                evidence: finding.evidence,
              })),
            },
            source: 'anomalies.findings',
            summary: result.summary.total
              ? `${result.summary.total} anomalía(s): ${result.summary.high} de prioridad alta. La principal es "${result.findings[0]?.title}".`
              : 'No se detectaron anomalías en el periodo.',
          };
        },
      },
    ];
  }
}
