import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoPointService } from './mercadopago-point.service';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { MercadoPagoApiError } from './mercadopago.types';

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
  data?: { id?: string | number };
}

/**
 * Procesa las notificaciones `orders` de Mercado Pago.
 *
 * 1. Verifica la firma HMAC (`x-signature`).
 * 2. Deduplica por `x-request-id`.
 * 3. Resuelve el pago local por `providerOrderId` (sin JWT).
 * 4. Relee la order desde MP y aplica el estado (fuente de verdad).
 */
@Injectable()
export class MercadoPagoWebhookService {
  private readonly logger = new Logger(MercadoPagoWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
    private readonly point: MercadoPagoPointService,
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

    this.verifySignature({
      secret,
      signature: first(request.headers.signature),
      requestId: first(request.headers.requestId),
      dataId,
    });

    if (!dataId) {
      return { ok: true, ignored: 'missing_data_id' };
    }

    if (topic !== 'orders') {
      return { ok: true, ignored: `topic_${topic}` };
    }

    const event = await this.registerEvent({
      requestId: first(request.headers.requestId),
      topic,
      providerOrderId: dataId,
      payload: body,
    });

    if (!event) {
      return { ok: true, duplicated: true };
    }

    try {
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
      await this.markEvent(event.id, (error as Error).message);

      // Errores transitorios: se devuelve 500 para que MP reintente.
      if (
        error instanceof ServiceUnavailableException ||
        (error instanceof MercadoPagoApiError && error.status >= 500)
      ) {
        throw error;
      }

      this.logger.warn(
        `Webhook de MP procesado con error (${dataId}): ${
          (error as Error).message
        }`,
      );

      return { ok: false, error: (error as Error).message };
    }
  }

  private verifySignature(params: {
    secret: string;
    signature: string | undefined;
    requestId: string | undefined;
    dataId: string | undefined;
  }): void {
    const { secret, signature, requestId, dataId } = params;

    if (!signature || !requestId || !dataId) {
      throw new UnauthorizedException(
        'Notificación de Mercado Pago sin firma completa',
      );
    }

    const values = new Map(
      signature
        .split(',')
        .map((part) => part.split('='))
        .filter((pair): pair is [string, string] => pair.length === 2),
    );

    const ts = values.get('ts');
    const received = values.get('v1');

    if (!ts || !received) {
      throw new UnauthorizedException('Firma de Mercado Pago inválida');
    }

    // Algunos ejemplos oficiales normalizan `data.id` a minúsculas; se aceptan
    // ambas variantes para no depender del caso exacto del id de la order.
    const manifests = new Set([
      `id:${dataId};request-id:${requestId};ts:${ts};`,
      `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`,
    ]);

    const valid = [...manifests].some((candidate) => {
      const expected = createHmac('sha256', secret)
        .update(candidate)
        .digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(received);

      return a.length === b.length && timingSafeEqual(a, b);
    });

    if (!valid) {
      throw new UnauthorizedException('Firma de Mercado Pago inválida');
    }
  }

  private async registerEvent(params: {
    requestId: string | undefined;
    topic: string;
    providerOrderId: string;
    payload: WebhookBody;
  }) {
    try {
      return await this.prisma.mercadoPagoWebhookEvent.create({
        data: {
          requestId: params.requestId ?? null,
          topic: params.topic,
          providerOrderId: params.providerOrderId,
          payload: params.payload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null;
      }

      throw error;
    }
  }

  private async markEvent(id: string, error: string | null): Promise<void> {
    await this.prisma.mercadoPagoWebhookEvent.update({
      where: { id },
      data: { processedAt: new Date(), error: error?.slice(0, 500) ?? null },
    });
  }
}

function first(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
