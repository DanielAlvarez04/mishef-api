import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { isRetryableStatus } from '../common/http-retry';
import { verifyMercadoPagoSignature } from '../common/webhook-signature';
import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoLinkService } from './mercadopago-link.service';
import { MercadoPagoPointService } from './mercadopago-point.service';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import {
  MercadoPagoApiError,
  MercadoPagoTransportError,
} from './mercadopago.types';

interface WebhookRequest {
  body: unknown;
  headers: {
    signature?: string | string[];
    requestId?: string | string[];
  };
  query: {
    dataId?: string | string[];
    dataIdAlt?: string | string[];
    type?: string | string[];
  };
}

interface WebhookBody {
  action?: string;
  type?: string;
  user_id?: string | number;
  data?: { id?: string | number };
}

const HANDLED_TOPICS = new Set([
  'orders',
  'order',
  'payment',
  'mp-connect',
  'mp_connect',
]);

/**
 * Procesa las notificaciones de Mercado Pago.
 *
 * 1. Verifica la firma HMAC (`x-signature`).
 * 2. Deduplica por `x-request-id`, pero reprocesa eventos que quedaron sin
 *    `processedAt` (reintento legítimo de Mercado Pago).
 * 3. Resuelve el pago local por `providerOrderId` (sin JWT).
 * 4. Relee la order desde MP y aplica el estado (fuente de verdad).
 *
 * Los fallos transitorios se responden con 5xx para que Mercado Pago reintente;
 * los definitivos se guardan con `error` y se responden 200.
 */
@Injectable()
export class MercadoPagoWebhookService {
  private readonly logger = new Logger(MercadoPagoWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
    private readonly point: MercadoPagoPointService,
    private readonly links: MercadoPagoLinkService,
  ) {}

  async handle(request: WebhookRequest) {
    const secret = this.client.webhookSecret;

    if (!secret) {
      throw new ServiceUnavailableException(
        'El webhook de Mercado Pago no está configurado',
      );
    }

    const body = (request.body ?? {}) as WebhookBody;
    const dataId =
      first(request.query.dataId) ??
      first(request.query.dataIdAlt) ??
      (body.data?.id !== undefined ? String(body.data.id) : undefined);
    const topic = first(request.query.type) ?? body.type ?? 'unknown';

    // Sin `data.id` no se puede verificar la firma; no se acepta ningún
    // cambio de estado en ese caso.
    if (!dataId) {
      return { ok: true, ignored: 'missing_data_id' };
    }

    const signature = verifyMercadoPagoSignature({
      secret,
      signature: first(request.headers.signature),
      requestId: first(request.headers.requestId),
      dataId,
      maxSkewSeconds: this.client.webhookMaxSkewSeconds,
    });

    if (!signature.valid) {
      this.logger.warn(
        `Firma de webhook inválida (${signature.reason}) para ${topic} ${dataId}`,
      );
      throw new UnauthorizedException('Firma de Mercado Pago inválida');
    }

    if (!HANDLED_TOPICS.has(topic)) {
      return { ok: true, ignored: `topic_${topic}` };
    }

    const registered = await this.registerEvent({
      requestId: first(request.headers.requestId),
      topic,
      providerOrderId: dataId,
      payload: body,
    });

    if (registered.duplicate) {
      return { ok: true, duplicated: true };
    }

    const event = registered.event;

    try {
      if (topic === 'mp-connect' || topic === 'mp_connect') {
        const result = await this.handleConnectionEvent(body);
        await this.markEvent(event.id, null);
        return { ok: true, ...result };
      }

      if (topic === 'payment') {
        await this.handleLinkPayment(body, dataId);
        await this.markEvent(event.id, null);
        return { ok: true };
      }

      const payment = await this.prisma.payment.findFirst({
        where: { providerOrderId: dataId, provider: 'MERCADO_PAGO' },
        select: { id: true, organizationId: true, provider: true },
      });

      if (!payment || !payment.organizationId) {
        await this.markEvent(event.id, 'payment_not_found');
        return { ok: true, ignored: 'payment_not_found' };
      }

      const accessToken = await this.tokens.getAccessToken(
        payment.organizationId,
      );
      const order = await this.client.getOrder(accessToken, dataId);

      if (
        order.external_reference &&
        order.external_reference !== payment.id
      ) {
        await this.markEvent(event.id, 'external_reference_mismatch');
        return { ok: true, ignored: 'external_reference_mismatch' };
      }

      await this.point.reconcileOrder(
        payment.organizationId,
        payment.id,
        order,
      );

      await this.markEvent(event.id, null);

      return { ok: true };
    } catch (error) {
      await this.markEvent(
        event.id,
        (error as Error).message,
        false,
      );

      if (this.isTransient(error)) {
        throw new ServiceUnavailableException(
          'Mercado Pago no pudo procesar la notificación en este momento',
        );
      }

      this.logger.warn(
        `Webhook de MP procesado con error (${dataId}): ${
          (error as Error).message
        }`,
      );

      // Error definitivo: se marca como procesado para que MP no reintente
      // indefinidamente algo que no va a cambiar.
      await this.markEvent(event.id, (error as Error).message, true);

      return { ok: false };
    }
  }

