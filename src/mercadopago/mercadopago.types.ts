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
