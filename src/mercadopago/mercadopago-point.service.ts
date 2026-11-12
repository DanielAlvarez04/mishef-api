import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

import { PaymentsService, type PaymentActor } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { MercadoPagoApiError, MpOrder } from './mercadopago.types';
import { CreatePointChargeDto } from './dto/create-point-charge.dto';

const PROVIDER = 'MERCADO_PAGO';
const ORDER_TTL_MS = 5 * 60 * 1000;
const ACTIVE_ORDER_STATUSES = ['created', 'at_terminal', 'action_required'];

export interface PointConfig {
  enabled: boolean;
  terminals: Array<{
    id: string;
    name: string | null;
    branchId: string | null;
    isDefault: boolean;
  }>;
}

/**
 * Cobros con terminal Point sobre la Orders API.
 *
 * Crea el pago local PENDING, envía la order a MP con el id del pago como
 * `external_reference` y clave de idempotencia, y reconcilia el estado cuando
 * el webhook o el polling lo piden.
 */
@Injectable()
export class MercadoPagoPointService {
  private readonly logger = new Logger(MercadoPagoPointService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  async getPointConfig(organizationId: string): Promise<PointConfig> {
    const connection = await this.prisma.mercadoPagoConnection.findUnique({
      where: { organizationId },
      select: { status: true, expiresAt: true },
    });

    if (
      !connection ||
      connection.status !== 'ACTIVE' ||
      connection.expiresAt.getTime() <= Date.now()
    ) {
      return { enabled: false, terminals: [] };
    }

    const terminals = await this.prisma.mercadoPagoTerminal.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    const usable = terminals.filter(
      (terminal) => terminal.operatingMode !== 'SELF_SERVICE',
    );

    return {
      enabled: usable.length > 0,
      terminals: usable.map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        branchId: terminal.branchId,
        isDefault: terminal.isDefault,
      })),
    };
  }

  async createCharge(
    organizationId: string,
    userId: string,
    orderId: string,
    dto: CreatePointChargeDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        id: true,
        status: true,
        tableNumber: true,
        isTakeaway: true,
        branchId: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Cuenta no encontrada');
    }

    if (order.status !== 'OPEN') {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    // Libera el saldo de cobros anteriores que ya expiraron en la terminal.
    await this.expireStaleCharges(organizationId, orderId);

    const terminal = await this.resolveTerminal(
      organizationId,
      dto.terminalId,
      order.branchId,
    );

    const registered = await this.payments.register(
      organizationId,
      userId,
      orderId,
      {
        method: PaymentMethod.MERCADO_PAGO_POINT,
        amount: dto.amount,
        idempotencyKey: dto.idempotencyKey,
      },
      { paidAt: null, pointCharge: true },
    );

    const payment = registered as typeof registered & {
      duplicated?: boolean;
    };

    // Reintento idempotente: si ya tiene order en MP (o ya terminó), no se
    // crea otro cobro.
    if (payment.duplicated) {
      if (payment.providerOrderId || payment.status !== PaymentStatus.PENDING) {
        return this.prisma.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
      }
    }

    const accessToken = await this.tokens.getAccessToken(organizationId);

    try {
      const mpOrder = await this.client.createOrder(
        accessToken,
        this.buildOrderPayload(payment, order, terminal.terminalId),
        payment.id,
      );

      return this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          provider: PROVIDER,
          providerOrderId: mpOrder.id,
          providerPaymentId:
            mpOrder.transactions?.payments?.[0]?.id ?? null,
          providerStatus: mpOrder.status,
          providerStatusDetail: mpOrder.status_detail ?? null,
          terminalId: terminal.terminalId,
          expiresAt: new Date(Date.now() + ORDER_TTL_MS),
          providerData: toJson(mpOrder),
        },
      });
    } catch (error) {
      const message = providerMessage(error);

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CANCELLED,
          provider: PROVIDER,
          providerStatus: 'create_failed',
          providerStatusDetail: message.slice(0, 200),
          terminalId: terminal.terminalId,
        },
      });

      throw new BadRequestException(
        `No se pudo enviar el cobro a la terminal: ${message}`,
      );
    }
  }

  /** Consulta MP y aplica el estado al pago local (fallback del webhook). */
  async syncPayment(organizationId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }

    if (payment.provider !== PROVIDER || !payment.providerOrderId) {
      throw new BadRequestException(
        'El pago no es un cobro de Mercado Pago',
      );
    }

    const accessToken = await this.tokens.getAccessToken(organizationId);
    const order = await this.client.getOrder(
      accessToken,
      payment.providerOrderId,
    );

    await this.reconcileOrder(organizationId, payment.id, order);

    return this.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
  }

  async cancelCharge(
    organizationId: string,
    actor: PaymentActor,
    paymentId: string,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        'Solo se puede cancelar un cobro pendiente',
      );
    }

    if (payment.provider === PROVIDER && payment.providerOrderId) {
      const accessToken = await this.tokens.getAccessToken(organizationId);

      try {
        const canceled = await this.client.cancelOrder(
          accessToken,
          payment.providerOrderId,
        );

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            providerStatus: canceled.status,
            providerStatusDetail: canceled.status_detail ?? null,
            providerData: toJson(canceled),
          },
        });

        // La cancelación puede quedar pendiente en la terminal; en ese caso
        // no se anula el pago local hasta que MP confirme.
        if (canceled.status !== 'canceled') {
          return this.prisma.payment.findUniqueOrThrow({
            where: { id: payment.id },
          });
        }
      } catch (error) {
        throw new BadRequestException(
          `No se pudo cancelar en la terminal: ${providerMessage(error)}`,
        );
      }
    }

    return this.payments.voidPayment(
      organizationId,
      actor,
      paymentId,
      { reason: 'Cancelado desde el punto de venta' },
    );
  }

  /**
   * Aplica el estado de una order de MP al pago local.
   *
   * Es idempotente y lo usan tanto el polling como el webhook (Fase 4).
   */
  async reconcileOrder(
    organizationId: string,
    paymentId: string,
    order: MpOrder,
  ): Promise<void> {
    const providerPayment = order.transactions?.payments?.[0];
    const status = order.status;
    const detail = order.status_detail ?? null;

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        provider: PROVIDER,
        providerOrderId: order.id,
        providerPaymentId: providerPayment?.id ?? undefined,
        providerStatus: status,
        providerStatusDetail: detail,
        providerData: toJson(order),
      },
    });

    if (status === 'processed' && detail !== 'partially_refunded') {
      await this.payments.confirmByProvider(organizationId, paymentId, {
        paidAt: providerPayment?.date_approved
          ? new Date(providerPayment.date_approved)
          : undefined,
        providerStatus: detail ?? undefined,
      });
      return;
    }

    if (status === 'refunded') {
      await this.markRefunded(organizationId, paymentId);
      return;
    }

    if (['failed', 'canceled', 'expired'].includes(status)) {
      const updated = await this.prisma.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.CANCELLED,
          providerStatusDetail: detail,
        },
      });

      if (updated.count > 0) {
        await this.prisma.auditLog.create({
          data: {
            organizationId,
            userId: null,
            action: 'payment.cancelled',
            entity: 'Payment',
            entityId: paymentId,
            newValues: {
              source: 'mercado_pago',
              providerStatus: status,
              providerStatusDetail: detail,
            },
          },
        });
      }
    }

    // created / at_terminal / action_required: sigue pendiente.
  }

  /**
   * Marca como cancelados los cobros PENDING cuyo `expiresAt` ya pasó para
   * liberar el saldo de la cuenta. Si MP responde, se concilia primero.
   */
  private async expireStaleCharges(
    organizationId: string,
    orderId: string,
  ): Promise<void> {
    const stale = await this.prisma.payment.findMany({
      where: {
        organizationId,
        orderId,
        status: PaymentStatus.PENDING,
        provider: PROVIDER,
        expiresAt: { lt: new Date() },
      },
      select: { id: true, providerOrderId: true },
    });

    if (stale.length === 0) return;

    const accessToken = await this.tokens.getAccessToken(organizationId);

    for (const payment of stale) {
      if (payment.providerOrderId) {
        try {
          const order = await this.client.getOrder(
            accessToken,
            payment.providerOrderId,
          );
          await this.reconcileOrder(organizationId, payment.id, order);

          const current = await this.prisma.payment.findUnique({
            where: { id: payment.id },
            select: { status: true },
          });

          if (current?.status !== PaymentStatus.PENDING) continue;
        } catch {
          // Si MP no responde, se libera localmente: el cobro ya expiró.
        }
      }

      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.CANCELLED,
          providerStatusDetail: 'expired',
        },
      });
    }
  }

  private async markRefunded(
    organizationId: string,
    paymentId: string,
  ): Promise<void> {    const updated = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.CONFIRMED },
      data: { status: PaymentStatus.REFUNDED },
    });

    if (updated.count > 0) {
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          userId: null,
          action: 'payment.refunded',
          entity: 'Payment',
          entityId: paymentId,
          newValues: { source: 'mercado_pago' },
        },
      });
    }
  }

  private async resolveTerminal(
    organizationId: string,
    terminalId: string | undefined,
    branchId: string | null,
  ) {
    const terminals = await this.prisma.mercadoPagoTerminal.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    const usable = terminals.filter(
      (terminal) => terminal.operatingMode !== 'SELF_SERVICE',
    );

    if (usable.length === 0) {
      throw new BadRequestException(
        'No hay una terminal Point disponible. Configúrala en Configuración → Pagos.',
      );
    }

    const terminal = terminalId
      ? usable.find((candidate) => candidate.id === terminalId)
      : (usable.find(
          (candidate) =>
            (!branchId || !candidate.branchId || candidate.branchId === branchId) &&
            candidate.isDefault,
        ) ??
        usable.find(
          (candidate) =>
            !branchId || !candidate.branchId || candidate.branchId === branchId,
        ));

    if (!terminal) {
      throw new BadRequestException(
        'La terminal seleccionada no está disponible',
      );
    }

    if (
      branchId &&
      terminal.branchId &&
      terminal.branchId !== branchId
    ) {
      throw new BadRequestException(
        'La terminal pertenece a otra sucursal',
      );
    }

    return terminal;
  }

  private buildOrderPayload(
    payment: { id: string; amount: Prisma.Decimal },
    order: {
      id: string;
      tableNumber: string | null;
      isTakeaway: boolean;
    },
    terminalId: string,
  ) {
    const platformId = this.config.get<string>('MP_PLATFORM_ID');
    const integratorId = this.config.get<string>('MP_INTEGRATOR_ID');
    const sponsorId = this.config.get<string>('MP_SPONSOR_ID');

    const label = order.tableNumber
      ? `Mesa ${order.tableNumber}`
      : order.isTakeaway
        ? 'Para llevar'
        : `Cuenta ${order.id.slice(-6)}`;

    return {
      type: 'point',
      external_reference: payment.id,
      expiration_time: 'PT5M',
      description: `Naranja Pimienta · ${label}`.slice(0, 120),
      transactions: {
        payments: [{ amount: payment.amount.toFixed(2) }],
      },
      config: {
        point: {
          terminal_id: terminalId,
          print_on_terminal: 'no_ticket',
        },
      },
      ...(platformId || integratorId || sponsorId
        ? {
            integration_data: {
              ...(platformId ? { platform_id: platformId } : {}),
              ...(integratorId ? { integrator_id: integratorId } : {}),
              ...(sponsorId ? { sponsor: { id: sponsorId } } : {}),
            },
          }
        : {}),
    };
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function providerMessage(error: unknown): string {
  if (error instanceof MercadoPagoApiError) {
    if (error.code === 'already_queued_order_for_terminal') {
      return 'la terminal ya tiene otro cobro pendiente';
    }

    if (error.code === 'forbidden_checking_terminal_owner') {
      return 'la terminal no pertenece a esta cuenta de Mercado Pago';
    }

    return error.message;
  }

  return error instanceof Error
    ? error.message
    : 'error desconocido de Mercado Pago';
}
