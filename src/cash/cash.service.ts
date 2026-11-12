import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementType,
  CashSessionStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CashMovementDto,
  CloseCashSessionDto,
  ListCashSessionsQueryDto,
  OpenCashSessionDto,
} from './dto/cash.dto';

const sessionInclude = {
  branch: { select: { id: true, name: true } },
  openedBy: { select: { id: true, name: true, username: true } },
  closedBy: { select: { id: true, name: true, username: true } },
} satisfies Prisma.CashSessionInclude;

const movementInclude = {
  user: { select: { id: true, name: true, username: true } },
} satisfies Prisma.CashMovementInclude;

const paymentInclude = {
  user: { select: { id: true, name: true, username: true } },
  tipRecipient: { select: { id: true, name: true, username: true } },
  order: {
    select: {
      id: true,
      tableNumber: true,
      channel: true,
      status: true,
      total: true,
    },
  },
} satisfies Prisma.PaymentInclude;

export type CashSessionView = ReturnType<CashService['toSessionView']>;

@Injectable()
export class CashService {
  constructor(private readonly prisma: PrismaService) {}

  /** Turno abierto de la sucursal activa (o de la organización si no hay). */
  async current(organizationId: string | null, branchId: string | null) {
    if (!organizationId) return { session: null, summary: null };

    const session = await this.prisma.cashSession.findFirst({
      where: {
        organizationId,
        branchId,
        status: CashSessionStatus.OPEN,
      },
      include: sessionInclude,
      orderBy: { openedAt: 'desc' },
    });

    if (!session) return { session: null, summary: null };

    return this.detailData(session);
  }

  async open(
    organizationId: string | null,
    branchId: string | null,
    userId: string,
    dto: OpenCashSessionDto,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const openingFloat = new Prisma.Decimal(dto.openingFloat ?? 0).toDecimalPlaces(
      2,
    );

    const existing = await this.prisma.cashSession.findFirst({
      where: {
        organizationId,
        branchId,
        status: CashSessionStatus.OPEN,
      },
      select: { id: true, openedAt: true },
    });

    if (existing) {
      throw new ConflictException(
        'Ya hay una caja abierta en esta sucursal. Ciérrala antes de abrir otra.',
      );
    }

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cashSession.create({
        data: {
          organizationId,
          branchId,
          openedById: userId,
          openingFloat,
        },
        include: sessionInclude,
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'cash.opened',
          entity: 'CashSession',
          entityId: created.id,
          newValues: {
            branchId,
            openingFloat: openingFloat.toFixed(2),
          },
        },
      });

