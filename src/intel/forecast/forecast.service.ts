import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryMovementType,
  Prisma,
  PurchaseStatus,
  UnitCode,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  fromCanonicalQuantity,
  toCanonicalCost,
  toDisplayCost,
  unitDefinition,
} from '../../common/units';

/** Días de historia que alimentan el promedio y los factores por día. */
const HISTORY_DAYS = 84;
/** Días recientes que pesan en la tendencia. */
const TREND_DAYS = 14;
/** Días de cobertura que se suman al tiempo de entrega al sugerir. */
const DEFAULT_COVER_DAYS = 7;
/** Días de seguridad ante variación de consumo. */
const SAFETY_DAYS = 2;
/** Tope de días de cobertura para no mostrar cifras absurdas. */
const MAX_DAYS_OF_COVER = 365;

type Risk = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ForecastRow {
  ingredientId: string;
  name: string;
  displayUnit: UnitCode;
  currentStock: number;
  minStock: number;
  dailyAverage: number;
  trend: number;
  weekdayFactors: number[];
  leadTimeDays: number;
  daysOfCover: number | null;
  projectedAtLeadTime: number;
  suggestedQuantity: number;
  risk: Risk;
  explanation: string;
  unitCost: number | null;
  estimatedCost: number;
  lastSupplier: { id: string; name: string } | null;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function weekdayFactorsFrom(
  dailyTotals: Map<number, number>,
  windowDays: number,
  average: number,
): number[] {
  if (average <= 0) return [1, 1, 1, 1, 1, 1, 1];

  const factors: number[] = [];

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const total = dailyTotals.get(weekday) ?? 0;
    const expected = average * (windowDays / 7);

    factors.push(expected > 0 ? clamp(total / expected, 0.5, 2) : 1);
  }

  return factors;
}

export function trendFrom(recent: number, previous: number): number {
  if (previous <= 0) return 1;

  return clamp(recent / previous, 0.7, 1.3);
}

