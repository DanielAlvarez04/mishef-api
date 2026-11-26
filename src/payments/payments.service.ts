import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  TipSource,
  type Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ANALYTICS_EVENTS } from '../analytics/analytics.events';
import { rolesHavePermission } from '../common/permissions';
import { OrdersEventsService } from '../orders/orders.events';
import { OrderSplitsService } from '../orders/order-splits.service';
import {
  CreatePaymentDto,
  ReconcilePaymentDto,
  RegisterOfflineCardPaymentDto,
  VoidPaymentDto,
} from './dto/payments.dto';
import { ProviderPaymentRegistry } from './provider-payment.registry';

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
  split: {
    select: {
      id: true,
      label: true,
      expectedAmount: true,
      status: true,
    },
  },
} satisfies Prisma.PaymentInclude;

export interface PaymentFilters {
  from?: Date;
  to?: Date;
  method?: PaymentMethod;
  status?: PaymentStatus;
  review?: boolean;
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
    private readonly splits: OrderSplitsService,
    private readonly analytics: AnalyticsService,
    private readonly providers: ProviderPaymentRegistry,
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
      ...(filters.review ? { reviewRequired: true } : {}),
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
    options: {
      paidAt?: Date | null;
      pointCharge?: boolean;
      confirm?: boolean;
    } = {},
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
      const existing = await this.prisma.payment.findFirst({
        where: { organizationId, idempotencyKey },
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

    if (dto.splitId) {
      await this.splits.assertPaymentFits(orderId, dto.splitId, amount);
    }

    const created = await this.prisma.payment.create({
      data: {
        organizationId,
        branchId: order.branchId,
        orderId,
        userId,
        method: dto.method,
        amount,
        tipAmount,
        tipPercent:
          dto.tipPercent === undefined || dto.tipPercent === null
            ? null
            : new Prisma.Decimal(dto.tipPercent).toDecimalPlaces(2),
        tipSource: dto.tipSource ?? TipSource.NONE,
        tipBaseAmount:
          dto.tipBaseAmount === undefined || dto.tipBaseAmount === null
            ? null
            : new Prisma.Decimal(dto.tipBaseAmount).toDecimalPlaces(2),
        tipRecipientId:
          dto.tipRecipientId ?? (tipAmount.gt(0) ? userId : null),
        cashReceived,
        changeGiven,
        sessionId: session.id,
        splitId: dto.splitId ?? null,
        reference: dto.reference?.trim() || null,
        status: PaymentStatus.PENDING,
        paidAt:
          options.paidAt === undefined ? new Date() : options.paidAt,
        idempotencyKey,
      },
      include: paymentInclude,
    });

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.paymentRegistered,
        organizationId,
        branchId: order.branchId,
        userId,
        orderId,
        subjectType: 'payment',
        subjectId: created.id,
        amount: Number(amount),
        metadata: {
          method: dto.method,
          tipAmount: Number(tipAmount),
          tipPercent: dto.tipPercent ?? null,
          tipSource: dto.tipSource ?? TipSource.NONE,
          splitId: dto.splitId ?? null,
          cash: cashReceived !== null,
          reference: dto.reference?.trim() || null,
        },
      },
    ]);

    if (options.confirm) {
      return this.confirmInternal(organizationId, created.id, {
        userId,
        source: 'pos',
      });
    }

    return created;
  }

  /**
   * Registra un cobro con tarjeta capturado sin conexión.
   *
   * Queda PENDING y marcado para conciliación: nunca se confirma ni se cierra
   * la cuenta aquí. El servidor usa su hora para ordenar el evento y acota la
   * hora declarada por el dispositivo.
   */
  async registerOfflineCard(
    organizationId: string | null,
    userId: string,
    orderId: string,
    dto: RegisterOfflineCardPaymentDto,
  ) {
    const order = await this.getOpenOrder(organizationId, orderId);
    const amount = decimal(dto.amount, 'El importe');
    const tipAmount = new Prisma.Decimal(dto.tipAmount ?? 0).toDecimalPlaces(2);
    const session = await this.requireOpenSession(
      organizationId,
      order.branchId,
    );
    const reference = dto.reference.trim();
    const idempotencyKey = dto.idempotencyKey.trim();
    const deviceId = dto.deviceId.trim().slice(0, 64);

    if (reference.length < 4) {
      throw new BadRequestException(
        'Escribe la referencia o autorización del voucher',
      );
    }

    if (!idempotencyKey) {
      throw new BadRequestException('Falta la clave de idempotencia');
    }

    if (!deviceId) {
      throw new BadRequestException('Falta el identificador del dispositivo');
    }

    const existing = await this.prisma.payment.findFirst({
      where: { organizationId, idempotencyKey },
      include: paymentInclude,
    });

    if (existing) {
      if (existing.orderId !== orderId) {
        throw new ConflictException('La clave de idempotencia ya está en uso');
      }

      return { ...existing, duplicated: true };
    }

    const totals = await this.totals(orderId);
    const remaining = order.total.minus(totals.confirmed).minus(totals.pending);

    if (amount.gt(remaining)) {
      throw new BadRequestException(
        `El importe supera el saldo pendiente (${remaining.toFixed(2)})`,
      );
    }

    const now = new Date();
    const minOffline = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    let createdOfflineAt = now;

    if (dto.createdOfflineAt) {
      const parsed = new Date(dto.createdOfflineAt);

      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('La fecha del cobro offline no es válida');
      }

      createdOfflineAt =
        parsed > now ? now : parsed < minOffline ? minOffline : parsed;
    }

    const created = await this.prisma.payment.create({
      data: {
        organizationId,
        branchId: order.branchId,
        orderId,
        userId,
        method: PaymentMethod.CARD,
        amount,
        status: PaymentStatus.PENDING,
        paidAt: createdOfflineAt,
        tipAmount,
        tipPercent:
          dto.tipPercent === undefined || dto.tipPercent === null
            ? null
            : new Prisma.Decimal(dto.tipPercent).toDecimalPlaces(2),
        tipSource: dto.tipSource ?? TipSource.NONE,
        tipBaseAmount:
          dto.tipBaseAmount === undefined || dto.tipBaseAmount === null
            ? null
            : new Prisma.Decimal(dto.tipBaseAmount).toDecimalPlaces(2),
        tipRecipientId: tipAmount.gt(0) ? userId : null,
        sessionId: session.id,
        reference,
        idempotencyKey,
        offlineDeviceId: deviceId,
        createdOfflineAt,
        reviewRequired: true,
        reviewReason: 'Cobro con tarjeta capturado sin conexión',
        providerData: {
          offline: true,
          deviceId,
          capturedAt: createdOfflineAt.toISOString(),
        },
      },
      include: paymentInclude,
    });

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.paymentRegistered,
        organizationId,
        branchId: order.branchId,
        userId,
        orderId,
        subjectType: 'payment',
        subjectId: created.id,
        amount: Number(amount),
        metadata: {
          method: PaymentMethod.CARD,
          offline: true,
          reviewRequired: true,
          deviceId,
          reference,
          tipAmount: Number(tipAmount),
        },
      },
    ]);

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: 'payment.offline_card_registered',
        entity: 'Payment',
        entityId: created.id,
        newValues: {
          orderId,
          amount: amount.toFixed(2),
          tipAmount: tipAmount.toFixed(2),
          reference,
          deviceId,
          createdOfflineAt: createdOfflineAt.toISOString(),
        },
      },
    });

    return created;
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
   * Resuelve un cobro offline desde la cola de conciliación.
   *
   * Confirmar y rechazar exigen `payments:confirm` (ADMIN/CASHIER): es una
   * decisión sobre dinero. La confirmación usa el mismo camino que cualquier
   * pago y deja auditoría.
   */
  async reconcile(
    organizationId: string | null,
    actor: PaymentActor,
    paymentId: string,
    dto: ReconcilePaymentDto,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
      select: {
        id: true,
        orderId: true,
        status: true,
        reference: true,
        offlineDeviceId: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }

    if (dto.resolution === 'CONFIRM') {
      if (!rolesHavePermission(actor.roles, 'payments:confirm')) {
        throw new ForbiddenException('No puedes confirmar pagos');
      }

      if (payment.status === PaymentStatus.CONFIRMED) {
        return {
          payment: { ...payment, duplicated: true },
          closed: false,
          order: null,
          closeMessage: null,
        };
      }

      if (payment.status !== PaymentStatus.PENDING) {
        throw new BadRequestException(
          'Solo se puede conciliar un pago pendiente',
        );
      }

      const confirmed = await this.confirmInternal(organizationId, paymentId, {
        userId: actor.id,
        source: 'offline_reconciliation',
      });

      let closed = false;
      let order: unknown = null;
      let closeMessage: string | null = null;

      if (dto.closeOrder !== false) {
        try {
          order = await this.closeOrder(
            organizationId,
            actor.id,
            payment.orderId,
          );
          closed = true;
        } catch (error) {
          closeMessage =
            error instanceof Error
              ? error.message
              : 'No se pudo cerrar la cuenta';
        }
      }

      await this.prisma.auditLog.create({
        data: {
          organizationId,
          userId: actor.id,
          action: 'payment.reconciled',
          entity: 'Payment',
          entityId: paymentId,
          newValues: {
            resolution: 'CONFIRM',
            reference: payment.reference,
            deviceId: payment.offlineDeviceId,
            closeOrder: dto.closeOrder !== false,
            closed,
            closeMessage,
          },
        },
      });

      return { payment: confirmed, closed, order, closeMessage };
    }

    if (!rolesHavePermission(actor.roles, 'payments:confirm')) {
      throw new ForbiddenException('No puedes anular pagos');
    }

    const reason = dto.reason?.trim();

    if (!reason) {
      throw new BadRequestException('Indica el motivo del rechazo');
    }

    if (
      payment.status === PaymentStatus.CANCELLED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      return {
        payment: { ...payment, duplicated: true },
        closed: false,
        order: null,
        closeMessage: null,
      };
    }

    const cancelled = await this.voidPayment(
      organizationId,
      actor,
      paymentId,
      { reason },
      { providerHandled: true },
    );

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: actor.id,
        action: 'payment.reconciled',
        entity: 'Payment',
        entityId: paymentId,
        newValues: {
          resolution: 'REJECT',
          reason,
          reference: payment.reference,
          deviceId: payment.offlineDeviceId,
        },
      },
    });

    return {
      payment: cancelled,
      closed: false,
      order: null,
      closeMessage: null,
    };
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

    // Un cobro con terminal solo se confirma cuando Mercado Pago lo reporta:
    // confirmarlo a mano marcaría como pagado algo que no ocurrió.
    if (
      options.source === 'manual' &&
      payment.method === PaymentMethod.MERCADO_PAGO_POINT
    ) {
      throw new BadRequestException(
        'Los cobros con terminal se confirman solos cuando el cliente paga',
      );
    }

    if (payment.status === PaymentStatus.CONFIRMED) {
      return { ...payment, duplicated: true };
    }

    // Un link anulado localmente puede pagarse igual si el cliente conservó la
    // página. Si Mercado Pago dice que el cobro se aprobó, el dinero existe y
    // debe registrarse; solo se rechaza si la cuenta ya se cerró (para no
    // alterar un arqueo histórico sin revisión).
    const lateProviderPayment =
      options.source !== 'manual' &&
      payment.status === PaymentStatus.CANCELLED;

    if (payment.status !== PaymentStatus.PENDING && !lateProviderPayment) {
      throw new BadRequestException(
        'Solo se puede confirmar un pago pendiente',
      );
    }

    if (payment.order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    const now = options.paidAt ?? new Date();

    const result = await this.prisma.$transaction(async (tx) => {
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
        where: {
          id: paymentId,
          status: lateProviderPayment
            ? { in: [PaymentStatus.PENDING, PaymentStatus.CANCELLED] }
            : PaymentStatus.PENDING,
        },
        data: {
          status: PaymentStatus.CONFIRMED,
          confirmedAt: now,
          confirmedById: options.userId,
          paidAt: options.paidAt ?? payment.paidAt ?? now,
          reviewRequired: false,
          reviewReason: null,
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
            recoveredFromCancelled: lateProviderPayment,
          },
        },
      });

      return current;
    });

    await this.splits.recomputeStatus(payment.splitId);

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.paymentConfirmed,
        organizationId,
        branchId: payment.branchId,
        userId: options.userId,
        orderId: payment.orderId,
        subjectType: 'payment',
        subjectId: paymentId,
        amount: Number(payment.amount),
        metadata: {
          method: payment.method,
          tipAmount: Number(payment.tipAmount),
          tipPercent:
            payment.tipPercent === null
              ? null
              : Number(payment.tipPercent),
          tipSource: payment.tipSource,
          splitId: payment.splitId,
          source: options.source,
        },
      },
    ]);

    return result;
  }

  /**
   * Anula un pago pendiente o reembolsa uno confirmado.
   *
   * Reglas aprobadas para el MVP:
   * - PENDIENTE → CANCELADO: cualquier rol que registra pagos puede corregir
   *   su captura antes de que caja la confirme.
   * - CONFIRMADO → REEMBOLSADO: solo ADMIN, exige motivo y queda auditado.
   * - Nunca se borra ni se sobrescribe un pago histórico.
   */
  async voidPayment(
    organizationId: string | null,
    actor: PaymentActor,
    paymentId: string,
    dto: VoidPaymentDto = {},
    options: { providerHandled?: boolean } = {},
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
      if (!rolesHavePermission(actor.roles, 'payments:register')) {
        throw new ForbiddenException('No puedes anular pagos');
      }
    } else if (!rolesHavePermission(actor.roles, 'payments:refund')) {
      throw new ForbiddenException('Solo administración puede reembolsar');
    }

    // Primero el proveedor, después la base: si Mercado Pago rechaza o no
    // responde, el pago local sigue como estaba y se puede reintentar. Sin
    // esto, un reembolso local dejaría el dinero cobrado en la cuenta del
    // negocio y la caja cuadrada con datos falsos.
    let providerRefundedAmount: number | null = null;

    if (!options.providerHandled && payment.organizationId) {
      const ref = {
        id: payment.id,
        organizationId: payment.organizationId,
        method: payment.method,
        provider: payment.provider,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        amount: Number(payment.amount) + Number(payment.tipAmount ?? 0),
        currency: 'MXN',
      };
      const handler = this.providers.find(ref);

      if (handler) {
        const result = isPending
          ? handler.cancel
            ? await handler.cancel(ref)
            : { status: 'not_supported' as const, providerStatus: null }
          : await handler.refund(ref);

        if (result.status === 'pending') {
          throw new ServiceUnavailableException(
            'Mercado Pago todavía no confirma la operación. Espera unos segundos y vuelve a intentarlo.',
          );
        }

        if (result.status === 'refunded') {
          const refunded = result.refundedAmount ?? ref.amount;

          if (refunded + 0.01 < ref.amount) {
            await this.prisma.payment.update({
              where: { id: payment.id },
              data: {
                providerStatus: result.providerStatus ?? 'partially_refunded',
                providerStatusDetail:
                  result.detail ?? 'partial_refund_from_pos',
              },
            });

            await this.prisma.auditLog.create({
              data: {
                organizationId,
                userId: actor.id,
                action: 'payment.partial_refund',
                entity: 'Payment',
                entityId: payment.id,
                newValues: {
                  refundedAmount: refunded,
                  expectedAmount: ref.amount,
                  reason,
                },
              },
            });

            throw new ConflictException(
              `Mercado Pago reembolsó ${refunded.toFixed(2)} de ${ref.amount.toFixed(2)}. Revisa el cobro en Mercado Pago.`,
            );
          }

          providerRefundedAmount = refunded;
        }
      }
    }

    const status = isPending
      ? PaymentStatus.CANCELLED
      : PaymentStatus.REFUNDED;

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status,
          reviewRequired: false,
          reviewReason: isPending ? reason : payment.reviewReason,
          ...(providerRefundedAmount !== null
            ? {
                providerStatus: 'refunded',
                providerStatusDetail: 'refunded_from_pos',
              }
            : {}),
        },
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
            providerRefundedAmount,
          },
        },
      });

      return updated;
    });

    await this.splits.recomputeStatus(payment.splitId);

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.paymentVoided,
        organizationId,
        branchId: payment.branchId,
        userId: actor.id,
        orderId: payment.orderId,
        subjectType: 'payment',
        subjectId: paymentId,
        amount: Number(payment.amount),
        metadata: {
          status,
          method: payment.method,
          tipAmount: Number(payment.tipAmount),
          splitId: payment.splitId,
          reason,
        },
      },
    ]);

    return result;
  }

  /**
   * Cierra la cuenta.
   *
   * Requisitos: el total debe estar cubierto por pagos confirmados y no puede
   * haber pagos pendientes. Los tickets de cocina pueden seguir activos: la
   * cuenta se cierra al cobrar y el ticket conserva su propio ciclo.
   */
  async closeOrder(organizationId: string | null, userId: string, orderId: string) {
    const order = await this.getOpenOrder(organizationId, orderId);

    // La cuenta puede cerrarse aunque cocina siga preparando: el cobro ya está
    // completo y el ticket de estación conserva su propio ciclo.

    // Un pago pendiente (incluido el de tarjeta offline) no cubre la cuenta:
    // cerrarla dejaría la mesa libre con un cobro sin confirmar.
    const [pendingCount, pendingSum] = await Promise.all([
      this.prisma.payment.count({
        where: { orderId, status: PaymentStatus.PENDING },
      }),
      this.prisma.payment.aggregate({
        where: { orderId, status: PaymentStatus.PENDING },
        _sum: { amount: true },
      }),
    ]);

    if (pendingCount > 0) {
      const pendingAmount = pendingSum._sum.amount ?? new Prisma.Decimal(0);

      throw new BadRequestException(
        `Hay ${pendingCount} pagos pendientes de confirmar (${pendingAmount.toFixed(2)}). Confírmalos o anúlalos antes de cerrar.`,
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

    this.events.publish({
      type: 'ORDER_CLOSED',
      organizationId,
      branchId: order.branchId,
      orderId,
    });

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
