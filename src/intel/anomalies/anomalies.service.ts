import { Injectable } from '@nestjs/common';
import {
  AiAnomalyReviewStatus,
  CashMovementType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export type AnomalyType =
  | 'DISCOUNT'
  | 'CANCELLATION'
  | 'CASH'
  | 'WASTE'
  | 'OPEN_TABLE'
  | 'ITEM_QUANTITY';
export type AnomalySeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AnomalyFinding {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  score: number;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  link?: string;
  /** Revisión humana persistida, si existe. */
  reviewStatus?: 'ACKNOWLEDGED' | 'DISMISSED' | null;
}

const DEFAULT_DAYS = 30;

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function severityFor(score: number): AnomalySeverity {
  if (score >= 75) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function userName(user: { name: string | null; username: string | null } | null) {
  return user?.name ?? user?.username ?? 'Sin usuario';
}

@Injectable()
export class AnomaliesService {
  constructor(private readonly prisma: PrismaService) {}

  async findings(
    organizationId: string,
    branchId: string | null,
    options: { from?: string; to?: string; limit?: number } = {},
  ) {
    const now = new Date();
    const from = options.from
      ? new Date(options.from)
      : new Date(now.getTime() - DEFAULT_DAYS * 86400000);
    const to = options.to ? new Date(options.to) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return this.empty();
    }

    to.setHours(23, 59, 59, 999);

    const scope = {
      organizationId,
      ...(branchId ? { branchId } : {}),
    };

    const [orders, sessions, wastes, roundCancellations] = await Promise.all([
      this.prisma.order.findMany({
        where: { ...scope, createdAt: { gte: from, lte: to } },
        select: {
          id: true,
          status: true,
          total: true,
          subtotal: true,
          tableNumber: true,
          createdAt: true,
          userId: true,
          user: { select: { name: true, username: true } },
          rounds: {
            select: {
              items: {
                select: {
                  id: true,
                  itemName: true,
                  quantity: true,
                  discountAmount: true,
                },
              },
            },
          },
          payments: {
            select: {
              id: true,
              method: true,
              amount: true,
              status: true,
              confirmedById: true,
              userId: true,
            },
          },
        },
        take: 5000,
      }),
      this.prisma.cashSession.findMany({
        where: { ...scope, openedAt: { gte: from, lte: to } },
        select: {
          id: true,
          openedAt: true,
          closedAt: true,
          expectedCash: true,
          countedCash: true,
          difference: true,
          openedBy: { select: { name: true, username: true } },
          closedBy: { select: { name: true, username: true } },
          movements: {
            select: {
              type: true,
              amount: true,
              reason: true,
              createdAt: true,
              user: { select: { name: true, username: true } },
            },
          },
        },
      }),
      this.prisma.waste.findMany({
        where: { ...scope, createdAt: { gte: from, lte: to } },
        select: {
          id: true,
          cost: true,
          reason: true,
          createdAt: true,
          ingredientName: true,
          user: { select: { name: true, username: true } },
        },
      }),
      this.prisma.orderStatusHistory.findMany({
        where: {
          newStatus: 'CANCELLED',
          changedAt: { gte: from, lte: to },
          orderRound: { order: scope },
        },
        select: {
          id: true,
          changedAt: true,
          reason: true,
          changedBy: { select: { name: true, username: true } },
        },
        take: 1000,
      }),
    ]);

    const findings: AnomalyFinding[] = [];

    // ---------------------------------------------------------------------
    // Descuentos
    // ---------------------------------------------------------------------
    const discountsByDayUser = new Map<
      string,
      { discount: number; sales: number; count: number }
    >();

    for (const order of orders) {
      const discount = order.rounds.reduce(
        (sum, round) =>
          sum +
          round.items.reduce(
            (lineSum, item) => lineSum + Number(item.discountAmount),
            0,
          ),
        0,
      );

      if (discount <= 0) continue;

      const sales = Number(order.total);
      const base = sales + discount;
      const ratio = base > 0 ? discount / base : 0;

      if (discount >= 50 && ratio >= 0.4) {
        const score = Math.min(100, 55 + ratio * 100);

        findings.push({
          id: `discount-order-${order.id}`,
          type: 'DISCOUNT',
          severity: severityFor(score),
          score: round(score),
          title: `Descuento alto en un pedido (${Math.round(ratio * 100)}%)`,
          detail: `Pedido de ${userName(order.user)} con $${round(discount)} de descuento sobre $${round(base)}.`,
          evidence: {
            orderId: order.id,
            discount: round(discount),
            total: round(sales),
            user: userName(order.user),
            date: order.createdAt.toISOString(),
          },
          link: '/reports',
        });
      }

      const key = `${dayKey(order.createdAt)}|${order.userId ?? 'none'}`;
      const row = discountsByDayUser.get(key) ?? {
        discount: 0,
        sales: 0,
        count: 0,
      };
      row.discount += discount;
      row.sales += sales;
      row.count += 1;
      discountsByDayUser.set(key, row);
    }

    for (const [key, row] of discountsByDayUser) {
      const ratio = row.sales + row.discount > 0
        ? row.discount / (row.sales + row.discount)
        : 0;

      if (row.discount < 100 || ratio < 0.15) continue;

      const [date, userId] = key.split('|');
      const user = orders.find((order) => order.userId === userId)?.user ?? null;
      const score = Math.min(100, 40 + ratio * 120);

      findings.push({
        id: `discount-day-${key}`,
        type: 'DISCOUNT',
        severity: severityFor(score),
        score: round(score),
        title: `Descuentos acumulados de ${Math.round(ratio * 100)}% en el día`,
        detail: `${userName(user)} aplicó $${round(row.discount)} en descuentos sobre $${round(row.sales + row.discount)} de venta el ${date}.`,
        evidence: {
          date,
          user: userName(user),
          discount: round(row.discount),
          sales: round(row.sales + row.discount),
          orders: row.count,
        },
        link: '/reports',
      });
    }

    // ---------------------------------------------------------------------
    // Cancelaciones
    // ---------------------------------------------------------------------
    const ordersByDayUser = new Map<
      string,
      { total: number; cancelled: number; amount: number }
    >();

    for (const order of orders) {
      const key = `${dayKey(order.createdAt)}|${order.userId ?? 'none'}`;
      const row = ordersByDayUser.get(key) ?? {
        total: 0,
        cancelled: 0,
        amount: 0,
      };
      row.total += 1;

      if (order.status === 'CANCELLED') {
        row.cancelled += 1;
        row.amount += Number(order.total);
      }

      ordersByDayUser.set(key, row);
    }

    for (const [key, row] of ordersByDayUser) {
      if (row.total < 5 || row.cancelled === 0) continue;

      const rate = row.cancelled / row.total;

      if (rate < 0.1) continue;

      const [date, userId] = key.split('|');
      const user = orders.find((order) => order.userId === userId)?.user ?? null;
      const score = Math.min(100, 45 + rate * 150);

      findings.push({
        id: `cancel-day-${key}`,
        type: 'CANCELLATION',
        severity: severityFor(score),
        score: round(score),
        title: `${row.cancelled} cancelaciones de ${row.total} pedidos (${Math.round(rate * 100)}%)`,
        detail: `${userName(user)} canceló $${round(row.amount)} en ventas el ${date}.`,
        evidence: {
          date,
          user: userName(user),
          cancelled: row.cancelled,
          orders: row.total,
          amount: round(row.amount),
        },
        link: '/reports',
      });
    }

    const cancellationsByUser = new Map<
      string,
      { count: number; user: { name: string | null; username: string | null } | null }
    >();

    for (const cancellation of roundCancellations) {
      const key = cancellation.changedBy?.username ?? 'none';
      const row = cancellationsByUser.get(key) ?? {
        count: 0,
        user: cancellation.changedBy,
      };
      row.count += 1;
      cancellationsByUser.set(key, row);
    }

    for (const [key, row] of cancellationsByUser) {
      if (row.count < 3) continue;

      const score = Math.min(100, 35 + row.count * 8);

      findings.push({
        id: `cancel-rounds-${key}`,
        type: 'CANCELLATION',
        severity: severityFor(score),
        score: round(score),
        title: `${row.count} rondas canceladas`,
        detail: `${userName(row.user)} canceló ${row.count} rondas enviadas a cocina en el periodo.`,
        evidence: { user: userName(row.user), rounds: row.count },
        link: '/reports',
      });
    }

    // ---------------------------------------------------------------------
    // Caja
    // ---------------------------------------------------------------------
    for (const session of sessions) {
      const difference = session.difference === null ? 0 : Number(session.difference);
      const expected = session.expectedCash === null ? 0 : Number(session.expectedCash);

      if (Math.abs(difference) >= 50) {
        const ratio = expected > 0 ? Math.abs(difference) / expected : 1;
        const score = Math.min(100, 50 + Math.abs(difference) / 10 + ratio * 50);

        findings.push({
          id: `cash-difference-${session.id}`,
          type: 'CASH',
          severity: severityFor(score),
          score: round(score),
          title: `Diferencia de caja de $${round(Math.abs(difference))}`,
          detail: `Turno abierto por ${userName(session.openedBy)} y cerrado por ${userName(session.closedBy)}: contado $${round(Number(session.countedCash ?? 0))} contra esperado $${round(expected)}.`,
          evidence: {
            sessionId: session.id,
            openedAt: session.openedAt.toISOString(),
            closedAt: session.closedAt?.toISOString() ?? null,
            difference: round(difference),
            expected: round(expected),
          },
          link: '/reports',
        });
      }

      const withdrawals = session.movements
        .filter((movement) => movement.type === CashMovementType.WITHDRAWAL)
        .reduce((sum, movement) => sum + Number(movement.amount), 0);

      if (withdrawals >= 1000) {
        const score = Math.min(100, 45 + withdrawals / 100);

        findings.push({
          id: `cash-withdrawals-${session.id}`,
          type: 'CASH',
          severity: severityFor(score),
          score: round(score),
          title: `Retiros de efectivo por $${round(withdrawals)} en un turno`,
          detail: `El turno acumuló ${session.movements.filter((movement) => movement.type === CashMovementType.WITHDRAWAL).length} retiros. Revisa los motivos y comprobantes.`,
          evidence: {
            sessionId: session.id,
            withdrawals: round(withdrawals),
            movements: session.movements
              .filter((movement) => movement.type === CashMovementType.WITHDRAWAL)
              .slice(0, 5)
              .map((movement) => ({
                amount: round(Number(movement.amount)),
                reason: movement.reason,
                user: userName(movement.user),
              })),
          },
          link: '/reports',
        });
      }
    }

    const cancelledCash = orders.flatMap((order) =>
      order.payments
        .filter(
          (payment) =>
            payment.method === PaymentMethod.CASH &&
            (payment.status === PaymentStatus.CANCELLED ||
              payment.status === PaymentStatus.REFUNDED),
        )
        .map((payment) => ({ order, payment })),
    );

    if (cancelledCash.length > 0) {
      const amount = cancelledCash.reduce(
        (sum, row) => sum + Number(row.payment.amount),
        0,
      );
      const score = Math.min(100, 40 + cancelledCash.length * 5 + amount / 50);

      findings.push({
        id: 'cash-cancelled-payments',
        type: 'CASH',
        severity: severityFor(score),
        score: round(score),
        title: `${cancelledCash.length} pagos en efectivo cancelados o reembolsados`,
        detail: `Suman $${round(amount)}. Revisa si el efectivo regresó a la caja y quién autorizó.`,
        evidence: {
          payments: cancelledCash.slice(0, 8).map((row) => ({
            paymentId: row.payment.id,
            orderId: row.order.id,
            amount: round(Number(row.payment.amount)),
            status: row.payment.status,
            user: userName(row.order.user),
          })),
        },
        link: '/reports',
      });
    }

    const selfConfirmed = new Map<
      string,
      { count: number; amount: number; user: { name: string | null; username: string | null } | null }
    >();

    for (const order of orders) {
      for (const payment of order.payments) {
        if (
          !payment.confirmedById ||
          !order.userId ||
          payment.confirmedById !== order.userId
        ) {
          continue;
        }

        const row = selfConfirmed.get(order.userId) ?? {
          count: 0,
          amount: 0,
          user: order.user,
        };
        row.count += 1;
        row.amount += Number(payment.amount);
        selfConfirmed.set(order.userId, row);
      }
    }

    for (const [userId, row] of selfConfirmed) {
      if (row.count < 3 && row.amount < 500) continue;

      const score = Math.min(100, 35 + row.count * 4 + row.amount / 100);

      findings.push({
        id: `cash-self-confirmed-${userId}`,
        type: 'CASH',
        severity: severityFor(score),
        score: round(score),
        title: `${row.count} pagos confirmados por quien abrió el pedido`,
        detail: `${userName(row.user)} confirmó $${round(row.amount)} en pagos de sus propios pedidos. Lo sano es que otra persona los confirme.`,
        evidence: {
          user: userName(row.user),
          payments: row.count,
          amount: round(row.amount),
        },
        link: '/reports',
      });
    }

    // ---------------------------------------------------------------------
    // Mermas
    // ---------------------------------------------------------------------
    const wasteByDay = new Map<string, number>();
    const wasteByUser = new Map<
      string,
      { amount: number; count: number; user: { name: string | null; username: string | null } | null }
    >();

    for (const waste of wastes) {
      const key = dayKey(waste.createdAt);
      wasteByDay.set(key, (wasteByDay.get(key) ?? 0) + Number(waste.cost));

      const userKey = waste.user?.username ?? 'none';
      const row = wasteByUser.get(userKey) ?? {
        amount: 0,
        count: 0,
        user: waste.user,
      };
      row.amount += Number(waste.cost);
      row.count += 1;
      wasteByUser.set(userKey, row);
    }

    const dailyWaste = [...wasteByDay.values()];
    const averageWaste = mean(dailyWaste);
    const deviation = stdDev(dailyWaste);

    if (dailyWaste.length >= 5 && deviation > 0) {
      for (const [date, amount] of wasteByDay) {
        if (amount < 100 || amount <= averageWaste + 2 * deviation) continue;

        const score = Math.min(
          100,
          50 + ((amount - averageWaste) / Math.max(deviation, 1)) * 10,
        );

        findings.push({
          id: `waste-day-${date}`,
          type: 'WASTE',
          severity: severityFor(score),
          score: round(score),
          title: `Merma atípica de $${round(amount)} el ${date}`,
          detail: `El promedio diario es $${round(averageWaste)}. Revisa las fotos y motivos de ese día.`,
          evidence: {
            date,
            amount: round(amount),
            average: round(averageWaste),
            deviation: round(deviation),
          },
          link: '/waste',
        });
      }
    }

    const totalWaste = wastes.reduce((sum, waste) => sum + Number(waste.cost), 0);

    for (const [key, row] of wasteByUser) {
      if (totalWaste < 200 || row.amount < 100) continue;

      const share = row.amount / totalWaste;

      if (share < 0.5) continue;

      const score = Math.min(100, 40 + share * 60);

      findings.push({
        id: `waste-user-${key}`,
        type: 'WASTE',
        severity: severityFor(score),
        score: round(score),
        title: `${Math.round(share * 100)}% de la merma la registró una persona`,
        detail: `${userName(row.user)} registró $${round(row.amount)} en ${row.count} mermas. Verifica que sean reales y no ajustes de inventario.`,
        evidence: {
          user: userName(row.user),
          amount: round(row.amount),
          records: row.count,
          total: round(totalWaste),
        },
        link: '/waste',
      });
    }

    const suspiciousWaste = wastes.filter(
      (waste) => waste.reason === 'OTHER' && Number(waste.cost) >= 200,
    );

    if (suspiciousWaste.length > 0) {
      findings.push({
        id: 'waste-other-high',
        type: 'WASTE',
        severity: 'MEDIUM',
        score: 55,
        title: `${suspiciousWaste.length} mermas "Otro" de alto costo`,
        detail: `Hay mermas clasificadas como "Otro" por $${round(
          suspiciousWaste.reduce((sum, waste) => sum + Number(waste.cost), 0),
        )}. Sin un motivo claro no se puede distinguir desperdicio de fuga.`,
        evidence: {
          records: suspiciousWaste.slice(0, 8).map((waste) => ({
            ingredient: waste.ingredientName,
            cost: round(Number(waste.cost)),
            date: waste.createdAt.toISOString(),
            user: userName(waste.user),
          })),
        },
        link: '/waste',
      });
    }

    // ---------------------------------------------------------------------
    // Mesas abiertas demasiado tiempo
    // ---------------------------------------------------------------------
    const OPEN_TABLE_HOURS = 4;

    for (const order of orders) {
      if (order.status !== OrderStatus.OPEN) continue;

      const ageHours = (now.getTime() - order.createdAt.getTime()) / 3600000;

      if (ageHours < OPEN_TABLE_HOURS) continue;

      const score = Math.min(100, 45 + (ageHours - OPEN_TABLE_HOURS) * 2);

      findings.push({
        id: `open-table-${order.id}`,
        type: 'OPEN_TABLE',
        severity: severityFor(score),
        score: round(score),
        title: `Cuenta abierta hace ${round(ageHours, 1)} h`,
        detail: `La cuenta${
          order.tableNumber ? ` de la mesa ${order.tableNumber}` : ''
        } de ${userName(order.user)} sigue abierta con $${round(
          Number(order.total),
        )}.`,
        evidence: {
          orderId: order.id,
          tableNumber: order.tableNumber,
          openedAt: order.createdAt.toISOString(),
          ageHours: round(ageHours, 1),
          total: round(Number(order.total)),
          user: userName(order.user),
        },
        link: '/reports',
      });
    }

    // ---------------------------------------------------------------------
    // Cantidades inusuales por artículo
    // ---------------------------------------------------------------------
    const linesByItem = new Map<
      string,
      Array<{
        quantity: number;
        orderId: string;
        user: { name: string | null; username: string | null } | null;
        date: Date;
      }>
    >();

    for (const order of orders) {
      for (const round of order.rounds) {
        for (const item of round.items) {
          const list = linesByItem.get(item.itemName) ?? [];
          list.push({
            quantity: item.quantity,
            orderId: order.id,
            user: order.user,
            date: order.createdAt,
          });
          linesByItem.set(item.itemName, list);
        }
      }
    }

    let anomalyLine = 0;

    for (const [itemName, lines] of linesByItem) {
      if (lines.length < 5) continue;

      const quantities = lines.map((line) => line.quantity);
      const average = mean(quantities);
      const deviation = stdDev(quantities);
      const threshold = Math.max(10, average + 3 * deviation);

      for (const line of lines) {
        if (line.quantity < threshold) continue;

        const z = deviation > 0 ? (line.quantity - average) / deviation : 0;
        const score = Math.min(
          100,
          50 + (line.quantity - threshold) * 5 + z * 5,
        );

        anomalyLine += 1;
        findings.push({
          id: `item-quantity-${line.orderId}-${anomalyLine}`,
          type: 'ITEM_QUANTITY',
          severity: severityFor(score),
          score: round(score),
          title: `${line.quantity} × ${itemName} en un pedido`,
          detail: `El promedio es ${round(average, 1)} unidades por línea (desviación ${round(
            deviation,
            1,
          )}). Revisa si la cantidad es real o si se capturó de más.`,
          evidence: {
            orderId: line.orderId,
            item: itemName,
            quantity: line.quantity,
            average: round(average, 1),
            deviation: round(deviation, 1),
            user: userName(line.user),
            date: line.date.toISOString(),
          },
          link: '/reports',
        });
      }
    }

    findings.sort((left, right) => right.score - left.score);

    const limited = findings.slice(0, options.limit ?? 30);

    const reviews =
      limited.length > 0
        ? await this.prisma.aiAnomalyReview.findMany({
            where: {
              organizationId,
              findingKey: { in: limited.map((finding) => finding.id) },
            },
            select: { findingKey: true, status: true },
          })
        : [];

    const reviewMap = new Map(
      reviews.map((review) => [review.findingKey, review.status]),
    );

    for (const finding of limited) {
      finding.reviewStatus = reviewMap.get(finding.id) ?? null;
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      summary: {
        total: findings.length,
        high: findings.filter((finding) => finding.severity === 'HIGH').length,
        medium: findings.filter((finding) => finding.severity === 'MEDIUM')
          .length,
        low: findings.filter((finding) => finding.severity === 'LOW').length,
        discounts: round(
          [...discountsByDayUser.values()].reduce(
            (sum, row) => sum + row.discount,
            0,
          ),
        ),
        cancelledOrders: orders.filter(
          (order) => order.status === OrderStatus.CANCELLED,
        ).length,
        cashDifference: round(
          sessions.reduce(
            (sum, session) =>
              sum + Math.abs(Number(session.difference ?? 0)),
            0,
          ),
        ),
        waste: round(totalWaste),
      },
      findings: limited,
    };
  }

  async review(
    organizationId: string,
    userId: string,
    findingKey: string,
    status: AiAnomalyReviewStatus,
    note?: string,
  ) {
    const review = await this.prisma.aiAnomalyReview.upsert({
      where: {
        organizationId_findingKey: { organizationId, findingKey },
      },
      create: {
        organizationId,
        findingKey,
        status,
        userId,
        note: note?.trim() || null,
      },
      update: {
        status,
        userId,
        note: note?.trim() || null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: 'AI_ANOMALY_REVIEWED',
        entity: 'AiAnomalyReview',
        entityId: review.id,
        newValues: { findingKey, status },
      },
    });

    return review;
  }

  private empty() {
    return {
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      summary: {
        total: 0,
        high: 0,
        medium: 0,
        low: 0,
        discounts: 0,
        cancelledOrders: 0,
        cashDifference: 0,
        waste: 0,
      },
      findings: [] as AnomalyFinding[],
    };
  }
}
