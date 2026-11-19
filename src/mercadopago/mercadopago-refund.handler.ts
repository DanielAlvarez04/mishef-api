import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';

import {
  ProviderPaymentHandler,
  ProviderPaymentRef,
  ProviderPaymentRegistry,
  type ProviderPaymentResult,
} from '../payments/provider-payment.registry';
import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import {
  MercadoPagoApiError,
  MercadoPagoTransportError,
} from './mercadopago.types';

const PROVIDER = 'MERCADO_PAGO';

/**
 * Reembolsos y cancelaciones en Mercado Pago antes de tocar la base.
 *
 * Cubre los dos flujos del negocio:
 * - Link de Checkout Pro: `POST /v1/payments/{id}/refunds`.
 * - Terminal Point: `POST /v1/orders/{id}/refund` (o `/cancel` si sigue
 *   pendiente).
 *
 * Se registra en `ProviderPaymentRegistry` al arrancar para que
 * `PaymentsService` no dependa del módulo `mercadopago`.
 */
@Injectable()
export class MercadoPagoRefundHandler
  implements ProviderPaymentHandler, OnModuleInit
{
  readonly provider = PROVIDER;

  private readonly logger = new Logger(MercadoPagoRefundHandler.name);

  constructor(
    private readonly registry: ProviderPaymentRegistry,
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(payment: ProviderPaymentRef): boolean {
    return (
      payment.provider === PROVIDER &&
      (payment.method === PaymentMethod.MERCADO_PAGO_LINK ||
        payment.method === PaymentMethod.MERCADO_PAGO_POINT)
    );
  }

  async refund(payment: ProviderPaymentRef): Promise<ProviderPaymentResult> {
    if (!payment.organizationId) {
      throw new ServiceUnavailableException(
        'El pago no pertenece a un negocio; no se puede reembolsar en Mercado Pago',
      );
    }

    const accessToken = await this.tokens.getAccessToken(
      payment.organizationId,
    );

    try {
      if (payment.method === PaymentMethod.MERCADO_PAGO_LINK) {
        return await this.refundLink(payment, accessToken);
      }

      return await this.refundPoint(payment, accessToken);
    } catch (error) {
      throw this.translate(error, 'reembolsar');
    }
  }

  async cancel(payment: ProviderPaymentRef): Promise<ProviderPaymentResult> {
    // Un link de Checkout Pro no se puede desactivar por API: expira con
    // `expiration_date_to`. Si el cliente lo paga antes, el webhook lo
    // reconcilia y el pago se registra igual.
    if (payment.method === PaymentMethod.MERCADO_PAGO_LINK) {
      return { status: 'not_supported', providerStatus: 'link_pending' };
    }

    if (!payment.organizationId) {
      throw new ServiceUnavailableException(
        'El pago no pertenece a un negocio; no se puede cancelar en Mercado Pago',
      );
    }

    if (!payment.providerOrderId) {
      // La order nunca llegó a Mercado Pago: se puede anular localmente.
      return { status: 'not_supported', providerStatus: 'local_only' };
    }

    const accessToken = await this.tokens.getAccessToken(
      payment.organizationId,
    );

    try {
      const order = await this.client.cancelOrder(
        accessToken,
        payment.providerOrderId,
      );

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerStatus: order.status,
          providerStatusDetail: order.status_detail ?? null,
          providerData: order as unknown as object,
        },
      });

      if (order.status !== 'canceled' && order.status !== 'expired') {
        return {
          status: 'pending',
          providerStatus: order.status,
          detail: order.status_detail ?? null,
        };
      }

      return {
        status: 'not_supported',
        providerStatus: order.status,
        detail: order.status_detail ?? null,
      };
    } catch (error) {
      throw this.translate(error, 'cancelar');
    }
  }

  private async refundLink(
    payment: ProviderPaymentRef,
    accessToken: string,
  ): Promise<ProviderPaymentResult> {
    if (!payment.providerPaymentId) {
      throw new BadRequestException(
        'El link aún no tiene un pago aprobado en Mercado Pago. Anúlalo en lugar de reembolsarlo.',
      );
    }

    const refund = await this.client.refundPayment(
      accessToken,
      payment.providerPaymentId,
    );

    const refunded =
      typeof refund.amount === 'number' ? refund.amount : payment.amount;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerStatus: 'refunded',
        providerStatusDetail: refund.status ?? 'refunded',
        providerData: refund as unknown as object,
      },
    });

    return {
      status: 'refunded',
      providerStatus: 'refunded',
      detail: refund.status ?? null,
      refundedAmount: refunded,
    };
  }

  private async refundPoint(
    payment: ProviderPaymentRef,
    accessToken: string,
  ): Promise<ProviderPaymentResult> {
    if (!payment.providerOrderId) {
      throw new BadRequestException(
        'El cobro no tiene una order de Mercado Pago asociada.',
      );
    }

    let order;

    try {
      order = await this.client.refundOrder(
        accessToken,
        payment.providerOrderId,
      );
    } catch (error) {
      // Repetir un reembolso ya aplicado no debe fallar en la caja.
      if (error instanceof MercadoPagoApiError && /refunded/i.test(error.message)) {
        return {
          status: 'refunded',
          providerStatus: 'refunded',
          refundedAmount: payment.amount,
        };
      }
      throw error;
    }

    const providerPayment = order.transactions?.payments?.[0];
    const detail = order.status_detail ?? providerPayment?.status_detail ?? null;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerStatus: order.status,
        providerStatusDetail: detail,
        providerData: order as unknown as object,
      },
    });

    if (order.status === 'refunded' || detail === 'refunded') {
      return {
        status: 'refunded',
        providerStatus: order.status,
        detail,
        refundedAmount: providerPayment?.amount
          ? Number(providerPayment.amount)
          : payment.amount,
      };
    }

    if (detail === 'partially_refunded') {
      const refunded = providerPayment?.amount
        ? Number(providerPayment.amount)
        : 0;
      return {
        status: 'refunded',
        providerStatus: order.status,
        detail,
        refundedAmount: refunded,
      };
    }

    return {
      status: 'pending',
      providerStatus: order.status,
      detail,
    };
  }

  private translate(error: unknown, action: string): Error {
    if (error instanceof MercadoPagoTransportError) {
      this.logger.warn(
        `Timeout al ${action} en Mercado Pago (${error.path}): ${error.message}`,
      );
      return new ServiceUnavailableException(
        `No se pudo contactar con Mercado Pago para ${action} el cobro. El pago no cambió; vuelve a intentarlo.`,
      );
    }

    if (error instanceof MercadoPagoApiError) {
      this.logger.warn(
        `Mercado Pago rechazó ${action} (${error.status} ${error.code ?? ''}): ${
          error.message
        }`,
      );

      if (error.status >= 500 || error.status === 429) {
        return new ServiceUnavailableException(
          `Mercado Pago no pudo ${action} el cobro en este momento. El pago no cambió; vuelve a intentarlo.`,
        );
      }

      return new BadRequestException(
        `Mercado Pago rechazó ${action} el cobro: ${error.message}`,
      );
    }

    return error instanceof Error
      ? error
      : new ServiceUnavailableException(
          `No se pudo ${action} el cobro en Mercado Pago.`,
        );
  }
}