@Injectable()
export class ForecastService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    organizationId: string,
    branchId: string | null,
    options: {
      days?: number;
      coverDays?: number;
      limit?: number;
      ingredientId?: string;
    } = {},
  ): Promise<{ generatedAt: string; days: number; rows: ForecastRow[] }> {
    const days = options.days ?? 14;
    const coverDays = options.coverDays ?? DEFAULT_COVER_DAYS;
    const limit = options.limit ?? 100;
    const now = new Date();
    const windowStart = startOfUtcDay(
      new Date(now.getTime() - (HISTORY_DAYS - 1) * 86400000),
    );

    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        organizationId,
        isActive: true,
        ...(options.ingredientId ? { id: options.ingredientId } : {}),
      },
      select: {
        id: true,
        name: true,
        baseUnit: true,
        displayUnit: true,
        currentStock: true,
        minStock: true,
        unitCost: true,
      },
    });

    if (ingredients.length === 0) {
      return { generatedAt: now.toISOString(), days, rows: [] };
    }

    const ingredientIds = ingredients.map((ingredient) => ingredient.id);

    const [movements, wastes, purchases, branchStocks] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          ingredientId: { in: ingredientIds },
          type: InventoryMovementType.CONSUMPTION,
          quantity: { lt: 0 },
          createdAt: { gte: windowStart },
        },
        select: { ingredientId: true, quantity: true, createdAt: true },
      }),
      this.prisma.waste.findMany({
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          ingredientId: { in: ingredientIds },
          createdAt: { gte: windowStart },
        },
        select: { ingredientId: true, quantity: true, createdAt: true },
      }),
      this.prisma.purchaseItem.findMany({
        where: {
          ingredientId: { in: ingredientIds },
          purchase: {
            organizationId,
            status: PurchaseStatus.APPROVED,
            ...(branchId ? { branchId } : {}),
          },
        },
        select: {
          ingredientId: true,
          quantity: true,
          unit: true,
          unitCostGross: true,
          purchase: {
            select: {
              purchasedAt: true,
              supplier: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { purchase: { purchasedAt: 'desc' } },
        take: 5000,
      }),
      branchId
        ? this.prisma.branchStock.findMany({
            where: {
              branchId,
              ingredientId: { in: ingredientIds },
            },
            select: { ingredientId: true, quantity: true },
          })
        : Promise.resolve([]),
    ]);

    const dailyByIngredient = new Map<string, Map<string, number>>();
    const weekdayByIngredient = new Map<string, Map<number, number>>();
    const datesByIngredient = new Map<string, Set<string>>();

    const addDemand = (
      ingredientId: string,
      quantity: number,
      createdAt: Date,
    ) => {
      if (!Number.isFinite(quantity) || quantity <= 0) return;

      const key = dateKey(createdAt);
      const daily = dailyByIngredient.get(ingredientId) ?? new Map();
      daily.set(key, (daily.get(key) ?? 0) + quantity);
      dailyByIngredient.set(ingredientId, daily);

      const weekday = createdAt.getUTCDay();
      const weekdayMap = weekdayByIngredient.get(ingredientId) ?? new Map();
      weekdayMap.set(weekday, (weekdayMap.get(weekday) ?? 0) + quantity);
      weekdayByIngredient.set(ingredientId, weekdayMap);

      const dates = datesByIngredient.get(ingredientId) ?? new Set();
      dates.add(key);
      datesByIngredient.set(ingredientId, dates);
    };

    for (const movement of movements) {
      if (!movement.ingredientId) continue;

      addDemand(
        movement.ingredientId,
        Math.abs(Number(movement.quantity)),
        movement.createdAt,
      );
    }

    for (const waste of wastes) {
      if (!waste.ingredientId) continue;

      addDemand(
        waste.ingredientId,
        Number(waste.quantity),
        waste.createdAt,
      );
    }

    const purchaseDates = new Map<string, Date[]>();
    const lastSupplier = new Map<string, { id: string; name: string }>();

    for (const purchase of purchases) {
      if (!purchase.ingredientId) continue;

      const dates = purchaseDates.get(purchase.ingredientId) ?? [];
      const purchasedAt = purchase.purchase.purchasedAt;

      if (dates.every((date) => dateKey(date) !== dateKey(purchasedAt))) {
        dates.push(purchasedAt);
      }

      purchaseDates.set(purchase.ingredientId, dates);

      if (
        purchase.purchase.supplier &&
        !lastSupplier.has(purchase.ingredientId)
      ) {
        lastSupplier.set(purchase.ingredientId, purchase.purchase.supplier);
      }
    }

    const branchStockByIngredient = new Map(
      branchStocks.map((row) => [row.ingredientId, Number(row.quantity)]),
    );

    const rows: ForecastRow[] = [];

    for (const ingredient of ingredients) {
      const daily = dailyByIngredient.get(ingredient.id);
      const total = daily
        ? [...daily.values()].reduce((sum, value) => sum + value, 0)
        : 0;
      const average = total / HISTORY_DAYS;

      const recentTotal = daily
        ? [...daily.entries()]
            .filter(
              ([key]) =>
                new Date(`${key}T00:00:00.000Z`).getTime() >=
                now.getTime() - TREND_DAYS * 86400000,
            )
            .reduce((sum, [, value]) => sum + value, 0)
        : 0;
      const trend = trendFrom(
        recentTotal / TREND_DAYS,
        (total - recentTotal) / (HISTORY_DAYS - TREND_DAYS),
      );

      const weekdayFactors = weekdayFactorsFrom(
        weekdayByIngredient.get(ingredient.id) ?? new Map(),
        HISTORY_DAYS,
        average,
      );

      const dates = (purchaseDates.get(ingredient.id) ?? []).slice(0, 10);
      let leadTimeDays = 3;

      if (dates.length >= 2) {
        const gaps: number[] = [];

        for (let index = 1; index < dates.length; index += 1) {
          gaps.push(
            (dates[index - 1].getTime() - dates[index].getTime()) / 86400000,
          );
        }

        const valid = gaps.filter((gap) => gap > 0 && Number.isFinite(gap));

        if (valid.length > 0) {
          leadTimeDays = clamp(
            valid.reduce((sum, gap) => sum + gap, 0) / valid.length,
            1,
            14,
          );
        }
      }

      const currentStockBase = branchId
        ? branchStockByIngredient.get(ingredient.id) ?? 0
        : Number(ingredient.currentStock);
      const minStockBase = Number(ingredient.minStock);
      const dailyProjection = average * trend;
      const daysOfCover =
        dailyProjection > 0
          ? Math.min(currentStockBase / dailyProjection, MAX_DAYS_OF_COVER)
          : null;
      const projectedAtLeadTime =
        currentStockBase - dailyProjection * leadTimeDays;
      const safety = dailyProjection * SAFETY_DAYS;
      const suggestedBase = Math.max(
        0,
        dailyProjection * (leadTimeDays + coverDays) + safety - currentStockBase,
      );

      let risk: Risk = 'LOW';

      if (currentStockBase <= minStockBase) {
        risk = 'HIGH';
      } else if (daysOfCover !== null && daysOfCover <= leadTimeDays) {
        risk = 'HIGH';
      } else if (
        daysOfCover !== null &&
        daysOfCover <= leadTimeDays + 3
      ) {
        risk = 'MEDIUM';
      }

      const displayUnit = ingredient.displayUnit;
      const toDisplay = (value: number) =>
        round(Number(fromCanonicalQuantity(value, displayUnit)), 2);

      const canonicalCost =
        ingredient.unitCost === null ? null : Number(ingredient.unitCost);
      const unitCost =
        canonicalCost === null
          ? null
          : round(
              Number(toDisplayCost(canonicalCost, ingredient.displayUnit)),
              4,
            );
      const estimatedCost =
        canonicalCost === null ? 0 : round(suggestedBase * canonicalCost, 2);

      const supplier = lastSupplier.get(ingredient.id) ?? null;

      rows.push({
        ingredientId: ingredient.id,
        name: ingredient.name,
        displayUnit,
        currentStock: toDisplay(currentStockBase),
        minStock: toDisplay(minStockBase),
        dailyAverage: toDisplay(dailyProjection),
        trend: round(trend, 2),
        weekdayFactors: weekdayFactors.map((factor) => round(factor, 2)),
        leadTimeDays: round(leadTimeDays, 1),
        daysOfCover: daysOfCover === null ? null : round(daysOfCover, 1),
        projectedAtLeadTime: toDisplay(projectedAtLeadTime),
        suggestedQuantity: toDisplay(suggestedBase),
        risk,
        explanation: [
          `Consume ${toDisplay(dailyProjection)} ${displayUnit}/día (tendencia ${round(
            trend,
            2,
          )}×).`,
          `Entrega estimada ${round(leadTimeDays, 1)} días; cobertura ${daysOfCover === null ? "sin consumo" : `${round(daysOfCover, 1)} días`}.`,
          `Stock ${toDisplay(currentStockBase)} ${displayUnit}; sugerido ${toDisplay(
            suggestedBase,
          )} ${displayUnit}.`,
        ].join(' '),
        unitCost,
        estimatedCost,
        lastSupplier: supplier,
      });
    }

    const order: Record<Risk, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

    rows.sort((left, right) => {
      const byRisk = order[left.risk] - order[right.risk];
      if (byRisk !== 0) return byRisk;

      return (
        (left.daysOfCover ?? MAX_DAYS_OF_COVER) -
        (right.daysOfCover ?? MAX_DAYS_OF_COVER)
      );
    });

    return {
      generatedAt: now.toISOString(),
      days,
      rows: rows.slice(0, limit),
    };
  }

  async suggestions(
    organizationId: string,
    branchId: string | null,
    coverDays = DEFAULT_COVER_DAYS,
    limit = 50,
  ) {
    const { generatedAt, rows } = await this.overview(organizationId, branchId, {
      coverDays,
      limit: 500,
    });

    const items = rows
      .filter((row) => row.suggestedQuantity > 0)
      .slice(0, limit);

    return {
      generatedAt,
      coverDays,
      items,
      totalEstimatedCost: round(
        items.reduce((sum, item) => sum + item.estimatedCost, 0),
        2,
      ),
    };
  }

  async priceAlerts(organizationId: string) {
    const since = new Date(Date.now() - 365 * 86400000);

    const rows = await this.prisma.purchaseItem.findMany({
      where: {
        purchase: {
          organizationId,
          status: PurchaseStatus.APPROVED,
          purchasedAt: { gte: since },
        },
        ingredientId: { not: null },
      },
      select: {
        ingredientId: true,
        unit: true,
        unitCostGross: true,
        ingredient: {
          select: {
            name: true,
            baseUnit: true,
            displayUnit: true,
          },
        },
        purchase: {
          select: {
            purchasedAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { purchase: { purchasedAt: 'desc' } },
      take: 3000,
    });

    const grouped = new Map<
      string,
      Array<(typeof rows)[number]>
    >();

    for (const row of rows) {
      if (!row.ingredientId || !row.purchase.supplier) continue;

      const key = `${row.purchase.supplier.id}|${row.ingredientId}`;
      const list = grouped.get(key) ?? [];

      if (list.length < 2) list.push(row);
      grouped.set(key, list);
    }

    const alerts: Array<{
      ingredientId: string;
      ingredientName: string;
      supplierId: string;
      supplierName: string;
      previousCost: number;
      lastCost: number;
      changePercent: number;
      displayUnit: UnitCode;
      lastPurchasedAt: string;
    }> = [];

    for (const list of grouped.values()) {
      if (list.length < 2) continue;

      const [last, previous] = list;
      const ingredient = last.ingredient;

      if (!ingredient) continue;

      const lastDimension = unitDefinition(last.unit).dimension;
      const previousDimension = unitDefinition(previous.unit).dimension;

      if (lastDimension !== previousDimension) continue;
      if (
        lastDimension !==
        unitDefinition(ingredient.baseUnit).dimension
      ) {
        continue;
      }

      const lastCanonical = toCanonicalCost(last.unitCostGross, last.unit);
      const previousCanonical = toCanonicalCost(
        previous.unitCostGross,
        previous.unit,
      );

      if (previousCanonical.lessThanOrEqualTo(0)) continue;

      const changePercent =
        (Number(lastCanonical) / Number(previousCanonical) - 1) * 100;

      if (Math.abs(changePercent) < 5) continue;

      alerts.push({
        ingredientId: last.ingredientId!,
        ingredientName: ingredient.name,
        supplierId: last.purchase.supplier!.id,
        supplierName: last.purchase.supplier!.name,
        previousCost: round(
          Number(
            toDisplayCost(previousCanonical, ingredient.displayUnit),
          ),
          4,
        ),
        lastCost: round(
          Number(toDisplayCost(lastCanonical, ingredient.displayUnit)),
          4,
        ),
        changePercent: round(changePercent, 1),
        displayUnit: ingredient.displayUnit,
        lastPurchasedAt: last.purchase.purchasedAt.toISOString(),
      });
    }

    alerts.sort(
      (left, right) =>
        Math.abs(right.changePercent) - Math.abs(left.changePercent),
    );

    return { alerts: alerts.slice(0, 50) };
  }

  async comparison(organizationId: string, ingredientId: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: ingredientId, organizationId },
      select: {
        id: true,
        name: true,
        baseUnit: true,
        displayUnit: true,
      },
    });

    if (!ingredient) {
      throw new NotFoundException('Insumo no encontrado');
    }

    const items = await this.prisma.purchaseItem.findMany({
      where: {
        ingredientId,
        purchase: { organizationId, status: PurchaseStatus.APPROVED },
      },
      select: {
        unit: true,
        unitCostGross: true,
        purchase: {
          select: {
            purchasedAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { purchase: { purchasedAt: 'desc' } },
      take: 500,
    });

    const rows = new Map<
      string,
      {
        supplierId: string;
        supplierName: string;
        lastCost: number;
        averageCost: number;
        minCost: number;
        purchases: number;
        lastPurchasedAt: string;
        sum: number;
      }
    >();

    for (const item of items) {
      if (!item.purchase.supplier) continue;
      if (
        unitDefinition(item.unit).dimension !==
        unitDefinition(ingredient.baseUnit).dimension
      ) {
        continue;
      }

      const canonical = toCanonicalCost(item.unitCostGross, item.unit);
      const displayCost = Number(
        toDisplayCost(canonical, ingredient.displayUnit),
      );
      const key = item.purchase.supplier.id;
      const current = rows.get(key);

      if (!current) {
        rows.set(key, {
          supplierId: key,
          supplierName: item.purchase.supplier.name,
          lastCost: displayCost,
          averageCost: displayCost,
          minCost: displayCost,
          purchases: 1,
          lastPurchasedAt: item.purchase.purchasedAt.toISOString(),
          sum: displayCost,
        });
        continue;
      }

      current.purchases += 1;
      current.sum += displayCost;
      current.averageCost = current.sum / current.purchases;
      current.minCost = Math.min(current.minCost, displayCost);
    }

    const sorted = [...rows.values()]
      .map((row) => ({
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        lastCost: round(row.lastCost, 4),
        averageCost: round(row.averageCost, 4),
        minCost: round(row.minCost, 4),
        purchases: row.purchases,
        lastPurchasedAt: row.lastPurchasedAt,
      }))
      .sort((left, right) => left.lastCost - right.lastCost);

    return {
      ingredient: {
        id: ingredient.id,
        name: ingredient.name,
        displayUnit: ingredient.displayUnit,
      },
      rows: sorted,
      best: sorted[0] ?? null,
    };
  }

  async recordFeedback(
    organizationId: string,
    userId: string,
    input: {
      kind: 'FORECAST' | 'SUGGESTION';
      accepted: boolean;
      payload?: unknown;
      adjustments?: unknown;
    },
  ) {
    const event = await this.prisma.aiSuggestionEvent.create({
      data: {
        organizationId,
        kind: input.kind,
        accepted: input.accepted,
        payload: (input.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        adjustments: (input.adjustments ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        createdBy: userId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: 'AI_SUGGESTION_FEEDBACK',
        entity: 'AiSuggestionEvent',
        entityId: event.id,
        newValues: {
          kind: input.kind,
          accepted: input.accepted,
        },
      },
    });

    return event;
  }
}
