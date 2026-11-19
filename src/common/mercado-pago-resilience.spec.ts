import { createHmac } from 'node:crypto';
import { PaymentMethod } from '@prisma/client';

import { verifyMercadoPagoSignature } from '../common/webhook-signature';
import { isRetryableStatus, retry } from '../common/http-retry';
import { ProviderPaymentRegistry } from '../payments/provider-payment.registry';
import {
  MercadoPagoApiError,
  MercadoPagoTransportError,
  isAmbiguousProviderError,
} from '../mercadopago/mercadopago.types';

const SECRET = 'secreto-de-prueba';
const DATA_ID = 'ORD01ABC';
const REQUEST_ID = 'req-123';
const TS = '1730000000';

function sign(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function signature(ts = TS, v1 = sign(`id:${DATA_ID};request-id:${REQUEST_ID};ts:${TS};`)) {
  return `ts=${ts},v1=${v1}`;
}

describe('verifyMercadoPagoSignature', () => {
  it('acepta el manifiesto oficial', () => {
    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: signature(),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: true });
  });

  it('acepta el id normalizado a minúsculas', () => {
    const v1 = sign(`id:${DATA_ID.toLowerCase()};request-id:${REQUEST_ID};ts:${TS};`);

    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: signature(TS, v1),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: true });
  });

  it('rechaza una firma alterada', () => {
    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: signature(TS, 'a'.repeat(64)),
        requestId: REQUEST_ID,
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rechaza un request-id distinto', () => {
    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: signature(),
        requestId: 'otro',
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('exige todos los datos', () => {
    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: undefined,
        requestId: REQUEST_ID,
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: false, reason: 'missing' });
  });

  it('rechaza un ts no numérico', () => {
    expect(
      verifyMercadoPagoSignature({
        secret: SECRET,
        signature: `ts=abc,v1=${'a'.repeat(64)}`,
        requestId: REQUEST_ID,
        dataId: DATA_ID,
      }),
    ).toEqual({ valid: false, reason: 'format' });
  });

  it('aplica la ventana de antigüedad solo si se configura', () => {
    const input = {
      secret: SECRET,
      signature: signature(),
      requestId: REQUEST_ID,
      dataId: DATA_ID,
      now: (Number(TS) + 900) * 1000,
    };

    expect(verifyMercadoPagoSignature(input)).toEqual({ valid: true });
    expect(verifyMercadoPagoSignature({ ...input, maxSkewSeconds: 300 })).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('retry', () => {
  it('reintenta errores transitorios y devuelve el resultado', async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transitorio');
        return 'ok';
      },
      {
        shouldRetry: () => true,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it('no reintenta errores definitivos', async () => {
    let calls = 0;

    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error('definitivo');
        },
        { shouldRetry: () => false, sleepFn: async () => undefined },
      ),
    ).rejects.toThrow('definitivo');

    expect(calls).toBe(1);
  });

  it('clasifica los códigos reintentables', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });
});

describe('isAmbiguousProviderError', () => {
  it('trata un timeout de red como resultado desconocido', () => {
    expect(
      isAmbiguousProviderError(
        new MercadoPagoTransportError('timeout', '/v1/orders'),
      ),
    ).toBe(true);
  });

  it('trata los 5xx y 429 como desconocidos', () => {
    expect(isAmbiguousProviderError(new MercadoPagoApiError(502, 'bad'))).toBe(
      true,
    );
    expect(isAmbiguousProviderError(new MercadoPagoApiError(429, 'slow'))).toBe(
      true,
    );
  });

  it('trata un 400 como definitivo', () => {
    expect(
      isAmbiguousProviderError(new MercadoPagoApiError(400, 'invalid')),
    ).toBe(false);
  });
});

describe('ProviderPaymentRegistry', () => {
  it('solo entrega el handler que soporta el pago', () => {
    const registry = new ProviderPaymentRegistry();
    const handler = {
      provider: 'MERCADO_PAGO',
      supports: (payment: { method: PaymentMethod }) =>
        payment.method === PaymentMethod.MERCADO_PAGO_LINK,
      refund: async () => ({
        status: 'refunded' as const,
        providerStatus: 'refunded',
      }),
    };

    registry.register(handler);

    const base = {
      id: 'pay-1',
      organizationId: 'org-1',
      provider: 'MERCADO_PAGO',
      providerOrderId: null,
      providerPaymentId: '123',
      amount: 100,
      currency: 'MXN',
    };

    expect(
      registry.find({
        ...base,
        method: PaymentMethod.MERCADO_PAGO_LINK,
      }),
    ).toBe(handler);

    expect(
      registry.find({
        ...base,
        method: PaymentMethod.CASH,
      }),
    ).toBeNull();
  });
});
