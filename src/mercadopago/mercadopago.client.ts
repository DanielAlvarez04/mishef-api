import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isRetryableStatus, retry } from '../common/http-retry';
import {
  MercadoPagoApiError,
  MercadoPagoApiErrorBody,
  MercadoPagoTransportError,
  MpOrder,
  MpPayment,
  MpPaymentsSearch,
  MpPreference,
  MpPrintAction,
  MpRefund,
  MpTerminal,
  MpTerminalsResponse,
  MpTokenResponse,
  MpUser,
} from './mercadopago.types';

const API_BASE_URL = 'https://api.mercadopago.com';
const AUTHORIZE_URL = 'https://auth.mercadopago.com/authorization';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  accessToken?: string;
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
  /** Tiempo máximo por intento; se usa en sincronizaciones en segundo plano. */
  timeoutMs?: number;
  /** Número máximo de intentos; 1 evita bloquear una carga de página. */
  attempts?: number;
}

/**
 * Cliente HTTP mínimo de Mercado Pago (sin SDK oficial).
 *
 * Cubre OAuth, terminales, orders, preferencias y reembolsos. Los fallos de red
 * se traducen a `MercadoPagoTransportError` (resultado desconocido) y los
 * errores HTTP a `MercadoPagoApiError`, para que los servicios puedan decidir
 * si cancelan, reintentan o concilian.
 */
