import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  MercadoPagoApiError,
  MercadoPagoApiErrorBody,
  MpOrder,
  MpTerminal,
  MpTerminalsResponse,
  MpTokenResponse,
  MpUser,
} from './mercadopago.types';

const API_BASE_URL = 'https://api.mercadopago.com';
const AUTHORIZE_URL = 'https://auth.mercadopago.com/authorization';
const REQUEST_TIMEOUT_MS = 12_000;

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  accessToken?: string;
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
}

/**
 * Cliente HTTP mínimo de Mercado Pago (sin SDK oficial).
 *
 * Solo cubre lo que usa la integración Point: OAuth, terminales y orders.
 * Traduce los errores del proveedor a `MercadoPagoApiError` para que la capa
 * de servicio decida qué mensaje mostrar al usuario.
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

  get webhookSecret(): string {
    return this.config.get<string>('MP_WEBHOOK_SECRET') ?? '';
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

  async listTerminals(accessToken: string): Promise<MpTerminal[]> {
    const response = await this.request<
      MpTerminalsResponse | MpTerminal[]
    >('/terminals/v1/list', {
      accessToken,
      query: { limit: 50 },
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
        terminals: [
          { terminal_id: terminalId, operating_mode: operatingMode },
        ],
      },
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

  getOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(`/v1/orders/${encodeURIComponent(orderId)}`, {
      accessToken,
    });
  }

  cancelOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(
      `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
      { method: 'POST', accessToken },
    );
  }

  refundOrder(accessToken: string, orderId: string): Promise<MpOrder> {
    return this.request<MpOrder>(
      `/v1/orders/${encodeURIComponent(orderId)}/refund`,
      { method: 'POST', accessToken },
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

    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `Error de red con Mercado Pago (${path}): ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo contactar con Mercado Pago. Intenta de nuevo en unos segundos.',
      );
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
      const body = payload as MercadoPagoApiErrorBody | null;
      const cause = body?.cause?.[0];
      const message =
        cause?.description ??
        body?.message ??
        `Mercado Pago respondió con ${response.status}`;

      throw new MercadoPagoApiError(
        response.status,
        message,
        cause?.code ?? body?.error,
        payload,
      );
    }

    return payload as T;
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
