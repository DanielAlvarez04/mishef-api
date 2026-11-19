import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureFailure =
  | 'missing'
  | 'format'
  | 'expired'
  | 'mismatch';

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

export interface MercadoPagoSignatureInput {
  secret: string;
  /** Cabecera `x-signature` (`ts=...,v1=...`). */
  signature: string | undefined;
  /** Cabecera `x-request-id`. */
  requestId: string | undefined;
  /** `data.id` del query o del cuerpo. */
  dataId: string | undefined;
  /**
   * Ventana máxima, en segundos, entre el `ts` firmado y ahora.
   * `0` (por defecto) desactiva la comprobación para no romper reintentos
   * legítimos de Mercado Pago.
   */
  maxSkewSeconds?: number;
  /** Inyectable para pruebas. Milisegundos desde epoch. */
  now?: number;
}

/**
 * Verifica la firma HMAC-SHA256 que Mercado Pago envía en `x-signature`.
 *
 * El manifiesto oficial es `id:{data.id};request-id:{x-request-id};ts:{ts};`.
 * Algunos ejemplos de Mercado Pago normalizan el id a minúsculas, por eso se
 * aceptan ambas variantes. La comparación es en tiempo constante.
 */
export function verifyMercadoPagoSignature(
  input: MercadoPagoSignatureInput,
): SignatureResult {
  const { secret, signature, requestId, dataId } = input;

  if (!secret || !signature || !requestId || !dataId) {
    return { valid: false, reason: 'missing' };
  }

  const values = new Map<string, string>();

  for (const part of signature.split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }

  const ts = values.get('ts');
  const received = values.get('v1');

  if (!ts || !received || !/^\d+$/.test(ts)) {
    return { valid: false, reason: 'format' };
  }

  const maxSkew = input.maxSkewSeconds ?? 0;

  if (maxSkew > 0) {
    const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - Number(ts)) > maxSkew) {
      return { valid: false, reason: 'expired' };
    }
  }

  const manifests = new Set([
    `id:${dataId};request-id:${requestId};ts:${ts};`,
    `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`,
  ]);

  const receivedBuffer = Buffer.from(received);

  for (const manifest of manifests) {
    const expected = createHmac('sha256', secret)
      .update(manifest)
      .digest('hex');

    const expectedBuffer = Buffer.from(expected);

    if (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'mismatch' };
}