  /**
   * `mp-connect` avisa cuando el negocio desvincula la aplicación desde
   * Mercado Pago. Sin esto, la conexión local seguiría "ACTIVE" hasta que
   * fallara el refresh del token.
   */
  private async handleConnectionEvent(body: WebhookBody) {
    const action = body.action ?? '';
    const deauthorized = /deauthoriz|unlink|remov|disconnect/i.test(action);

    if (!deauthorized) {
      return { ignored: 'mp_connect_action' };
    }

    const mpUserId =
      body.user_id !== undefined ? String(body.user_id) : undefined;

    if (!mpUserId) {
      return { ignored: 'mp_connect_without_user' };
    }

    const connections = await this.prisma.mercadoPagoConnection.findMany({
      where: { mpUserId },
      select: { organizationId: true },
    });

    for (const connection of connections) {
      await this.prisma.$transaction([
        this.prisma.mercadoPagoConnection.update({
          where: { organizationId: connection.organizationId },
          data: { status: 'REVOKED' },
        }),
        this.prisma.mercadoPagoTerminal.updateMany({
          where: { organizationId: connection.organizationId },
          data: { isActive: false },
        }),
        this.prisma.auditLog.create({
          data: {
            organizationId: connection.organizationId,
            userId: null,
            action: 'mercadopago.disconnected',
            entity: 'MercadoPagoConnection',
            entityId: connection.organizationId,
            newValues: { source: 'mp-connect', mpUserId, action },
          },
        }),
      ]);
    }

    return { revoked: connections.length };
  }

  private async handleLinkPayment(
    body: WebhookBody,
    providerPaymentId: string,
  ): Promise<void> {
    const userId = body.user_id !== undefined ? String(body.user_id) : undefined;

    if (!userId) {
      // Algunas notificaciones no traen user_id; si el pago ya se conoce,
      // se puede resolver por providerPaymentId.
      const known = await this.prisma.payment.findFirst({
        where: { providerPaymentId },
        select: { organizationId: true, id: true },
      });

      if (!known?.organizationId) return;

      const token = await this.tokens.getAccessToken(known.organizationId);
      const providerPayment = await this.client.getPayment(
        token,
        providerPaymentId,
      );

      await this.links.reconcilePayment(
        known.organizationId,
        known.id,
        providerPayment,
      );
      return;
    }

    const connections = await this.prisma.mercadoPagoConnection.findMany({
      where: { mpUserId: userId, status: 'ACTIVE' },
      select: { organizationId: true },
      take: 10,
    });

    let transient: unknown = null;

    for (const connection of connections) {
      try {
        const accessToken = await this.tokens.getAccessToken(
          connection.organizationId,
        );
        const providerPayment = await this.client.getPayment(
          accessToken,
          providerPaymentId,
        );

        if (!providerPayment.external_reference) continue;

        const payment = await this.prisma.payment.findFirst({
          where: {
            id: providerPayment.external_reference,
            organizationId: connection.organizationId,
          },
          select: { id: true },
        });

        if (!payment) continue;

        await this.links.reconcilePayment(
          connection.organizationId,
          payment.id,
          providerPayment,
        );
        return;
      } catch (error) {
        if (this.isTransient(error)) {
          transient = error;
        } else {
          this.logger.warn(
            `No se pudo conciliar el pago ${providerPaymentId}: ${
              (error as Error).message
            }`,
          );
        }
      }
    }

    if (transient) throw transient;
  }

  private isTransient(error: unknown): boolean {
    return (
      error instanceof MercadoPagoTransportError ||
      (error instanceof MercadoPagoApiError && isRetryableStatus(error.status))
    );
  }

  private async registerEvent(params: {
    requestId: string | undefined;
    topic: string;
    providerOrderId: string;
    payload: WebhookBody;
  }): Promise<{
    event: { id: string; processedAt: Date | null };
    duplicate: boolean;
  }> {
    if (params.requestId) {
      const existing = await this.prisma.mercadoPagoWebhookEvent.findUnique({
        where: { requestId: params.requestId },
        select: { id: true, processedAt: true },
      });

      if (existing) {
        // Un evento sin `processedAt` significa que el intento anterior falló
        // de forma transitoria: se vuelve a procesar.
        return { event: existing, duplicate: existing.processedAt !== null };
      }
    }

    try {
      const created = await this.prisma.mercadoPagoWebhookEvent.create({
        data: {
          requestId: params.requestId ?? null,
          topic: params.topic,
          providerOrderId: params.providerOrderId,
          payload: params.payload as Prisma.InputJsonValue,
        },
        select: { id: true, processedAt: true },
      });

      return { event: created, duplicate: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        params.requestId
      ) {
        const existing = await this.prisma.mercadoPagoWebhookEvent.findUnique({
          where: { requestId: params.requestId },
          select: { id: true, processedAt: true },
        });

        if (existing) {
          return {
            event: existing,
            duplicate: existing.processedAt !== null,
          };
        }
      }

      throw error;
    }
  }

  private async markEvent(
    id: string,
    error: string | null,
    processed = true,
  ): Promise<void> {
    await this.prisma.mercadoPagoWebhookEvent.update({
      where: { id },
      data: {
        processedAt: processed ? new Date() : null,
        error: error?.slice(0, 500) ?? null,
      },
    });
  }
}

function first(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
