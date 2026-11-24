import { buildPointReceipt, type PointReceiptInput } from './point-receipt';

const base: PointReceiptInput = {
  organizationName: 'Naranja Pimienta',
  organizationAddress: 'Calle Demo 123, CDMX',
  branchName: 'Sucursal Centro',
  branchAddress: null,
  currency: 'MXN',
  order: {
    ticketNumber: 42,
    tableNumber: '4',
    partySize: 2,
    isTakeaway: false,
    channel: 'DINE_IN',
    customerName: 'Ana',
    issuedAt: new Date('2026-11-24T19:45:00Z'),
    subtotal: '103.45',
    taxTotal: '16.55',
    deliveryFee: '0.00',
    total: '120.00',
    items: [
      {
        name: 'Tacos al pastor',
        variant: 'Orden',
        quantity: 2,
        subtotal: '120.00',
      },
    ],
    payments: [
      {
        method: 'CASH',
        amount: '120.00',
        tipAmount: '20.00',
      },
    ],
  },
};

describe('buildPointReceipt', () => {
  it('incluye negocio, ticket, productos, total y pago', () => {
    const content = buildPointReceipt(base);

    expect(content).toContain('NARANJA PIMIENTA');
    expect(content).toContain('Sucursal Centro');
    expect(content).toContain('Ticket #42');
    expect(content).toContain('2 x Tacos al pastor (Orden)');
    expect(content).toContain('TOTAL COBRADO');
    expect(content).toContain('Propina');
    expect(content).toContain('Efectivo');
    expect(content).toContain('Gracias por su visita');
  });

  it('respeta el mínimo y el máximo de contenido de Mercado Pago', () => {
    const content = buildPointReceipt(base);

    expect(content.length).toBeGreaterThanOrEqual(100);
    expect(content.length).toBeLessThanOrEqual(4096);
  });

  it('quita llaves de los nombres para no romper las etiquetas', () => {
    const content = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        customerName: 'Ana {b}',
        items: [
          {
            name: 'Combo {w}',
            variant: null,
            quantity: 1,
            subtotal: '50.00',
          },
        ],
      },
    });

    expect(content).toContain('Combo w');
    expect(content).toContain('Cliente: Ana b');
    expect(content).not.toContain('Combo {w}');
  });

  it('no excede el límite con una cuenta muy larga', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      name: `Producto con un nombre bastante largo ${index}`,
      variant: null,
      quantity: 1,
      subtotal: '10.00',
    }));
    const content = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        items,
        total: '2000.00',
        subtotal: '2000.00',
        payments: [
          { method: 'CASH', amount: '2000.00', tipAmount: '0.00' },
        ],
      },
    });

    expect(content.length).toBeLessThanOrEqual(4096);
    expect(content).toContain('... y');
  });
});
