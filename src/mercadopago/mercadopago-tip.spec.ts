import { Prisma } from '@prisma/client';

import { readTerminalTip } from './mercadopago-point.service';
import type { MpOrderPayment } from './mercadopago.types';

function payment(overrides: Partial<MpOrderPayment>): MpOrderPayment {
  return {
    id: 'PAY01',
    amount: '100.00',
    status: 'processed',
    status_detail: 'processed',
    ...overrides,
  };
}

describe('readTerminalTip', () => {
  const base = new Prisma.Decimal('100.00');

  it('usa tip_amount cuando la terminal lo informa', () => {
    expect(readTerminalTip(payment({ tip_amount: '15' }), base)).toBe(1500);
    expect(readTerminalTip(payment({ tip_amount: '15.50' }), base)).toBe(1550);
  });

  it('devuelve 0 cuando el cliente no dejó propina', () => {
    expect(readTerminalTip(payment({ tip_amount: '0' }), base)).toBe(0);
  });

  it('usa paid_amount - venta si falta tip_amount', () => {
    expect(
      readTerminalTip(payment({ paid_amount: '115.00' }), base),
    ).toBe(1500);
  });

  it('no inventa propina si no hay datos', () => {
    expect(readTerminalTip(payment({}), base)).toBeNull();
    expect(readTerminalTip(undefined, base)).toBeNull();
  });

  it('tolera importes con decimales y redondea a centavos', () => {
    expect(
      readTerminalTip(payment({ tip_amount: '0.1' }), base),
    ).toBe(10);
  });
});
