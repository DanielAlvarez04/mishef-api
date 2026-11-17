import { Injectable } from '@nestjs/common';
import {
  InventoryMovementType,
  OrderRoundStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UnitCode,
  type Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromCanonicalQuantity } from '../common/units';
import { rolesHavePermission } from '../common/permissions';
import { computeFoodCost } from '../common/food-cost';
import {
  LOCAL_BENCHMARK_RADIUS_KM,
  MIN_COHORT,
  buildBenchmarkMetric,
  distanceKm,
} from '../common/benchmark';

const ACTIVE_ROUNDS = [
  OrderRoundStatus.PENDING,
  OrderRoundStatus.PREPARING,
  OrderRoundStatus.READY,
];

/** Minutos tras los que una comanda pendiente se considera demorada. */
const DELAY_MINUTES = 15;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Datos del panel principal.
   *
   * - Los importes solo se devuelven a quien tiene `reports:read`
   *   (ADMIN/CASHIER). El resto ve métricas operativas con `money: false`.
   * - Todo se agrega en el servidor y filtrado por `organizationId`
   *   (`plan.md` §6.10); el frontend no calcula cifras de negocio.
   */
  async overview(
    organizationId: string | null,
    roles: Role[],
    days = 7,
    branchId: string | null = null,
  ) {
    const money = rolesHavePermission(roles, 'reports:read');
    // Con sucursal activa todo se limita a ese local; sin ella se muestra el
    // consolidado de la organización.
    const scope = branchId ? { branchId } : {};
    const range = Math.min(Math.max(days, 1), 90);
    const now = new Date();
    const todayStart = startOfDay(now);
    const since = addDays(todayStart, -(range - 1));

    const [
      todayPayments,
      periodPayments,
      ordersToday,
      openOrders,
      activeRounds,
      ingredients,
      recentOrders,
      topItems,
      itemsToday,
      preparedRounds,
    ] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          organizationId,
          ...scope,
          status: PaymentStatus.CONFIRMED,
          confirmedAt: { gte: todayStart },
        },
        select: { orderId: true, amount: true, method: true },
      }),
      this.prisma.payment.findMany({
        where: {
          organizationId,
          ...scope,
          status: PaymentStatus.CONFIRMED,
          confirmedAt: { gte: since },
        },
        select: { amount: true, method: true, confirmedAt: true },
      }),
      this.prisma.order.count({
        where: {
          organizationId,
          ...scope,
          createdAt: { gte: todayStart },
          status: { not: OrderStatus.CANCELLED },
        },
      }),
      this.prisma.order.findMany({
        where: { organizationId, ...scope, status: OrderStatus.OPEN },
        select: { total: true },
      }),
      this.prisma.orderRound.findMany({
        where: {
          order: { organizationId, ...scope, status: OrderStatus.OPEN },
          status: { in: ACTIVE_ROUNDS },
        },
        select: { status: true, sentAt: true },
      }),
      this.prisma.ingredient.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          name: true,
          baseUnit: true,
          displayUnit: true,
          currentStock: true,
          minStock: true,
          ...(branchId
            ? { branchStocks: { where: { branchId }, select: { quantity: true } } }
            : {}),
        },
      }),
      this.prisma.order.findMany({
        where: { organizationId, ...scope },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          tableNumber: true,
          isTakeaway: true,
          status: true,
          total: true,
          createdAt: true,
          branch: { select: { id: true, name: true } },
          user: { select: { name: true, username: true } },
          _count: { select: { rounds: true } },
        },
      }),
      this.prisma.orderItem.groupBy({
        by: ['itemName'],
        where: {
          orderRound: {
            status: { not: OrderRoundStatus.CANCELLED },
            order: { organizationId, ...scope, createdAt: { gte: since } },
          },
        },
        _sum: { quantity: true, subtotal: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
      this.prisma.orderItem.aggregate({
        where: {
          orderRound: {
            status: { not: OrderRoundStatus.CANCELLED },
            order: { organizationId, ...scope, createdAt: { gte: todayStart } },
          },
        },
        _sum: { quantity: true, taxAmount: true },
      }),
      this.prisma.orderRound.findMany({
        where: {
          order: { organizationId, ...scope, createdAt: { gte: since } },
          startedAt: { not: null },
          readyAt: { not: null },
        },
        select: { startedAt: true, readyAt: true },
      }),
    ]);

    const todaySales = sumDecimals(todayPayments.map((row) => row.amount));
    const paidOrdersToday = new Set(todayPayments.map((row) => row.orderId)).size;
    const periodSales = sumDecimals(periodPayments.map((row) => row.amount));
    const openTotal = sumDecimals(openOrders.map((row) => row.total));

    const byMethod = new Map<PaymentMethod, { total: number; count: number }>();
    for (const payment of periodPayments) {
      const entry = byMethod.get(payment.method) ?? { total: 0, count: 0 };
      entry.total += Number(payment.amount);
      entry.count += 1;
      byMethod.set(payment.method, entry);
    }

    const series = new Map<string, { sales: number; payments: number }>();
    for (let index = 0; index < range; index += 1) {
      series.set(dayKey(addDays(since, index)), { sales: 0, payments: 0 });
    }
    for (const payment of periodPayments) {
      if (!payment.confirmedAt) continue;
      const key = dayKey(payment.confirmedAt);
      const entry = series.get(key);
      if (!entry) continue;
      entry.sales += Number(payment.amount);
      entry.payments += 1;
    }

    const lowStock = ingredients
      .map((ingredient) => {
        const branchStock = branchId
          ? (ingredient as { branchStocks?: Array<{ quantity: Prisma.Decimal }> })
              .branchStocks?.[0]?.quantity
          : undefined;
        const stock = branchId
          ? (branchStock ?? new Prisma.Decimal(0))
          : ingredient.currentStock;

        if (!stock.lte(ingredient.minStock)) return null;

        return {
          id: ingredient.id,
          name: ingredient.name,
          baseUnit: ingredient.baseUnit,
          displayUnit: ingredient.displayUnit,
          currentStock: Number(
            fromCanonicalQuantity(stock, ingredient.displayUnit),
          ),
          minStock: Number(
            fromCanonicalQuantity(ingredient.minStock, ingredient.displayUnit),
          ),
          deficit: Number(
            fromCanonicalQuantity(
              ingredient.minStock.minus(stock),
              ingredient.displayUnit,
            ).toFixed(4),
          ),
        };
      })
      .filter((ingredient) => ingredient !== null)
      .sort((a, b) => b.deficit - a.deficit);

    const prepMinutes = preparedRounds
      .map((round) =>
        round.startedAt && round.readyAt
          ? (round.readyAt.getTime() - round.startedAt.getTime()) / 60000
          : null,
      )
      .filter((value): value is number => value !== null && value >= 0);

    const delayedBefore = new Date(now.getTime() - DELAY_MINUTES * 60000);

    return {
      generatedAt: now.toISOString(),
      days: range,
      money,
      today: {
        sales: money ? round(todaySales) : null,
        payments: todayPayments.length,
        orders: paidOrdersToday || ordersToday,
        averageTicket:
          money && paidOrdersToday > 0 ? round(todaySales / paidOrdersToday) : null,
        itemsSold: itemsToday._sum.quantity ?? 0,
        taxTotal: money ? round(Number(itemsToday._sum.taxAmount ?? 0)) : null,
      },
      period: {
        sales: money ? round(periodSales) : null,
        payments: periodPayments.length,
        averageTicket:
          money && periodPayments.length > 0
            ? round(periodSales / periodPayments.length)
            : null,
      },
      paymentsByMethod: [...byMethod].map(([method, value]) => ({
        method,
        total: money ? round(value.total) : null,
        count: value.count,
      })),
      salesSeries: [...series].map(([date, value]) => ({
        date,
        sales: money ? round(value.sales) : null,
        payments: value.payments,
      })),
      topItems: topItems.map((row) => ({
        name: row.itemName,
        quantity: row._sum.quantity ?? 0,
        revenue: money ? round(Number(row._sum.subtotal ?? 0)) : null,
      })),
      inventory: {
        lowStockCount: lowStock.length,
        alerts: lowStock.slice(0, 5),
      },
      kitchen: {
        pending: activeRounds.filter(
          (round) => round.status === OrderRoundStatus.PENDING,
        ).length,
        preparing: activeRounds.filter(
          (round) => round.status === OrderRoundStatus.PREPARING,
        ).length,
        ready: activeRounds.filter(
          (round) => round.status === OrderRoundStatus.READY,
        ).length,
        delayed: activeRounds.filter(
          (round) =>
            round.status === OrderRoundStatus.PENDING &&
            round.sentAt !== null &&
            round.sentAt < delayedBefore,
        ).length,
        averagePrepMinutes:
          prepMinutes.length > 0
            ? Math.round(
                prepMinutes.reduce((sum, value) => sum + value, 0) /
                  prepMinutes.length,
              )
            : null,
      },
      openOrders: {
        count: openOrders.length,
        total: money ? round(openTotal) : null,
      },
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        tableNumber: order.tableNumber,
        isTakeaway: order.isTakeaway,
        status: order.status,
        total: money ? Number(order.total) : null,
        createdAt: order.createdAt.toISOString(),
        rounds: order._count.rounds,
        user: order.user?.name ?? order.user?.username ?? null,
        branch: order.branch?.name ?? null,
      })),
    };
  }

  /** Reporte de ventas: totales, métodos de pago, serie diaria y productos. */
  /**
   * Señales de fuga interna del periodo.
   *
   * Cruza pedidos (cancelados y cerrados), pagos y `AuditLog` para responder
   * tres preguntas que un dueño hace todas las semanas:
   *
   *  1. ¿Quién cancela cuentas más que el resto del equipo?
   *  2. ¿Hay cuentas cerradas sin el pago completo?
   *  3. ¿Hay cuentas cuyo total no coincide con sus conceptos (descuento no
   *     registrado)?
   *
   * No acusa a nadie: señala patrones con su evidencia para que el dueño
   * revise. El umbral es conservador para no llenar la pantalla de ruido.
   */
  async leakageReport(
    organizationId: string | null,
    days = 30,
    branchId: string | null = null,
  ) {
    const periodDays = Math.min(365, Math.max(1, Math.trunc(days)));
    const from = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const to = new Date();

    if (!organizationId) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        days: periodDays,
        summary: null,
        users: [],
        ordersWithoutPayment: [],
        discounts: [],
      };
    }

    const branchFilter = branchId ? { branchId } : {};

    const [orders, audit] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          organizationId,
          ...branchFilter,
          createdAt: { gte: from, lte: to },
          status: { in: [OrderStatus.CLOSED, OrderStatus.CANCELLED] },
        },
        select: {
          id: true,
          userId: true,
          status: true,
          total: true,
          subtotal: true,
          taxTotal: true,
          ticketNumber: true,
          tableNumber: true,
          createdAt: true,
          updatedAt: true,
          payments: {
            select: { amount: true, tipAmount: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        where: {
          organizationId,
          createdAt: { gte: from, lte: to },
          action: {
            in: ['order.cancelled', 'payment.cancelled', 'payment.refunded'],
          },
        },
        select: { action: true, userId: true },
      }),
    ]);

    const round2 = (value: number) =>
      Math.round((value + Number.EPSILON) * 100) / 100;

    const users = new Map<
      string,
      {
        userId: string;
        cancellations: number;
        refunds: number;
        ordersClosed: number;
        ordersWithoutPayment: number;
        sales: number;
        riskScore: number;
      }
    >();

    const userEntry = (userId: string) => {
      const current = users.get(userId) ?? {
        userId,
        cancellations: 0,
        refunds: 0,
        ordersClosed: 0,
        ordersWithoutPayment: 0,
        sales: 0,
        riskScore: 0,
      };
      users.set(userId, current);
      return current;
    };

    const ordersWithoutPayment: Array<{
      id: string;
      userId: string | null;
      ticketNumber: number | null;
      tableNumber: string | null;
      total: number;
      paid: number;
      missing: number;
      createdAt: string;
    }> = [];

    const discounts: Array<{
      id: string;
      userId: string | null;
      ticketNumber: number | null;
      expected: number;
      total: number;
      difference: number;
      createdAt: string;
    }> = [];

    for (const order of orders) {
      const paid = order.payments
        .filter((payment) => payment.status === PaymentStatus.CONFIRMED)
        .reduce(
          (sum, payment) =>
            sum + Number(payment.amount) + Number(payment.tipAmount),
          0,
        );

      if (order.userId) {
        const entry = userEntry(order.userId);

        if (order.status === OrderStatus.CANCELLED) {
          entry.cancellations += 1;
        } else {
          entry.ordersClosed += 1;
          entry.sales += Number(order.total);
        }
      }

      if (order.status !== OrderStatus.CLOSED) continue;

      const total = Number(order.total);
      const expected = Number(order.subtotal) + Number(order.taxTotal);
      const missing = round2(total - paid);

      // Cuenta cerrada sin el pago completo (o pagada de más).
      if (Math.abs(missing) > 0.01) {
        ordersWithoutPayment.push({
          id: order.id,
          userId: order.userId,
          ticketNumber: order.ticketNumber,
          tableNumber: order.tableNumber,
          total: round2(total),
          paid: round2(paid),
          missing,
          createdAt: order.createdAt.toISOString(),
        });

        if (order.userId && missing > 0) {
          userEntry(order.userId).ordersWithoutPayment += 1;
        }
      }

      // El total no coincide con los conceptos: descuento o ajuste manual que
      // no quedó registrado en la cuenta.
      const unexplained = round2(expected - total);

      if (unexplained > 0.01) {
        discounts.push({
          id: order.id,
          userId: order.userId,
          ticketNumber: order.ticketNumber,
          expected: round2(expected),
          total: round2(total),
          difference: unexplained,
          createdAt: order.createdAt.toISOString(),
        });
      }
    }

    for (const log of audit) {
      if (!log.userId) continue;
      const entry = userEntry(log.userId);
      if (log.action === 'order.cancelled') entry.cancellations += 1;
      else entry.refunds += 1;
    }

    // Puntaje simple y explicable: una cancelación pesa 2, un reembolso 3 y una
    // cuenta sin pago 3. Con 4 o más se muestra en la lista de revisión.
    for (const entry of users.values()) {
      entry.riskScore =
        entry.cancellations * 2 +
        entry.refunds * 3 +
        entry.ordersWithoutPayment * 3;
    }

    const userIds = [...users.keys()];

    const people = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, username: true, email: true },
        })
      : [];

    const names = new Map(people.map((person) => [person.id, person]));

    const flagged = [...users.values()]
      .filter((entry) => entry.riskScore >= 4)
      .sort((a, b) => b.riskScore - a.riskScore)
      .map((entry) => ({
        ...entry,
        name: names.get(entry.userId)?.name ?? null,
        username: names.get(entry.userId)?.username ?? null,
        email: names.get(entry.userId)?.email ?? null,
        sales: round2(entry.sales),
      }));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      days: periodDays,
      summary: {
        orders: orders.length,
        cancelledOrders: orders.filter(
          (order) => order.status === OrderStatus.CANCELLED,
        ).length,
        cancellations: audit.filter(
          (log) => log.action === 'order.cancelled',
        ).length,
        refunds: audit.filter((log) => log.action !== 'order.cancelled')
          .length,
        ordersWithoutPayment: ordersWithoutPayment.length,
        missingAmount: round2(
          ordersWithoutPayment
            .filter((order) => order.missing > 0)
            .reduce((sum, order) => sum + order.missing, 0),
        ),
        discounts: discounts.length,
        discountAmount: round2(
          discounts.reduce((sum, order) => sum + order.difference, 0),
        ),
        usersFlagged: flagged.length,
      },
      users: flagged,
      ordersWithoutPayment: ordersWithoutPayment.slice(0, 50),
      discounts: discounts.slice(0, 50),
    };
  }

  /**
   * Benchmark anónimo contra negocios similares.
   *
   * Compara tres métricas del negocio con los percentiles del grupo. Nunca
   * devuelve datos de otra organización: solo agregados y siempre con un
   * mínimo de negocios para que no se pueda deducir a quién pertenece un valor.
   */
  async benchmark(organizationId: string | null, days = 30) {
    const periodDays = Math.min(365, Math.max(1, Math.trunc(days)));
    const from = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    const to = new Date();

    if (!organizationId) {
      return {
        available: false,
        reason: 'no_organization' as const,
        period: { from: from.toISOString(), to: to.toISOString(), days: periodDays },
        cohort: null,
        metrics: [],
      };
    }

    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        businessType: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!current) {
      return {
        available: false,
        reason: 'no_organization' as const,
        period: { from: from.toISOString(), to: to.toISOString(), days: periodDays },
        cohort: null,
        metrics: [],
      };
    }

    const baseWhere = {
      isActive: true,
      ...(current.businessType
        ? { businessType: current.businessType }
        : {}),
    };

    const myLocation =
      current.latitude !== null && current.longitude !== null
        ? {
            latitude: Number(current.latitude),
            longitude: Number(current.longitude),
          }
        : null;

    let scope: 'local' | 'national' = 'national';
    let radiusKm: number | null = null;
    let organizations: { id: string }[] = [];
    let rows: Awaited<ReturnType<DashboardService['organizationBenchmark']>>[] = [];
    let localCandidates = 0;

    // Primero se intenta la cohorte de la zona. Si no hay suficientes negocios
    // cercanos con ventas, se cae al grupo nacional del mismo giro.
    if (myLocation) {
      const latDelta = LOCAL_BENCHMARK_RADIUS_KM / 110.574;
      const lngDelta =
        LOCAL_BENCHMARK_RADIUS_KM /
        (111.32 * Math.max(0.2, Math.cos((myLocation.latitude * Math.PI) / 180)));

      const nearby = await this.prisma.organization.findMany({
        where: {
          ...baseWhere,
          latitude: {
            not: null,
            gte: myLocation.latitude - latDelta,
            lte: myLocation.latitude + latDelta,
          },
          longitude: {
            not: null,
            gte: myLocation.longitude - lngDelta,
            lte: myLocation.longitude + lngDelta,
          },
        },
        select: { id: true, latitude: true, longitude: true },
        take: 500,
      });

      const withinRadius = nearby.filter(
        (organization) =>
          organization.latitude !== null &&
          organization.longitude !== null &&
          distanceKm(myLocation, {
            latitude: Number(organization.latitude),
            longitude: Number(organization.longitude),
          }) <= LOCAL_BENCHMARK_RADIUS_KM,
      );

      localCandidates = withinRadius.length;

      if (withinRadius.length >= MIN_COHORT) {
        const localRows = await Promise.all(
          withinRadius.map((organization) =>
            this.organizationBenchmark(organization.id, from, to, periodDays),
          ),
        );

        if (localRows.filter((row) => row.orders > 0).length >= MIN_COHORT) {
          scope = 'local';
          radiusKm = LOCAL_BENCHMARK_RADIUS_KM;
          organizations = withinRadius;
          rows = localRows;
        }
      }
    }

    if (rows.length === 0) {
      organizations = await this.prisma.organization.findMany({
        where: baseWhere,
        select: { id: true },
        take: 200,
      });

      rows = await Promise.all(
        organizations.map((organization) =>
          this.organizationBenchmark(organization.id, from, to, periodDays),
        ),
      );
    }

    const valid = rows.filter((row) => row.orders > 0);
    const mine = valid.find((row) => row.organizationId === organizationId);

    const foodCosts = valid
      .map((row) => row.foodCostPct)
      .filter((value): value is number => value !== null);

    const cohort = {
      businessType: current.businessType,
      organizations: valid.length,
      minimum: MIN_COHORT,
      scope,
      radiusKm,
      localCandidates,
      myLocation,
    };

    if (valid.length < MIN_COHORT) {
      return {
        available: false,
        reason: 'insufficient_cohort' as const,
        period: { from: from.toISOString(), to: to.toISOString(), days: periodDays },
        cohort,
        metrics: [],
      };
    }

    const metrics = [
      buildBenchmarkMetric({
        key: 'averageTicket',
        label: 'Ticket promedio',
        betterWhen: 'higher',
        mine: mine?.averageTicket ?? null,
        cohort: valid.map((row) => row.averageTicket),
      }),
      buildBenchmarkMetric({
        key: 'foodCostPct',
        label: 'Food cost',
        betterWhen: 'lower',
        mine: mine?.foodCostPct ?? null,
        cohort: foodCosts,
      }),
      buildBenchmarkMetric({
        key: 'rotation',
        label: 'Rotación (cuentas por día)',
        betterWhen: 'higher',
        mine: mine?.rotation ?? null,
        cohort: valid.map((row) => row.rotation),
      }),
    ].filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));

    return {
      available: true,
      reason: null,
      period: { from: from.toISOString(), to: to.toISOString(), days: periodDays },
      cohort,
      metrics,
    };
  }

  private async organizationBenchmark(
    organizationId: string,
    from: Date,
    to: Date,
    periodDays: number,
  ) {
    const [payments, orders, items] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          organizationId,
          status: PaymentStatus.CONFIRMED,
          confirmedAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
      }),
      this.prisma.order.count({
        where: {
          organizationId,
          status: OrderStatus.CLOSED,
          createdAt: { gte: from, lte: to },
        },
      }),
      this.prisma.item.findMany({
        where: { organizationId, isActive: true, isArchived: false },
        select: {
          id: true,
          name: true,
          price: true,
          taxRate: true,
          isCombo: true,
          recipes: {
            select: {
              variantId: true,
              ingredients: {
                select: {
                  quantity: true,
                  isOptional: true,
                  ingredient: { select: { name: true, unitCost: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const revenue = Number(payments._sum.amount ?? 0);
    const { summary } = computeFoodCost(items, 0.35);

    return {
      organizationId,
      orders,
      averageTicket: orders > 0 ? revenue / orders : 0,
      foodCostPct: summary.averageFoodCostPct,
      rotation: orders / periodDays,
    };
  }

  async salesReport(
    organizationId: string | null,
    from: Date,
    to: Date,
    branchId: string | null = null,
  ) {
    const scope = branchId ? { branchId } : {};

    const [payments, topItems, orders] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          organizationId,
          ...scope,
          status: PaymentStatus.CONFIRMED,
          confirmedAt: { gte: from, lte: to },
        },
        select: {
          amount: true,
          method: true,
          confirmedAt: true,
          user: { select: { name: true, username: true } },
        },
      }),
      this.prisma.orderItem.groupBy({
        by: ['itemName'],
        where: {
          orderRound: {
            status: { not: OrderRoundStatus.CANCELLED },
            order: { organizationId, ...scope, createdAt: { gte: from, lte: to } },
          },
        },
        _sum: { quantity: true, subtotal: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 10,
      }),
      this.prisma.order.count({
        where: {
          organizationId,
          ...scope,
          createdAt: { gte: from, lte: to },
          status: { not: OrderStatus.CANCELLED },
        },
      }),
    ]);

    const total = sumDecimals(payments.map((payment) => payment.amount));

    const byMethod = new Map<PaymentMethod, { total: number; count: number }>();
    const byDay = new Map<string, { sales: number; count: number }>();
    const byCashier = new Map<string, { total: number; count: number }>();

    for (const payment of payments) {
      const method = byMethod.get(payment.method) ?? { total: 0, count: 0 };
      method.total += Number(payment.amount);
      method.count += 1;
      byMethod.set(payment.method, method);

      if (payment.confirmedAt) {
        const key = dayKey(payment.confirmedAt);
        const day = byDay.get(key) ?? { sales: 0, count: 0 };
        day.sales += Number(payment.amount);
        day.count += 1;
        byDay.set(key, day);
      }

      const cashier =
        payment.user?.name ?? payment.user?.username ?? 'Sin usuario';
      const entry = byCashier.get(cashier) ?? { total: 0, count: 0 };
      entry.total += Number(payment.amount);
      entry.count += 1;
      byCashier.set(cashier, entry);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        sales: round(total),
        payments: payments.length,
        orders,
        averageTicket:
          payments.length > 0 ? round(total / payments.length) : 0,
      },
      byMethod: [...byMethod].map(([method, value]) => ({
        method,
        total: round(value.total),
        count: value.count,
      })),
      byDay: [...byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({
          date,
          sales: round(value.sales),
          count: value.count,
        })),
      byCashier: [...byCashier]
        .map(([name, value]) => ({
          name,
          total: round(value.total),
          count: value.count,
        }))
        .sort((a, b) => b.total - a.total),
      topItems: topItems.map((row) => ({
        name: row.itemName,
        quantity: row._sum.quantity ?? 0,
        revenue: round(Number(row._sum.subtotal ?? 0)),
      })),
    };
  }

  /** Reporte de inventario: movimientos por tipo, consumo y alertas. */
  async inventoryReport(
    organizationId: string | null,
    from: Date,
    to: Date,
    branchId: string | null = null,
  ) {
    const scope = branchId ? { branchId } : {};

    const movements = (await this.prisma.inventoryMovement.findMany({
      where: {
        organizationId: organizationId!,
        ...scope,
        createdAt: { gte: from, lte: to },
      },
      select: {
        type: true,
        quantity: true,
        ingredientName: true,
        displayUnit: true,
      },
    })) as any[];
    const ingredients = await this.prisma.ingredient.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        baseUnit: true,
        displayUnit: true,
        currentStock: true,
        minStock: true,
        ...(branchId
          ? { branchStocks: { where: { branchId }, select: { quantity: true } } }
          : {}),
      },
    });

    const byType = new Map<InventoryMovementType, { count: number; quantity: number }>();
    const consumption = new Map<
      string,
      {
        name: string;
        displayUnit: string;
        quantity: Prisma.Decimal;
      }
    >();

    for (const movement of movements) {
      const entry = byType.get(movement.type) ?? { count: 0, quantity: 0 };
      entry.count += 1;
      entry.quantity += Math.abs(Number(movement.quantity));
      byType.set(movement.type, entry);

      if (movement.type !== InventoryMovementType.CONSUMPTION) continue;

      const key = movement.ingredientName;
      const current = consumption.get(key) ?? {
        name: movement.ingredientName,
        displayUnit: movement.displayUnit,
        quantity: new Prisma.Decimal(0),
      };
      current.quantity = current.quantity.plus(
        new Prisma.Decimal(movement.quantity).abs(),
      );
      consumption.set(key, current);
    }

    const lowStock = ingredients
      .map((ingredient) => {
        const branchStock = branchId
          ? (ingredient as { branchStocks?: Array<{ quantity: Prisma.Decimal }> })
              .branchStocks?.[0]?.quantity
          : undefined;
        const stock = branchId
          ? (branchStock ?? new Prisma.Decimal(0))
          : ingredient.currentStock;

        if (!stock.lte(ingredient.minStock)) return null;

        return {
          id: ingredient.id,
          name: ingredient.name,
          baseUnit: ingredient.baseUnit,
          displayUnit: ingredient.displayUnit,
          currentStock: Number(
            fromCanonicalQuantity(stock, ingredient.displayUnit),
          ),
          minStock: Number(
            fromCanonicalQuantity(ingredient.minStock, ingredient.displayUnit),
          ),
          deficit: Number(
            fromCanonicalQuantity(
              ingredient.minStock.minus(stock),
              ingredient.displayUnit,
            ).toFixed(4),
          ),
        };
      })
      .filter((ingredient) => ingredient !== null)
      .sort((a, b) => b.deficit - a.deficit);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      movements: [...byType].map(([type, value]) => ({
        type,
        count: value.count,
        quantity: round(value.quantity),
      })),
      consumption: [...consumption.values()]
        .map((row) => ({
          ...row,
          quantity: round(
            Number(
              fromCanonicalQuantity(
                row.quantity,
                row.displayUnit as UnitCode,
              ),
            ),
          ),
        }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
      lowStock,
    };
  }

  /** Reporte de cocina: volumen, tiempos medios y productos preparados. */
  async kitchenReport(
    organizationId: string | null,
    from: Date,
    to: Date,
    branchId: string | null = null,
  ) {
    const rounds = await this.prisma.orderRound.findMany({
      where: {
        order: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          createdAt: { gte: from, lte: to },
        },
      },
      select: {
        status: true,
        sentAt: true,
        startedAt: true,
        readyAt: true,
        deliveredAt: true,
        estimatedMinutes: true,
      },
    });

    const byStatus = new Map<OrderRoundStatus, number>();
    const byDay = new Map<string, number>();
    const wait: number[] = [];
    const prep: number[] = [];
    const delivery: number[] = [];
    const total: number[] = [];
    const estimatePairs: Array<{ estimate: number; real: number }> = [];

    for (const round of rounds) {
      byStatus.set(round.status, (byStatus.get(round.status) ?? 0) + 1);

      if (round.sentAt) {
        const key = dayKey(round.sentAt);
        byDay.set(key, (byDay.get(key) ?? 0) + 1);
      }

      if (round.sentAt && round.startedAt) {
        wait.push((round.startedAt.getTime() - round.sentAt.getTime()) / 60000);
      }

      if (round.startedAt && round.readyAt) {
        const real = (round.readyAt.getTime() - round.startedAt.getTime()) / 60000;

        prep.push(real);

        if (round.estimatedMinutes !== null && round.estimatedMinutes > 0) {
          estimatePairs.push({ estimate: round.estimatedMinutes, real });
        }
      }

      if (round.readyAt && round.deliveredAt) {
        delivery.push(
          (round.deliveredAt.getTime() - round.readyAt.getTime()) / 60000,
        );
      }

      if (round.sentAt && round.deliveredAt) {
        total.push(
          (round.deliveredAt.getTime() - round.sentAt.getTime()) / 60000,
        );
      }
    }

    const average = (values: number[]) =>
      values.length > 0
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : null;

    const estimateValues = estimatePairs.map((pair) => pair.estimate);
    const deviationValues = estimatePairs.map(
      (pair) => pair.real - pair.estimate,
    );
    const withinEstimate = estimatePairs.filter(
      (pair) => pair.real <= pair.estimate * 1.1,
    ).length;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        rounds: rounds.length,
        averageWaitMinutes: average(wait),
        averagePrepMinutes: average(prep),
        averageDeliveryMinutes: average(delivery),
        averageTotalMinutes: average(total),
        averageEstimatedMinutes: average(estimateValues),
        averageDeviationMinutes: average(deviationValues),
        estimateSamples: estimatePairs.length,
        withinEstimateRate:
          estimatePairs.length > 0
            ? Math.round((withinEstimate / estimatePairs.length) * 1000) / 1000
            : null,
      },
      byStatus: [...byStatus].map(([status, count]) => ({ status, count })),
      byDay: [...byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
    };
  }
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Clave `YYYY-MM-DD` en hora local del servidor. */
function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function sumDecimals(values: Array<Prisma.Decimal | number>): number {
  return values.reduce<number>(
    (sum, value) => sum + Number(value),
    0,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
