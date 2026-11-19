import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';

export interface ProviderPaymentRef {
  id: string;
  organizationId: string | null;
  method: PaymentMethod;
  provider: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  /** Importe cobrado (venta + propina). */
  amount: number;
  currency: string;
}

export interface ProviderPaymentResult {
  /**
   * `refunded`: el proveedor confirmó el reembolso total.
   * `pending`: el proveedor aceptó la solicitud pero aún no la confirma.
   * `not_supported`: no hay operación remota que hacer.
   */
  status: 'refunded' | 'pending' | 'not_supported';
  providerStatus: string | null;
  detail?: string | null;
  /** Importe reembolsado según el proveedor, si lo informa. */
  refundedAmount?: number | null;
}

/**
 * Punto de extensión para que un módulo de proveedor de pagos (Mercado Pago)
 * reembolse o cancele antes de tocar la base.
 *
 * Vive en `payments` para que `PaymentsService` no dependa del módulo de
 * Mercado Pago: el proveedor se registra al arrancar y no hay dependencia
 * circular entre módulos.
 */
export interface ProviderPaymentHandler {
  readonly provider: string;
  supports(payment: ProviderPaymentRef): boolean;
  refund(payment: ProviderPaymentRef): Promise<ProviderPaymentResult>;
  cancel?(payment: ProviderPaymentRef): Promise<ProviderPaymentResult>;
}

@Injectable()
export class ProviderPaymentRegistry {
  private readonly logger = new Logger(ProviderPaymentRegistry.name);
  private readonly handlers: ProviderPaymentHandler[] = [];

  register(handler: ProviderPaymentHandler): void {
    this.handlers.push(handler);
    this.logger.log(
      `Proveedor de pagos registrado para reembolsos: ${handler.provider}`,
    );
  }

  find(payment: ProviderPaymentRef): ProviderPaymentHandler | null {
    return (
      this.handlers.find(
        (handler) =>
          handler.provider === payment.provider && handler.supports(payment),
      ) ?? null
    );
  }
}