      return created;
    });

    return this.detailData(session);
  }

  async close(
    organizationId: string | null,
    sessionId: string,
    userId: string,
    dto: CloseCashSessionDto,
  ) {
    const session = await this.findSession(organizationId, sessionId);

    if (session.status !== CashSessionStatus.OPEN) {
      throw new BadRequestException('La caja ya está cerrada');
    }

    const expected = await this.expectedCash(session.id, session.openingFloat);
    const counted = new Prisma.Decimal(dto.countedCash).toDecimalPlaces(2);
    const difference = counted.minus(expected).toDecimalPlaces(2);

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.cashSession.updateMany({
        where: { id: sessionId, status: CashSessionStatus.OPEN },
        data: {
          status: CashSessionStatus.CLOSED,
          closedById: userId,
          closedAt: new Date(),
          countedCash: counted,
          expectedCash: expected,
          difference,
          notes: dto.notes?.trim() || null,
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException('La caja ya cambió de estado');
      }

      await tx.auditLog.create({
        data: {
          organizationId: session.organizationId,
          userId,
          action: 'cash.closed',
          entity: 'CashSession',
          entityId: sessionId,
          newValues: {
            expectedCash: expected.toFixed(2),
            countedCash: counted.toFixed(2),
            difference: difference.toFixed(2),
            notes: dto.notes?.trim() || null,
          },
        },
      });

      return tx.cashSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: sessionInclude,
      });
    });

    return this.detailData(updated);
  }

  async addMovement(
    organizationId: string | null,
    sessionId: string,
    userId: string,
    dto: CashMovementDto,
  ) {
    const session = await this.findSession(organizationId, sessionId);

    if (session.status !== CashSessionStatus.OPEN) {
      throw new BadRequestException(
        'No se pueden registrar movimientos en una caja cerrada',
      );
    }

    const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);

    const movement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cashMovement.create({
        data: {
          organizationId: session.organizationId,
          branchId: session.branchId,
          sessionId,
          type: dto.type,
          amount,
          reason: dto.reason.trim(),
          userId,
        },
        include: movementInclude,
      });

      await tx.auditLog.create({
        data: {
          organizationId: session.organizationId,
          userId,
          action: 'cash.movement',
          entity: 'CashSession',
          entityId: sessionId,
          newValues: {
            type: dto.type,
            amount: amount.toFixed(2),
            reason: dto.reason.trim(),
          },
        },
      });

      return created;
    });

    return movement;
  }

  async list(
    organizationId: string | null,
    branchId: string | null,
    filters: ListCashSessionsQueryDto = {},
  ) {
    if (!organizationId) return { items: [], total: 0 };

    const limit = Math.min(Math.max(filters.limit ?? 30, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const from = parseDate(filters.from);
    const to = parseDate(filters.to, true);

    const where: Prisma.CashSessionWhereInput = {
      organizationId,
      ...(branchId ? { branchId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(from || to
        ? {
            openedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [sessions, total] = await Promise.all([
      this.prisma.cashSession.findMany({
        where,
        include: sessionInclude,
        orderBy: { openedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.cashSession.count({ where }),
    ]);

    const ids = sessions.map((session) => session.id);
    const grouped = ids.length
      ? await this.prisma.payment.groupBy({
          by: ['sessionId', 'status', 'method'],
          where: {
            sessionId: { in: ids },
            status: {
              in: [PaymentStatus.CONFIRMED, PaymentStatus.REFUNDED],
            },
          },
          _sum: { amount: true, tipAmount: true },
          _count: { _all: true },
        })
      : [];

    return {
      items: sessions.map((session) => {
        const rows = grouped.filter((row) => row.sessionId === session.id);
        const confirmed = rows.filter(
          (row) => row.status === PaymentStatus.CONFIRMED,
        );

        return {
          ...this.toSessionView(session),
          totals: {
            sales: round(
              confirmed.reduce(
                (sum, row) => sum + Number(row._sum.amount ?? 0),
                0,
              ),
            ),
            tips: round(
              confirmed.reduce(
                (sum, row) => sum + Number(row._sum.tipAmount ?? 0),
                0,
              ),
            ),
            count: confirmed.reduce((sum, row) => sum + row._count._all, 0),
            refunded: rows
              .filter((row) => row.status === PaymentStatus.REFUNDED)
              .reduce((sum, row) => sum + row._count._all, 0),
          },
        };
      }),
      total,
    };
  }

  async detail(organizationId: string | null, sessionId: string) {
    const session = await this.findSession(organizationId, sessionId);

    return this.detailData(session, true);
  }

  /**
   * Cobros agrupados por usuario para detectar fallas o manejos indebidos:
   * ventas, propinas, anulaciones, reembolsos y cuentas canceladas.
   */
  async chargesReport(
    organizationId: string | null,
    branchId: string | null,
    from?: string,
    to?: string,
  ) {
    if (!organizationId) return { from: null, to: null, users: [], totals: null };

    const fromDate = parseDate(from);
    const toDate = parseDate(to, true);
    const createdAt =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;

    const [payments, cancelledOrders, users] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['userId', 'method', 'status'],
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true, tipAmount: true },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['userId'],
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          status: 'CANCELLED',
          ...(createdAt ? { createdAt } : {}),
        },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: { memberships: { some: { organizationId } } },
        select: { id: true, name: true, username: true },
      }),
    ]);

    const userIds = new Set<string>();
    for (const row of payments) if (row.userId) userIds.add(row.userId);
    for (const row of cancelledOrders) if (row.userId) userIds.add(row.userId);

    const byMethod = (rows: typeof payments) => {
      const methods = new Map<
        PaymentMethod,
        { total: number; tips: number; count: number }
      >();

      for (const row of rows) {
        if (row.status !== PaymentStatus.CONFIRMED) continue;
        const current =
          methods.get(row.method) ?? { total: 0, tips: 0, count: 0 };
        current.total += Number(row._sum.amount ?? 0);
        current.tips += Number(row._sum.tipAmount ?? 0);
        current.count += row._count._all;
        methods.set(row.method, current);
      }

      return [...methods].map(([method, value]) => ({
        method,
        total: round(value.total),
        tips: round(value.tips),
        count: value.count,
      }));
    };

    const rows = [...userIds]
      .map((userId) => {
        const own = payments.filter((row) => row.userId === userId);
        const confirmed = own.filter(
          (row) => row.status === PaymentStatus.CONFIRMED,
        );
        const refunded = own.filter(
          (row) => row.status === PaymentStatus.REFUNDED,
        );
        const cancelled = own.filter(
          (row) => row.status === PaymentStatus.CANCELLED,
        );
        const user = users.find((entry) => entry.id === userId);
        const total = confirmed.reduce(
          (sum, row) => sum + Number(row._sum.amount ?? 0),
          0,
        );
        const tips = confirmed.reduce(
          (sum, row) => sum + Number(row._sum.tipAmount ?? 0),
          0,
        );
        const cancelledCount =
          cancelledOrders.find((row) => row.userId === userId)?._count._all ??
          0;

        return {
          userId,
          name: user?.name ?? 'Cuenta eliminada',
          username: user?.username ?? null,
          count: confirmed.reduce((sum, row) => sum + row._count._all, 0),
          total: round(total),
          tips: round(tips),
          refundedCount: refunded.reduce(
            (sum, row) => sum + row._count._all,
            0,
          ),
          refundedAmount: round(
            refunded.reduce(
              (sum, row) => sum + Number(row._sum.amount ?? 0),
              0,
            ),
          ),
          cancelledCount: cancelled.reduce(
            (sum, row) => sum + row._count._all,
            0,
          ),
          cancelledOrders: cancelledCount,
          byMethod: byMethod(own),
          refundRate:
            total > 0
              ? round(
                  (refunded.reduce(
                    (sum, row) => sum + Number(row._sum.amount ?? 0),
                    0,
                  ) /
                    total) *
                    100,
                )
              : 0,
        };
      })
      .filter((row) => row.count > 0 || row.refundedCount > 0)
      .sort((left, right) => right.total - left.total);

    return {
      from: fromDate?.toISOString() ?? null,
      to: toDate?.toISOString() ?? null,
      users: rows,
      totals: {
        count: rows.reduce((sum, row) => sum + row.count, 0),
        total: round(rows.reduce((sum, row) => sum + row.total, 0)),
        tips: round(rows.reduce((sum, row) => sum + row.tips, 0)),
        refundedCount: rows.reduce(
          (sum, row) => sum + row.refundedCount,
          0,
        ),
        refundedAmount: round(
          rows.reduce((sum, row) => sum + row.refundedAmount, 0),
        ),
        cancelledOrders: rows.reduce(
          (sum, row) => sum + row.cancelledOrders,
          0,
        ),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Interno
  // --------------------------------------------------------------------------

  private async findSession(organizationId: string | null, sessionId: string) {
    if (!organizationId) {
      throw new NotFoundException('Turno de caja no encontrado');
    }

    const session = await this.prisma.cashSession.findFirst({
      where: { id: sessionId, organizationId },
      include: sessionInclude,
    });

    if (!session) throw new NotFoundException('Turno de caja no encontrado');

    return session;
  }

  private async expectedCash(sessionId: string, openingFloat: Prisma.Decimal) {
    const [cashPayments, movements] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          sessionId,
          method: PaymentMethod.CASH,
          status: PaymentStatus.CONFIRMED,
        },
        select: { amount: true, tipAmount: true },
      }),
      this.prisma.cashMovement.findMany({
        where: { sessionId },
        select: { type: true, amount: true },
      }),
    ]);

    let total = new Prisma.Decimal(openingFloat);

    for (const payment of cashPayments) {
      total = total.plus(payment.amount).plus(payment.tipAmount);
    }

    for (const movement of movements) {
      if (
        movement.type === CashMovementType.WITHDRAWAL ||
        movement.type === CashMovementType.EXPENSE
      ) {
        total = total.minus(movement.amount);
      } else {
        total = total.plus(movement.amount);
      }
    }

    return total.toDecimalPlaces(2);
  }

  private async detailData(
    session: Prisma.CashSessionGetPayload<{ include: typeof sessionInclude }>,
    withPayments = false,
  ) {
    const [grouped, byUser, movements, payments, expectedCash] =
      await Promise.all([
        this.prisma.payment.groupBy({
          by: ['method', 'status'],
          where: { sessionId: session.id },
          _sum: { amount: true, tipAmount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.groupBy({
          by: ['userId', 'status'],
          where: { sessionId: session.id },
          _sum: { amount: true, tipAmount: true },
          _count: { _all: true },
        }),
        this.prisma.cashMovement.findMany({
          where: { sessionId: session.id },
          include: movementInclude,
          orderBy: { createdAt: 'asc' },
        }),
        withPayments
          ? this.prisma.payment.findMany({
              where: { sessionId: session.id },
              include: paymentInclude,
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
        this.expectedCash(session.id, session.openingFloat),
      ]);

    const confirmed = grouped.filter(
      (row) => row.status === PaymentStatus.CONFIRMED,
    );
    const sales = round(
      confirmed.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0),
    );
    const tips = round(
      confirmed.reduce((sum, row) => sum + Number(row._sum.tipAmount ?? 0), 0),
    );
    const cashSales = round(
      confirmed
        .filter((row) => row.method === PaymentMethod.CASH)
        .reduce(
          (sum, row) =>
            sum +
            Number(row._sum.amount ?? 0) +
            Number(row._sum.tipAmount ?? 0),
          0,
        ),
    );
    const withdrawals = round(
      movements
        .filter((row) => row.type === CashMovementType.WITHDRAWAL)
        .reduce((sum, row) => sum + Number(row.amount), 0),
    );
    const expenses = round(
      movements
        .filter((row) => row.type === CashMovementType.EXPENSE)
        .reduce((sum, row) => sum + Number(row.amount), 0),
    );
    const deposits = round(
      movements
        .filter(
          (row) =>
            row.type === CashMovementType.DEPOSIT ||
            row.type === CashMovementType.ADJUSTMENT,
        )
        .reduce((sum, row) => sum + Number(row.amount), 0),
    );

    const userGroups = new Map<
      string,
      { total: number; tips: number; count: number; refunds: number }
    >();

    for (const row of byUser) {
      const key = row.userId ?? '__none__';
      const current =
        userGroups.get(key) ?? { total: 0, tips: 0, count: 0, refunds: 0 };

      if (row.status === PaymentStatus.CONFIRMED) {
        current.total += Number(row._sum.amount ?? 0);
        current.tips += Number(row._sum.tipAmount ?? 0);
        current.count += row._count._all;
      }

      if (row.status === PaymentStatus.REFUNDED) {
        current.refunds += row._count._all;
      }

      userGroups.set(key, current);
    }

    const userIds = [...userGroups.keys()].filter((id) => id !== '__none__');
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, username: true },
        })
      : [];

    return {
      session: this.toSessionView(session),
      summary: {
        sales,
        tips,
        count: confirmed.reduce((sum, row) => sum + row._count._all, 0),
        expectedCash: expectedCash.toNumber(),
        cash: {
          openingFloat: session.openingFloat.toNumber(),
          sales: cashSales,
          withdrawals,
          expenses,
          deposits,
          expected: expectedCash.toNumber(),
          counted:
            session.countedCash === null
              ? null
              : session.countedCash.toNumber(),
          difference:
            session.difference === null
              ? null
              : session.difference.toNumber(),
        },
        byMethod: grouped.map((row) => ({
          method: row.method,
          status: row.status,
          total: round(Number(row._sum.amount ?? 0)),
          tips: round(Number(row._sum.tipAmount ?? 0)),
          count: row._count._all,
        })),
        byUser: [...userGroups].map(([userId, value]) => {
          const user = users.find((entry) => entry.id === userId);

          return {
            userId: userId === '__none__' ? null : userId,
            name: userId === '__none__' ? 'Sin usuario' : user?.name ?? '—',
            username: user?.username ?? null,
            total: round(value.total),
            tips: round(value.tips),
            count: value.count,
            refunds: value.refunds,
          };
        }),
      },
      movements: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        amount: movement.amount.toNumber(),
        reason: movement.reason,
        createdAt: movement.createdAt,
        user: movement.user,
      })),
      payments,
    };
  }

  toSessionView(
    session: Prisma.CashSessionGetPayload<{ include: typeof sessionInclude }>,
  ) {
    return {
      id: session.id,
      status: session.status,
      branchId: session.branchId,
      branchName: session.branch?.name ?? null,
      openedAt: session.openedAt,
      openedBy: session.openedBy,
      closedAt: session.closedAt,
      closedBy: session.closedBy,
      openingFloat: session.openingFloat.toNumber(),
      countedCash:
        session.countedCash === null ? null : session.countedCash.toNumber(),
      expectedCash:
        session.expectedCash === null ? null : session.expectedCash.toNumber(),
      difference:
        session.difference === null ? null : session.difference.toNumber(),
      notes: session.notes,
    };
  }
}

function parseDate(value: string | undefined, endOfDay = false) {
  if (!value) return undefined;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(23, 59, 59, 999);
  }

  return date;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