@Injectable()
export class MercadoPagoClient {
  private readonly logger = new Logger(MercadoPagoClient.name);

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(
      this.clientId() && this.clientSecret() && this.redirectUri(),
    );
  }

  /** Entorno declarado en `MP_ENVIRONMENT`. Nunca se infiere del token. */
  get environment(): 'test' | 'production' {
    const configured = this.config
      .get<string>('MP_ENVIRONMENT')
      ?.trim()
      .toLowerCase();

    return configured === 'test' ? 'test' : 'production';
  }

  get isTestMode(): boolean {
    return this.environment === 'test';
  }

  get usesPkce(): boolean {
    const raw = this.config
      .get<string>('MP_OAUTH_PKCE')
      ?.trim()
      .toLowerCase();

    return raw === 'true' || raw === '1';
  }

  get webhookSecret(): string {
    return this.config.get<string>('MP_WEBHOOK_SECRET') ?? '';
  }

  get webhookMaxSkewSeconds(): number {
    const raw = Number(this.config.get<string>('MP_WEBHOOK_MAX_SKEW_SECONDS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  authorizationUrl(state: string, codeChallenge?: string): string {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'La integración con Mercado Pago no está configurada',
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId(),
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: this.redirectUri(),
    });

    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  exchangeCode(
    code: string,
    codeVerifier?: string,
  ): Promise<MpTokenResponse> {
    return this.request<MpTokenResponse>('/oauth/token', {
      method: 'POST',
      body: {
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(),
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      },
    });
  }

  refresh(refreshToken: string): Promise<MpTokenResponse> {
    return this.request<MpTokenResponse>('/oauth/token', {
      method: 'POST',
      body: {
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
  }

  /** Revoca el token del negocio (best-effort al desconectar). */
  async revoke(accessToken: string): Promise<void> {
    try {
      await this.request('/oauth/token', {
        method: 'DELETE',
        accessToken,
        query: { access_token: accessToken },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo revocar el token de Mercado Pago: ${
          (error as Error).message
        }`,
      );
    }
  }

  getUser(accessToken: string): Promise<MpUser> {
    return this.request<MpUser>('/users/me', { accessToken });
  }

  async listTerminals(
    accessToken: string,
    options: { fast?: boolean } = {},
  ): Promise<MpTerminal[]> {
    const response = await this.request<
      MpTerminalsResponse | MpTerminal[]
    >('/terminals/v1/list', {
      accessToken,
      query: { limit: 50 },
      // La sincronización automática no debe retrasar la carga del POS.
      timeoutMs: options.fast ? 3_000 : undefined,
      attempts: options.fast ? 1 : undefined,
    });

    if (Array.isArray(response)) {
      return response;
    }

    return response.data?.terminals ?? [];
  }

  /** Cambia el modo de operación de una terminal (PDV / SELF_SERVICE). */
  async setTerminalMode(
    accessToken: string,
    terminalId: string,
    operatingMode: 'PDV' | 'SELF_SERVICE',
  ): Promise<void> {
    await this.request('/terminals/v1/setup', {
      method: 'PATCH',
      accessToken,
      body: {
        // `/terminals/v1/setup` espera `id` (el del listado de terminales).
        // `terminal_id` es el campo de la Orders API y aquí devuelve 400.
        terminals: [{ id: terminalId, operating_mode: operatingMode }],
      },
    });
  }

  /**
   * Imprime contenido personalizado o una imagen en una terminal Point Smart.
   *
   * Requiere que Mercado Pago haya habilitado la impresión personalizada en el
   * equipo. `custom` usa las etiquetas propias de MP (`{b}`, `{br}`, ...);
   * `image` recibe un PNG/JPEG en base64 de máximo 1 MB.
   */
  createPrintAction(
    accessToken: string,
    action: {
      type: 'print';
      external_reference: string;
      config: {
        point: {
          terminal_id: string;
          subtype: 'custom' | 'image';
        };
      };
      content: string;
    },
    idempotencyKey: string,
  ): Promise<MpPrintAction> {
    return this.request<MpPrintAction>('/terminals/v1/actions', {
      method: 'POST',
      accessToken,
      body: action,
      idempotencyKey,
    });
  }

  createOrder(
    accessToken: string,
    order: unknown,
    idempotencyKey: string,
  ): Promise<MpOrder> {
    return this.request<MpOrder>('/v1/orders', {
      method: 'POST',
      accessToken,
      body: order,
      idempotencyKey,
    });
  }

  /** Preferencia de Checkout Pro para un link de pago. */
  createPreference(
    accessToken: string,
    preference: unknown,
    idempotencyKey: string,
  ): Promise<MpPreference> {
    return this.request<MpPreference>('/checkout/preferences', {
      method: 'POST',
      accessToken,
      body: preference,
      idempotencyKey,
    });
  }

  getPayment(accessToken: string, paymentId: string): Promise<MpPayment> {
    return this.request<MpPayment>(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      { accessToken },
    );
  }

  /**
   * Reembolso total o parcial de un pago de Checkout Pro.
   *
   * Sin `amount` Mercado Pago reembolsa el total. La operación es idempotente
   * por pago: repetirla devuelve los reembolsos existentes en lugar de cobrar
   * dos veces.
   */
  refundPayment(
    accessToken: string,
    paymentId: string,
    amount?: number,
  ): Promise<MpRefund> {
    return this.request<MpRefund>(
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      {
        method: 'POST',
        accessToken,
        body: amount === undefined ? {} : { amount },
        idempotencyKey: `refund-${paymentId}`,
      },
    );
  }

  searchPayments(
    accessToken: string,
    externalReference: string,
  ): Promise<MpPaymentsSearch> {
    return this.request<MpPaymentsSearch>('/v1/payments/search', {
      accessToken,
      query: {
        external_reference: externalReference,
        sort: 'date_created',
        criteria: 'desc',
      },
    });
  }

  getOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(`/v1/orders/${encodeURIComponent(orderId)}`, {
      accessToken,
    });
  }

  cancelOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(
      `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
      { method: 'POST', accessToken, idempotencyKey: `cancel-${orderId}` },
    );
  }

  refundOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(
      `/v1/orders/${encodeURIComponent(orderId)}/refund`,
      { method: 'POST', accessToken, idempotencyKey: `refund-${orderId}` },
    );
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${API_BASE_URL}${path}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (options.accessToken) {
      headers.authorization = `Bearer ${options.accessToken}`;
    }

    if (options.idempotencyKey) {
      headers['x-idempotency-key'] = options.idempotencyKey;
    }

    const method = options.method ?? 'GET';
    // Solo se reintentan peticiones que no pueden duplicar efectos. Los POST
    // con `x-idempotency-key` son seguros; OAuth (código de un solo uso) no.
    const canRetry =
      method !== 'POST' || Boolean(options.idempotencyKey);

    const execute = async (): Promise<T> => {
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.timeout(
            options.timeoutMs ?? REQUEST_TIMEOUT_MS,
          ),
        });
      } catch (error) {
        throw new MercadoPagoTransportError(
          `No se pudo contactar con Mercado Pago (${path}): ${
            (error as Error).message
          }`,
          path,
        );
      }

      const text = await response.text();
      const payload = text ? safeJson(text) : null;

      if (!response.ok) {
        const body = payload as MercadoPagoApiErrorBody | null;
        const cause = body?.cause?.[0];
        const firstError = body?.errors?.[0];
        const details = firstError?.details?.filter(Boolean).join('; ');
        const message =
          cause?.description ??
          details ??
          firstError?.message ??
          body?.message ??
          `Mercado Pago respondió con ${response.status}`;

        if (isRetryableStatus(response.status)) {
          throw new HttpRetrySignal(
            response.status,
            message,
            cause?.code ?? firstError?.code ?? body?.error,
            payload,
          );
        }

        throw new MercadoPagoApiError(
          response.status,
          message,
          cause?.code ?? firstError?.code ?? body?.error,
          payload,
        );
      }

      return payload as T;
    };

    try {
      return await retry(execute, {
        attempts: canRetry ? (options.attempts ?? MAX_ATTEMPTS) : 1,
        shouldRetry: (error) =>
          error instanceof MercadoPagoTransportError ||
          error instanceof HttpRetrySignal,
        onRetry: (error, attempt, delay) => {
          this.logger.warn(
            `Reintento ${attempt} de ${method} ${path} en ${delay} ms: ${
              (error as Error).message
            }`,
          );
        },
      });
    } catch (error) {
      if (error instanceof HttpRetrySignal) {
        throw new MercadoPagoApiError(
          error.status,
          error.message,
          error.code,
          error.body,
        );
      }

      if (
        error instanceof MercadoPagoTransportError ||
        error instanceof MercadoPagoApiError
      ) {
        throw error;
      }

      throw new MercadoPagoTransportError(
        `Error inesperado con Mercado Pago (${path}): ${
          (error as Error).message
        }`,
        path,
      );
    }
  }

  private clientId(): string {
    return this.config.get<string>('MP_CLIENT_ID') ?? '';
  }

  private clientSecret(): string {
    return this.config.get<string>('MP_CLIENT_SECRET') ?? '';
  }

  private redirectUri(): string {
    const configured = this.config.get<string>('MP_REDIRECT_URI');
    if (configured) return configured;

    const apiOrigin =
      this.config.get<string>('API_PUBLIC_ORIGIN') ??
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;

    return `${apiOrigin.replace(/\/$/, '')}/v1/mercadopago/callback`;
  }
}

/**
 * Señal interna: convierte una respuesta HTTP reintentable en algo que `retry`
 * pueda volver a intentar sin perder el status ni el cuerpo.
 */
class HttpRetrySignal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpRetrySignal';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
