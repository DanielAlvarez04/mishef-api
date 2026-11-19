/** Tipos de la API de Mercado Pago usados por la integración Point. */

export interface MpTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: number | string;
  scope?: string;
  public_key?: string;
  live_mode?: boolean;
}

export interface MpUser {
  id: number;
  nickname?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  site_id?: string;
  country_id?: string;
}

export interface MpTerminal {
  id: string;
  name?: string;
  operating_mode?: string;
  pos_id?: number | string;
  store_id?: number | string;
  [key: string]: unknown;
}

export interface MpTerminalsResponse {
  data?: {
    terminals?: MpTerminal[];
  };
  paging?: {
    total?: number;
    limit?: number;
    offset?: number;
  };
}

export interface MpPreference {
  id: string;
  init_point?: string;
  sandbox_init_point?: string;
  external_reference?: string;
  expiration_date_to?: string;
}

export interface MpRefund {
  id?: number;
  payment_id?: number;
  amount?: number;
  status?: string;
  date_created?: string;
  [key: string]: unknown;
}

export interface MpPayment {
  id: number;
  status: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  transaction_amount_refunded?: number;
  refunds?: MpRefund[];
  currency_id?: string;
  date_approved?: string;
  date_created?: string;
  payment_method_id?: string;
}

export interface MpPaymentsSearch {
  results?: MpPayment[];
}

export interface MpOrderPayment {
  id: string;
  amount: string;
  status: string;
  status_detail?: string;
  date_approved?: string;
}

export interface MpOrder {
  id: string;
  type?: string;
  user_id?: string;
  external_reference?: string;
  description?: string;
  status: string;
  status_detail?: string;
  created_date?: string;
  last_updated_date?: string;
  transactions?: {
    payments?: MpOrderPayment[];
  };
  config?: {
    point?: {
      terminal_id?: string;
    };
  };
  [key: string]: unknown;
}

export interface MercadoPagoApiErrorBody {
  message?: string;
  error?: string;
  status?: number;
  cause?: Array<{ code?: string; description?: string }>;
}

/** Error de la API de MP con el status HTTP y el detalle del proveedor. */
export class MercadoPagoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoApiError';
  }
}

/**
 * Fallo de red o timeout. No se sabe si Mercado Pago alcanzó a procesar la
 * petición, así que quien llama no debe cancelar ni reintentar a ciegas: debe
 * conservar la clave de idempotencia y conciliar después.
 */
export class MercadoPagoTransportError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'MercadoPagoTransportError';
  }
}

/**
 * `true` cuando el resultado de la operación es desconocido (timeout, 5xx,
 * 429 o 408). Nunca se debe asumir que el cobro no se creó.
 */
export function isAmbiguousProviderError(error: unknown): boolean {
  if (error instanceof MercadoPagoTransportError) return true;

  if (error instanceof MercadoPagoApiError) {
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  return false;
}

/** `true` para 4xx que confirman que Mercado Pago rechazó la operación. */
export function isDefinitiveProviderError(error: unknown): boolean {
  return error instanceof MercadoPagoApiError && !isAmbiguousProviderError(error);
}
