import { Injectable, NotFoundException } from '@nestjs/common';
import { PrepTimeSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  HISTORICAL_MIN_DAYS,
  HISTORICAL_MIN_ROUNDS,
  HISTORICAL_WINDOW_DAYS,
  median,
} from '../common/prep';
import { UpdateKitchenSettingsDto } from './dto/update-kitchen-settings.dto';

export interface KitchenHistoricalStats {
  /** Mediana de minutos reales de preparación; `null` sin muestras. */
  averageMinutes: number | null;
  /** Rondas con inicio y fin de preparación dentro de la ventana. */
  samples: number;
  /** Días desde la primera ronda completada. */
  days: number;
  minRounds: number;
  minDays: number;
  windowDays: number;
  /** Ya se puede usar el promedio real. */
  available: boolean;
}

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Configuración de cocina + estadísticas históricas.
   *
   * El histórico se calcula por sucursal cuando hay una activa; en la vista
   * consolidada usa toda la organización.
   */
  async settings(organizationId: string | null, branchId: string | null = null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        kitchenPrepMinutes: true,
        kitchenPrepSource: true,
        kitchenSuggestOrder: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    const historical = await this.prepStats(organizationId, branchId);
    const useHistorical =
      organization.kitchenPrepSource === PrepTimeSource.HISTORICAL &&
      historical.available &&
      historical.averageMinutes !== null;

    return {
      prepMinutes: organization.kitchenPrepMinutes,
      source: organization.kitchenPrepSource,
      suggestOrder: organization.kitchenSuggestOrder,
      historical,
      /** Tiempo base que se está usando de verdad en este momento. */
      effectiveMinutes:
        useHistorical && historical.averageMinutes !== null
          ? historical.averageMinutes
          : organization.kitchenPrepMinutes,
      usingHistorical: useHistorical && historical.averageMinutes !== null,
    };
  }

  /**
   * Aplica cambios parciales a la configuración de cocina.
   *
   * Nunca escribe columnas idénticas: si el payload no cambia nada, no hay
   * `update` y `updatedAt` se queda quieto.
   */
  async updateSettings(
    organizationId: string | null,
    dto: UpdateKitchenSettingsDto,
    branchId: string | null = null,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        kitchenPrepMinutes: true,
        kitchenPrepSource: true,
        kitchenSuggestOrder: true,
      },
    });

    if (!current) {
      throw new NotFoundException('Organización no encontrada');
    }

    const data: {
      kitchenPrepMinutes?: number;
      kitchenPrepSource?: PrepTimeSource;
      kitchenSuggestOrder?: boolean;
    } = {};

    if (
      dto.prepMinutes !== undefined &&
      dto.prepMinutes !== current.kitchenPrepMinutes
    ) {
      data.kitchenPrepMinutes = dto.prepMinutes;
    }

    if (
      dto.source !== undefined &&
      dto.source !== current.kitchenPrepSource
    ) {
      data.kitchenPrepSource = dto.source;
    }

    if (
      dto.suggestOrder !== undefined &&
      dto.suggestOrder !== current.kitchenSuggestOrder
    ) {
      data.kitchenSuggestOrder = dto.suggestOrder;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.organization.update({
        where: { id: organizationId },
        data,
      });
    }

    return this.settings(organizationId, branchId);
  }

  /**
   * Promedio real de preparación y avance de la calibración.
   *
   * `startedAt → readyAt` es el tiempo que la cocina tardó de verdad en la
   * ronda. Se usa la mediana para que un pedido atípico no mueva el número.
   */
  async prepStats(
    organizationId: string | null,
    branchId: string | null = null,
  ): Promise<KitchenHistoricalStats> {
    if (!organizationId) {
      return {
        averageMinutes: null,
        samples: 0,
        days: 0,
        minRounds: HISTORICAL_MIN_ROUNDS,
        minDays: HISTORICAL_MIN_DAYS,
        windowDays: HISTORICAL_WINDOW_DAYS,
        available: false,
      };
    }

    const scope = {
      order: {
        organizationId,
        ...(branchId ? { branchId } : {}),
      },
    };
    const since = new Date(
      Date.now() - HISTORICAL_WINDOW_DAYS * 86_400_000,
    );

    const [rounds, first] = await Promise.all([
      this.prisma.orderRound.findMany({
        where: {
          ...scope,
          startedAt: { not: null, gte: since },
          readyAt: { not: null },
        },
        select: { startedAt: true, readyAt: true },
        orderBy: { startedAt: 'desc' },
        take: 5_000,
      }),
      this.prisma.orderRound.findFirst({
        where: {
          ...scope,
          startedAt: { not: null },
          readyAt: { not: null },
        },
        orderBy: { startedAt: 'asc' },
        select: { startedAt: true },
      }),
    ]);

    const durations = rounds
      .filter(
        (round): round is { startedAt: Date; readyAt: Date } =>
          round.startedAt !== null && round.readyAt !== null,
      )
      .map(
        (round) =>
          (round.readyAt.getTime() - round.startedAt.getTime()) / 60_000,
      )
      .filter((value) => value > 0 && value <= 24 * 60);

    const average = median(durations);
    const days = first?.startedAt
      ? Math.floor((Date.now() - first.startedAt.getTime()) / 86_400_000) + 1
      : 0;
    const available =
      durations.length >= HISTORICAL_MIN_ROUNDS || days >= HISTORICAL_MIN_DAYS;

    return {
      averageMinutes:
        average === null ? null : Math.max(1, Math.round(average)),
      samples: durations.length,
      days,
      minRounds: HISTORICAL_MIN_ROUNDS,
      minDays: HISTORICAL_MIN_DAYS,
      windowDays: HISTORICAL_WINDOW_DAYS,
      available,
    };
  }

  /**
   * Minutos de respaldo para artículos sin tiempo propio.
   *
   * Si el negocio eligió el histórico pero todavía no hay datos suficientes,
   * se usa el manual: un promedio con dos muestras sería peor que 15 min.
   */
  async fallbackMinutes(
    organizationId: string | null,
    branchId: string | null = null,
  ): Promise<number> {
    if (!organizationId) return 15;

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { kitchenPrepMinutes: true, kitchenPrepSource: true },
    });

    if (!organization) return 15;

    if (organization.kitchenPrepSource === PrepTimeSource.MANUAL) {
      return organization.kitchenPrepMinutes;
    }

    const stats = await this.prepStats(organizationId, branchId);
    const usable =
      stats.available && stats.averageMinutes !== null
        ? stats.averageMinutes
        : null;

    return usable ?? organization.kitchenPrepMinutes;
  }
}
