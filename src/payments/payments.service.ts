import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderRoundStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  type Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rolesHavePermission } from '../common/permissions';
import { OrdersEventsService } from '../orders/orders.events';
import { CreatePaymentDto, VoidPaymentDto } from './dto/payments.dto';

const ACTIVE_ROUND_STATUSES = [
  OrderRoundStatus.PENDING,
  OrderRoundStatus.PREPARING,
  OrderRoundStatus.READY,
];

const paymentInclude = {
  order: {
    select: {
      id: true,
      tableNumber: true,
      isTakeaway: true,
      status: true,
      total: true,
    },
  },
  user: { select: { id: true, name: true, username: true } },
  confirmedBy: { select: { id: true, name: true, username: true } },
  tipRecipient: { select: { id: true, name: true, username: true } },
  session: { select: { id: true, status: true } },
} satisfies Prisma.PaymentInclude;

export interface PaymentFilters {
  from?: Date;
  to?: Date;
  method?: PaymentMethod;
  status?: PaymentStatus;
  limit?: number;
  offset?: number;
}

export interface PaymentActor {
  id: string;
  roles: Role[];
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrdersEventsService,
  ) {}

  /**
   * Listado de la caja con totales por método y estado.
   *
   * Es una consulta de lectura: los importes se agregan en la base de datos y
   * nunca se recalculan en el cliente (`plan.md` §6.8).
   */
  async list(
    organizationId: string | null,
    filters: PaymentFilters = {},
    branchId: string | null = null,
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const where: Prisma.PaymentWhereInput = {
      organizationId,
      ...(branchId ? { branchId } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };

    const [items, grouped] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: paymentInclude,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.payment.groupBy({
        by: ['method', 'status'],
        where,
        _sum: { amount: true, tipAmount: true },
        _count: { _all: true },
      }),
    ]);

    const byMethod = new Map<PaymentMethod, { total: number; count: number }>();
    const byStatus = new Map<PaymentStatus, { total: number; count: number }>();
    let confirmedTotal = 0;
    let tipsTotal = 0;
    let count = 0;

    for (const row of grouped) {
      const total = Number(row._sum.amount ?? 0);
      const rowCount = row._count._all;

      const method = byMethod.get(row.method) ?? { total: 0, count: 0 };
      method.total += total;
      method.count += rowCount;
      byMethod.set(row.method, method);

      const status = byStatus.get(row.status) ?? { total: 0, count: 0 };
      status.total += total;
      status.count += rowCount;
      byStatus.set(row.status, status);

      count += rowCount;

      if (row.status === PaymentStatus.CONFIRMED) {
        confirmedTotal += total;
        tipsTotal += Number(row._sum.tipAmount ?? 0);
      }
    }

    return {
      items,
      totals: {
        count,
        confirmed: round(confirmedTotal),
        tips: round(tipsTotal),
        byMethod: [...byMethod].map(([method, value]) => ({
          method,
          total: round(value.total),
          count: value.count,
        })),
        byStatus: [...byStatus].map(([status, value]) => ({
          status,
          total: round(value.total),
          count: value.count,
        })),
      },
    };
  }

  /** Registra un pago en estado PENDIENTE sobre una cuenta abierta. */
  async register(
    organizationId: string | null,
    userId: string,
    orderId: string,
    dto: CreatePaymentDto,
    options: { paidAt?: Date | null; pointCharge?: boolean } = {},
  ) {
    if (
      dto.method === PaymentMethod.MERCADO_PAGO_POINT &&
      !options.pointCharge
    ) {
      throw new BadRequestException(
        'Los cobros con terminal se envían desde el punto de venta',
      );
    }

    const order = await this.getOpenOrder(organizationId, orderId);
    const amount = decimal(dto.amount, 'El importe');
    const tipAmount = new Prisma.Decimal(dto.tipAmount ?? 0).toDecimalPlaces(2);
    const session = await this.requireOpenSession(
      organizationId,
      order.branchId,
    );

    if (dto.tipRecipientId) {
      const member = await this.prisma.membership.findFirst({
        where: {
          userId: dto.tipRecipientId,
          organizationId,
          isActive: true,
        },
        select: { id: true },
      });

      if (!member) {
        throw new BadRequestException(
          'Quien recibe la propina no pertenece al negocio',
        );
      }
    }

    let cashReceived: Prisma.Decimal | null = null;
    let changeGiven: Prisma.Decimal | null = null;

    if (dto.method === PaymentMethod.CASH) {
      const charged = amount.plus(tipAmount);

      if (dto.cashReceived === undefined) {
        cashReceived = charged;
      } else {
        cashReceived = new Prisma.Decimal(dto.cashReceived).toDecimalPlaces(2);

        if (cashReceived.lt(charged)) {
          throw new BadRequestException(
            'El efectivo recibido no cubre el importe más la propina',
          );
        }
      }

      changeGiven = cashReceived.minus(charged).toDecimalPlaces(2);
    } else if (dto.changeGiven !== undefined) {
      changeGiven = new Prisma.Decimal(dto.changeGiven).toDecimalPlaces(2);
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
        include: paymentInclude,
      });

      if (existing) {
        if (existing.orderId !== orderId) {
          throw new ConflictException(
            'La clave de idempotencia ya está en uso',
          );
        }

        return { ...existing, duplicated: true };
      }
    }

    const totals = await this.totals(orderId);
    const remaining = order.total.minus(totals.confirmed).minus(totals.pending);

    if (amount.gt(remaining)) {
      throw new BadRequestException(
        `El importe supera el saldo pendiente (${remaining.toFixed(2)})`,
      );
    }

    return this.prisma.payment.create({
      data: {
        organizationId,
        branchId: order.branchId,
        orderId,
        userId,
        method: dto.method,
        amount,
        tipAmount,
        tipRecipientId:
          dto.tipRecipientId ?? (tipAmount.gt(0) ? userId : null),
        cashReceived,
        changeGiven,
        sessionId: session.id,
        status: PaymentStatus.PENDING,
        paidAt:
          options.paidAt === undefined ? new Date() : options.paidAt,
        idempotencyKey,
      },
      include: paymentInclude,
    });
  }

  /** Exige una caja abierta para la sucursal de la cuenta. */
  private async requireOpenSession(
    organizationId: string | null,
    branchId: string | null,
  ) {
    if (!organizationId) {
      throw new BadRequestException(
        'Abre la caja antes de cobrar: la sesión no tiene negocio activo',
      );
    }

    const session = await this.prisma.cashSession.findFirst({
      where: {
        organizationId,
        branchId,
        status: 'OPEN',
      },
      select: { id: true },
    });

    if (!session) {
      throw new BadRequestException(
        'Abre la caja de la sucursal antes de registrar cobros',
      );
    }

    return session;
  }

  /**
   * Confirma un pago pendiente.
   *
   * La confirmación es explícita y autorizada (`payments:confirm`): registrar
   * "tarjeta" o "transferencia" no implica que el dinero haya entrado
   * (`plan.md` §6.8). Es idempotente: confirmar dos veces devuelve el mismo
   * pago sin duplicar el ingreso.
   */
  async confirm(organizationId: string | null, userId: string, paymentId: string) {
    return this.confirmInternal(organizationId, paymentId, {
      userId,
      source: 'manual',
    });
  }

  /**
   * Confirma un pago que el proveedor ya cobró (webhook o conciliación).
   *
   * No exige `payments:confirm`: el dinero ya entró y el rol solo podía
   * impedir que un cajero “marque” un cobro que no ocurrió. Queda auditado con
   * `source: mercado_pago` y sin usuario responsable.
   */
  async confirmByProvider(
    organizationId: string | null,
    paymentId: string,
    options: { paidAt?: Date; providerStatus?: string } = {},
  ) {
    return this.confirmInternal(organizationId, paymentId, {
      userId: null,
      source: 'mercado_pago',
      paidAt: options.paidAt,
      providerStatus: options.providerStatus,
    });
  }

  private async confirmInternal(
    organizationId: string | null,
    paymentId: string,
    options: {
      userId: string | null;
      source: string;
      paidAt?: Date;
      providerStatus?: string;
    },
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
      include: { order: { select: { id: true, status: true, total: true } } },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }

    if (payment.status === PaymentStatus.CONFIRMED) {
      return { ...payment, duplicated: true };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        'Solo se puede confirmar un pago pendiente',
      );
    }

    if (payment.order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    const now = options.paidAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.payment.aggregate({
        where: {
          orderId: payment.orderId,
          status: PaymentStatus.CONFIRMED,
        },
        _sum: { amount: true },
      });

      const paid = confirmed._sum.amount ?? new Prisma.Decimal(0);
      const remaining = payment.order.total.minus(paid);

      if (payment.amount.gt(remaining)) {
        throw new BadRequestException(
          `El importe supera el saldo pendiente (${remaining.toFixed(2)})`,
        );
      }

      // Guarda contra dobles clics: solo una petición pasa de PENDING.
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.CONFIRMED,
          confirmedAt: now,
          confirmedById: options.userId,
          paidAt: options.paidAt ?? payment.paidAt ?? now,
        },
      });

      const current = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: paymentInclude,
      });

      if (claimed.count === 0) {
        return {
          ...current,
          duplicated: current.status === PaymentStatus.CONFIRMED,
        };
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: options.userId,
          action: 'payment.confirmed',
          entity: 'Payment',
          entityId: paymentId,
          newValues: {
            method: payment.method,
            amount: payment.amount.toFixed(2),
            source: options.source,
            providerStatus: options.providerStatus ?? null,
          },
        },
      });

      return current;
    });
  }

  /**
   * Anula un pago pendiente o reembolsa uno confirmado.
   *
   * Reglas aprobadas para el MVP:
   * - PENDIENTE → CANCELADO: lo puede hacer quien confirma pagos.
   * - CONFIRMADO → REEMBOLSADO: solo ADMIN, exige motivo y queda auditado.
   * - Nunca se borra ni se sobrescribe un pago histórico.
   */
  async voidPayment(
    organizationId: string | null,
    actor: PaymentActor,
    paymentId: string,
    dto: VoidPaymentDto = {},
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }

    if (
      payment.status === PaymentStatus.CANCELLED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      return { ...payment, duplicated: true };
    }

    const isPending = payment.status === PaymentStatus.PENDING;
    const reason = dto.reason?.trim();

    if (!reason) {
      throw new BadRequestException(
        'Indica el motivo de la anulación o del reembolso',
      );
    }

    if (isPending) {
      if (!rolesHavePermission(actor.roles, 'payments:confirm')) {
        throw new ForbiddenException('No puedes anular pagos');
      }
    } else if (!rolesHavePermission(actor.roles, 'payments:refund')) {
      throw new ForbiddenException('Solo administración puede reembolsar');
    }

    const status = isPending
      ? PaymentStatus.CANCELLED
      : PaymentStatus.REFUNDED;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { status },
        include: paymentInclude,
      });

      // Si se devuelve efectivo de un pago confirmado, el dinero sale del
      // cajón del turno abierto: se registra como gasto para que el arqueo
      // siga cuadrando.
      if (
        !isPending &&
        payment.method === PaymentMethod.CASH &&
        payment.organizationId
      ) {
        const openSession = await tx.cashSession.findFirst({
          where: {
            organizationId: payment.organizationId,
            branchId: payment.branchId,
            status: 'OPEN',
          },
          select: { id: true },
        });

        if (openSession) {
          const sameOpenSession = payment.sessionId === openSession.id

          // Si el pago pertenece al turno abierto, el reembolso ya reduce el
          // esperado al pasar a REFUNDED; solo se registra un gasto cuando el
          // dinero sale de un turno distinto (o de un pago legado sin turno).
          if (!sameOpenSession) {
            await tx.cashMovement.create({
              data: {
                organizationId: payment.organizationId,
                branchId: payment.branchId,
                sessionId: openSession.id,
                type: 'EXPENSE',
                amount: payment.amount.plus(payment.tipAmount),
                reason: `Reembolso: ${reason}`,
                userId: actor.id,
              },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actor.id,
          action: isPending ? 'payment.cancelled' : 'payment.refunded',
          entity: 'Payment',
          entityId: paymentId,
          oldValues: { status: payment.status },
          newValues: {
            status,
            amount: payment.amount.toFixed(2),
            tipAmount: payment.tipAmount.toFixed(2),
            reason,
            sessionId: payment.sessionId,
          },
        },
      });

      return updated;
    });
  }

  /**
   * Cierra la cuenta.
   *
   * Requisitos: no puede haber comandas activas y el total debe estar cubierto
   * por pagos confirmados. El saldo se calcula en el servidor: el cliente no
   * decide si una cuenta está pagada (`plan.md` §5).
   */
  async closeOrder(organizationId: string | null, userId: string, orderId: string) {
    const order = await this.getOpenOrder(organizationId, orderId);

    const activeRounds = await this.prisma.orderRound.count({
      where: { orderId, status: { in: ACTIVE_ROUND_STATUSES } },
    });

    if (activeRounds > 0) {
      throw new BadRequestException(
        'Todavía hay comandas activas en cocina; entrégalas o cancélalas antes de cerrar',
      );
    }

    const totals = await this.totals(orderId);
    const missing = order.total.minus(totals.confirmed);

    if (missing.gt(0)) {
      throw new BadRequestException(
        `Faltan ${missing.toFixed(2)} por cobrar en esta cuenta`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.OPEN },
        data: { status: OrderStatus.CLOSED },
      });

      if (claimed.count === 0) {
        throw new ConflictException('La cuenta ya cambió de estado');
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'order.closed',
          entity: 'Order',
          entityId: orderId,
          newValues: { total: order.total.toFixed(2) },
        },
      });

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          user: { select: { id: true, name: true, username: true } },
          payments: {
            include: paymentInclude,
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    this.events.publish({ type: 'ORDER_CLOSED', orderId });

    return updated;
  }

  // --------------------------------------------------------------------------
  // Interno
  // --------------------------------------------------------------------------

  private async getOpenOrder(organizationId: string | null, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: { id: true, status: true, total: true, branchId: true },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    return order;
  }

  private async totals(orderId: string) {
    const rows = await this.prisma.payment.groupBy({
      by: ['status'],
      where: { orderId },
      _sum: { amount: true },
    });

    const sum = (status: PaymentStatus) =>
      rows.find((row) => row.status === status)?._sum.amount ??
      new Prisma.Decimal(0);

    return {
      confirmed: new Prisma.Decimal(sum(PaymentStatus.CONFIRMED)),
      pending: new Prisma.Decimal(sum(PaymentStatus.PENDING)),
    };
  }
}

function decimal(value: number, label: string): Prisma.Decimal {
  const amount = new Prisma.Decimal(value).toDecimalPlaces(2);

  if (amount.lte(0)) {
    throw new BadRequestException(`${label} debe ser mayor que cero`);
  }

  return amount;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export { paymentInclude };
