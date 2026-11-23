import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isRetryableStatus, retry } from '../common/http-retry';

const API_BASE_URL = 'https://api.mercadopago.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

export interface MpPreapproval {
  id: string;
  status: string;
  init_point?: string;
  sandbox_init_point?: string;
  external_reference?: string;
  payer_id?: number;
  payer_email?: string;
  next_payment_date?: string;
  date_created?: string;
  last_modified?: string;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number;
    currency_id?: string;
    start_date?: string;
    end_date?: string;
  };
}

export interface MpAuthorizedPayment {
  id: string | number;
  preapproval_id?: string;
  status?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_created?: string;
  debit_date?: string;
  payment?: {
    id?: number;
    status?: string;
    status_detail?: string;
  };
  payment_method_id?: string;
}

export interface MpAuthorizedPaymentSearch {
  paging?: {
    offset?: number;
    limit?: number;
    total?: number;
  };
  results: MpAuthorizedPayment[];
}

export class BillingProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

/**
 * `true` cuando el fallo puede resolverse reintentando (red, timeout, 429 o
 * 5xx). Mercado Pago debe volver a notificar; no se debe marcar el evento como
 * procesado.
 */
export function isTransientBillingError(error: unknown): boolean {
  if (error instanceof ServiceUnavailableException) return true;
  if (error instanceof BillingProviderError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return false;
}

/**
 * Cliente de la API de Suscripciones de Mercado Pago.
 *
 * Usa el access token de la cuenta de la plataforma (aplicación de billing),
 * nunca el token de un negocio. Los cobros de los negocios viven en el módulo
 * `mercadopago`.
 */
@Injectable()
export class BillingClient {
  private readonly logger = new Logger(BillingClient.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.accessToken());
  }

  /** Entorno declarado en `MP_BILLING_ENVIRONMENT`. Nunca se infiere del token. */
  get environment(): 'test' | 'production' {
    const configured = this.config
      .get<string>('MP_BILLING_ENVIRONMENT')
      ?.trim()
      .toLowerCase();

    return configured === 'test' ? 'test' : 'production';
  }

  get isTestMode(): boolean {
    return this.environment === 'test';
  }

  get webhookSecret(): string {
    return this.config.get<string>('MP_BILLING_WEBHOOK_SECRET') ?? '';
  }

  get webhookMaxSkewSeconds(): number {
    const raw = Number(
      this.config.get<string>('MP_BILLING_WEBHOOK_MAX_SKEW_SECONDS'),
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  createPreapproval(
    payload: unknown,
    idempotencyKey: string,
  ): Promise<MpPreapproval> {
    return this.request<MpPreapproval>('/preapproval', {
      method: 'POST',
      body: payload,
      idempotencyKey,
    });
  }

  updatePreapproval(
    preapprovalId: string,
    payload: unknown,
  ): Promise<MpPreapproval> {
    return this.request<MpPreapproval>(
      `/preapproval/${encodeURIComponent(preapprovalId)}`,
      { method: 'PUT', body: payload },
    );
  }

  getPreapproval(preapprovalId: string): Promise<MpPreapproval> {
    return this.request<MpPreapproval>(
      `/preapproval/${encodeURIComponent(preapprovalId)}`,
    );
  }

  cancelPreapproval(preapprovalId: string): Promise<MpPreapproval> {
    // Mercado Pago usa `cancelled` (doble l) para preapprovals.
    return this.updatePreapproval(preapprovalId, { status: 'cancelled' });
  }

  pausePreapproval(preapprovalId: string): Promise<MpPreapproval> {
    return this.updatePreapproval(preapprovalId, { status: 'paused' });
  }

  resumePreapproval(preapprovalId: string): Promise<MpPreapproval> {
    return this.updatePreapproval(preapprovalId, { status: 'authorized' });
  }

  getAuthorizedPayment(
    authorizedPaymentId: string,
  ): Promise<MpAuthorizedPayment> {
    return this.request<MpAuthorizedPayment>(
      `/authorized_payments/${encodeURIComponent(authorizedPaymentId)}`,
    );
  }

  /**
   * Historial de cobros de una suscripción.
   *
   * Se usa como respaldo cuando un webhook se pierde: el estado real de cada
   * intento de cobro está en esta lista.
   */
  searchAuthorizedPayments(
    preapprovalId: string,
    limit = 100,
  ): Promise<MpAuthorizedPaymentSearch> {
    const query = new URLSearchParams({
      preapproval_id: preapprovalId,
      limit: String(limit),
    });

    return this.request<MpAuthorizedPaymentSearch>(
      `/authorized_payments/search?${query.toString()}`,
    );
  }

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const token = this.accessToken();

    if (!token) {
      throw new ServiceUnavailableException(
        'La facturación con Mercado Pago no está configurada',
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (options.idempotencyKey) {
      headers['x-idempotency-key'] = options.idempotencyKey;
    }

    const method = options.method ?? 'GET';
    const canRetry = method !== 'POST' || Boolean(options.idempotencyKey);

    const execute = async (): Promise<T> => {
      let response: Response;

      try {
        response = await fetch(`${API_BASE_URL}${path}`, {
          method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        this.logger.error(
          `Error de red con suscripciones de Mercado Pago (${path}): ${
            (error as Error).message
          }`,
        );
        throw new ServiceUnavailableException(
          'No se pudo contactar con Mercado Pago. Intenta de nuevo en unos segundos.',
        );
      }

      const text = await response.text();
      const payload = text ? safeJson(text) : null;

      if (!response.ok) {
        const body = payload as
          | {
              message?: string;
              error?: string;
              cause?: Array<{ code?: string; description?: string }>;
            }
          | null;
        const cause = body?.cause?.[0];

        const error = new BillingProviderError(
          response.status,
          cause?.description ??
            body?.message ??
            `Mercado Pago respondió con ${response.status}`,
          cause?.code ?? body?.error,
          payload,
        );

        if (isRetryableStatus(response.status)) {
          throw new RetryableBillingError(error);
        }

        throw error;
      }

      return payload as T;
    };

    try {
      return await retry(execute, {
        attempts: canRetry ? MAX_ATTEMPTS : 1,
        shouldRetry: (error) =>
          error instanceof ServiceUnavailableException ||
          error instanceof RetryableBillingError,
        onRetry: (error, attempt, delay) => {
          this.logger.warn(
            `Reintento ${attempt} de ${method} ${path} en ${delay} ms: ${
              (error as Error).message
            }`,
          );
        },
      });
    } catch (error) {
      if (error instanceof RetryableBillingError) {
        throw error.cause;
      }

      throw error;
    }
  }

  private accessToken(): string {
    return this.config.get<string>('MP_BILLING_ACCESS_TOKEN') ?? '';
  }
}

class RetryableBillingError extends Error {
  constructor(readonly cause: BillingProviderError) {
    super(cause.message);
    this.name = 'RetryableBillingError';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
