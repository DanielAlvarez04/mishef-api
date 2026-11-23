import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export type PeriodKey = 'today' | 'week' | 'month';

export const periodSchema = z
  .object({
    period: z.enum(['today', 'week', 'month']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();

export const periodParameters = {
  period: {
    type: 'string',
    enum: ['today', 'week', 'month'],
    description: 'Periodo a consultar. Por defecto, el mes actual.',
  },
  from: {
    type: 'string',
    description:
      'Fecha ISO inicial. Solo se usa junto con `to` y cuando no se usa `period`.',
  },
  to: {
    type: 'string',
    description:
      'Fecha ISO final. Solo se usa junto con `from` y cuando no se usa `period`.',
  },
};

export interface PeriodInput {
  period?: PeriodKey;
  from?: string;
  to?: string;
}

export interface ResolvedPeriod {
  key: PeriodKey | 'custom';
  from: Date;
  to: Date;
  label: string;
}

function startOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(value: Date): Date {
  const date = new Date(value);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
  }).format(value);
}

/**
 * Resuelve "hoy", "últimos 7 días", "este mes" o un rango ISO.
 *
 * Usa la hora local del servidor (el VPS está en America/Mexico_City), igual
 * que los reportes existentes.
 */
export function resolvePeriod(input: PeriodInput): ResolvedPeriod {
  if (input.from || input.to) {
    if (!input.from || !input.to) {
      throw new BadRequestException('from y to deben enviarse juntos');
    }

    const from = new Date(input.from);
    const to = new Date(input.to);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from y to deben ser fechas válidas');
    }

    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from no puede ser posterior a to');
    }

    // Una fecha sin hora (YYYY-MM-DD) se interpreta hasta el final del día.
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
      to.setHours(23, 59, 59, 999);
    }

    return {
      key: 'custom',
      from,
      to,
      label: `${formatDate(from)} a ${formatDate(to)}`,
    };
  }

  const now = new Date();
  const period = input.period ?? 'month';

  if (period === 'today') {
    return {
      key: 'today',
      from: startOfDay(now),
      to: now,
      label: 'Hoy',
    };
  }

  if (period === 'week') {
    const from = startOfDay(
      new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
    );

    return {
      key: 'week',
      from,
      to: now,
      label: 'Últimos 7 días',
    };
  }

  return {
    key: 'month',
    from: startOfMonth(now),
    to: now,
    label: 'Este mes',
  };
}

export function periodPayload(period: ResolvedPeriod) {
  return {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    label: period.label,
  };
}
