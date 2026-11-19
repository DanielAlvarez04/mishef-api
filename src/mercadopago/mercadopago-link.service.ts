import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';

import { PaymentsService, type PaymentActor } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { CreatePointChargeDto } from './dto/create-point-charge.dto';
import {
  MercadoPagoApiError,
  MpPayment,
  isAmbiguousProviderError,
} from './mercadopago.types';

const PROVIDER = 'MERCADO_PAGO';
const LINK_TTL_MS = 30 * 60 * 1000;

/**
 * Links de pago de Checkout Pro.
 *
 * El negocio cobra en su propia cuenta de Mercado Pago; el cliente paga en una
 * página hospedada y el webhook `payment` confirma el pago local.
 */
@Injectable()
export class MercadoPagoLinkService {
  private readonly logger = new Logger(MercadoPagoLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  async createLink(
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

    if (!order) throw new NotFoundException('Cuenta no encontrada');
    if (order.status !== 'OPEN') {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    await this.expireStaleLinks(organizationId, orderId);

    const registered = await this.payments.register(
      organizationId,
      userId,
      orderId,
      {
        method: PaymentMethod.MERCADO_PAGO_LINK,
        amount: dto.amount,
        tipAmount: dto.tipAmount,
        tipPercent: dto.tipPercent,
        tipSource: dto.tipSource,
        tipBaseAmount: dto.tipBaseAmount,
        splitId: dto.splitId,
        idempotencyKey: dto.idempotencyKey,
      },
      { paidAt: null },
    );

    const payment = registered as typeof registered & {
      duplicated?: boolean;
    };

    if (payment.duplicated) {
      if (payment.providerCheckoutUrl || payment.status !== PaymentStatus.PENDING) {
        return this.prisma.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
      }
    }

    const [organization, accessToken] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { currency: true, name: true },
      }),
      this.tokens.getAccessToken(organizationId),
    ]);

    const total = Number(payment.amount) + Number(payment.tipAmount ?? 0);
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');

    const label = order.tableNumber
      ? `Mesa ${order.tableNumber}`
      : order.isTakeaway
        ? 'Para llevar'
        : `Cuenta ${order.id.slice(-6)}`;

    try {
      const preference = await this.client.createPreference(
        accessToken,
        {
          items: [
            {
              id: payment.id,
              title: `${organization.name} · ${label}`.slice(0, 120),
              description: 'Consumo en Mishef',
              quantity: 1,
              currency_id: organization.currency,
              unit_price: Number(total.toFixed(2)),
            },
          ],
          external_reference: payment.id,
          statement_descriptor: 'MISHEF',
          expires: true,
          expiration_date_to: expiresAt.toISOString(),
          back_urls: {
            success: `${webOrigin}/pos`,
            pending: `${webOrigin}/pos`,
            failure: `${webOrigin}/pos`,
          },
          auto_return: 'approved',
          metadata: {
            organizationId,
            orderId,
            paymentId: payment.id,
          },
        },
        payment.id,
      );

      const checkoutUrl = this.client.isTestMode
        ? preference.sandbox_init_point ?? preference.init_point
        : preference.init_point;

      if (!checkoutUrl) {
        throw new BadRequestException(
          'Mercado Pago no devolvió el link de pago',
        );
      }

      return this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          provider: PROVIDER,
          providerPreferenceId: preference.id,
          providerCheckoutUrl: checkoutUrl,
          providerStatus: 'pending',
          providerStatusDetail: 'link_created',
          expiresAt,
          providerData: toJson(preference),
        },
      });
    } catch (error) {
      const message = providerMessage(error);

      // Timeout o 5xx: la preferencia pudo crearse. No se cancela el pago
      // local; el reintento con la misma idempotency key devuelve la misma
      // preferencia y el webhook la concilia.
      if (isAmbiguousProviderError(error)) {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            provider: PROVIDER,
            providerStatus: 'create_unknown',
            providerStatusDetail: message.slice(0, 200),
            expiresAt,
          },
        });

        throw new ServiceUnavailableException(
          'No sabemos si Mercado Pago creó el link. Vuelve a intentarlo con el mismo cobro: si ya existe, se reutiliza.',
        );
      }

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CANCELLED,
          provider: PROVIDER,
          providerStatus: 'create_failed',
          providerStatusDetail: message.slice(0, 200),
        },
      });

      throw new BadRequestException(
        `No se pudo crear el link de pago: ${message}`,
      );
    }
  }

  async syncPayment(organizationId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (payment.provider !== PROVIDER) {
      throw new BadRequestException('El pago no es de Mercado Pago');
    }

    const accessToken = await this.tokens.getAccessToken(organizationId);

    if (payment.providerPaymentId) {
      const providerPayment = await this.client.getPayment(
        accessToken,
        payment.providerPaymentId,
      );
      await this.reconcilePayment(organizationId, payment.id, providerPayment);
    } else {
      const search = await this.client.searchPayments(accessToken, payment.id);
      const latest = search.results?.[0];

      if (latest) {
        await this.reconcilePayment(organizationId, payment.id, latest);
      }
    }

    return this.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
  }

  async cancelLink(
    organizationId: string,
    actor: PaymentActor,
    paymentId: string,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException('Solo se puede cancelar un link pendiente');
    }

    return this.payments.voidPayment(organizationId, actor, paymentId, {
      reason: 'Link de pago cancelado desde el POS',
    });
  }

  /** Aplica el estado de un pago de Checkout Pro al pago local. */
  async reconcilePayment(
    organizationId: string,
    paymentId: string,
    providerPayment: MpPayment,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
    });

    if (!payment) return;
    if (payment.provider !== PROVIDER) return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: String(providerPayment.id),
        providerStatus: providerPayment.status,
        providerStatusDetail: providerPayment.status_detail ?? null,
        providerData: toJson(providerPayment),
      },
    });

    if (providerPayment.status === 'approved') {
      await this.payments.confirmByProvider(organizationId, payment.id, {
        paidAt: providerPayment.date_approved
          ? new Date(providerPayment.date_approved)
          : undefined,
        providerStatus: providerPayment.status_detail ?? undefined,
      });

      // Reembolso parcial: el cobro sigue confirmado por el resto, pero se
      // deja auditoría la primera vez que se detecta.
      const partial =
        providerPayment.status_detail === 'partially_refunded' ||
        (providerPayment.transaction_amount_refunded ?? 0) > 0;

      if (
        partial &&
        payment.providerStatusDetail !== 'partially_refunded'
      ) {
        await this.prisma.auditLog.create({
          data: {
            organizationId,
            userId: null,
            action: 'payment.partial_refund',
            entity: 'Payment',
            entityId: payment.id,
            newValues: {
              source: 'mercado_pago_link',
              providerStatus: providerPayment.status,
              providerStatusDetail: providerPayment.status_detail ?? null,
              refundedAmount: providerPayment.transaction_amount_refunded ?? null,
            },
          },
        });
      }

      return;
    }

    if (
      ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(
        providerPayment.status,
      )
    ) {
      if (
        providerPayment.status === 'refunded' ||
        providerPayment.status === 'charged_back'
      ) {
        const updated = await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.CONFIRMED },
          data: { status: PaymentStatus.REFUNDED },
        });

        if (updated.count > 0) {
          await this.prisma.auditLog.create({
            data: {
              organizationId,
              userId: null,
              action:
                providerPayment.status === 'charged_back'
                  ? 'payment.chargeback'
                  : 'payment.refunded',
              entity: 'Payment',
              entityId: payment.id,
              newValues: {
                source: 'mercado_pago_link',
                providerStatus: providerPayment.status,
                providerStatusDetail:
                  providerPayment.status_detail ?? null,
                refundedAmount: providerPayment.transaction_amount_refunded ?? null,
              },
            },
          });
        }

        return;
      }

      const updated = await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.CANCELLED,
          providerStatus: providerPayment.status,
          providerStatusDetail: providerPayment.status_detail ?? null,
        },
      });

      if (updated.count > 0) {
        await this.prisma.auditLog.create({
          data: {
            organizationId,
            userId: null,
            action: 'payment.cancelled',
            entity: 'Payment',
            entityId: payment.id,
            newValues: {
              source: 'mercado_pago_link',
              providerStatus: providerPayment.status,
              providerStatusDetail: providerPayment.status_detail ?? null,
            },
          },
        });
      }
    }
  }

  private async expireStaleLinks(organizationId: string, orderId: string) {
    const stale = await this.prisma.payment.findMany({
      where: {
        organizationId,
        orderId,
        status: PaymentStatus.PENDING,
        provider: PROVIDER,
        expiresAt: { lt: new Date() },
        OR: [
          { providerPreferenceId: { not: null } },
          // La preferencia pudo crearse aunque la respuesta se perdiera.
          { providerStatus: 'create_unknown' },
        ],
      },
      select: { id: true },
    });

    if (stale.length === 0) return;

    for (const payment of stale) {
      try {
        await this.syncPayment(organizationId, payment.id);
      } catch {
        // Si MP no responde, se libera localmente: el link ya expiró.
      }

      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.CANCELLED,
          providerStatusDetail: 'link_expired',
        },
      });
    }
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function providerMessage(error: unknown): string {
  if (error instanceof MercadoPagoApiError) return error.message;
  return error instanceof Error
    ? error.message
    : 'error desconocido de Mercado Pago';
}
