import {
  buildPointReceipt,
  defaultReceiptTemplate,
  receiptTemplateSchema,
  renderReceiptPreviewHtml,
  renderReceiptText,
  type PointReceiptInput,
} from './point-receipt';

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

  it('no excede las 32 columnas visibles del papel', () => {
    const content = buildPointReceipt(base);

    for (const line of content.split('{br}')) {
      const visible = line.replace(/\{[^}]*\}/g, '');
      expect(visible.length).toBeLessThanOrEqual(32);
    }
  });

  it('arma las líneas con espacios y sin etiquetas de alineación', () => {
    const content = buildPointReceipt(base);
    const lines = content
      .split('{br}')
      .map((line) => line.replace(/\{[^}]*\}/g, ''));

    expect(content).not.toContain('{left}');
    expect(content).not.toContain('{center}');

    expect(lines).toContain(
      'Mesa 4 - 2 personas'.padEnd(32, ' '),
    );
    expect(lines).toContain('Cliente: Ana'.padEnd(32, ' '));
    expect(lines).toContain('PRODUCTOS'.padEnd(32, ' '));
    expect(lines).toContain('PAGOS'.padEnd(32, ' '));

    const subtotal = lines.find((line) => line.startsWith('Subtotal'));
    expect(subtotal).toBeDefined();
    expect(subtotal?.endsWith('$120.00')).toBe(true);
    expect(subtotal?.length).toBe(32);

    const payment = lines.find((line) => line.startsWith('Efectivo'));
    expect(payment).toBeDefined();
    expect(payment?.endsWith('$120.00')).toBe(true);
    expect(payment?.length).toBe(32);
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

  it('respeta los campos desactivados de la plantilla', () => {
    const template = defaultReceiptTemplate();
    template.blocks = template.blocks
      .map((block) => {
        if (block.type === 'order') {
          return { ...block, fields: ['place'] as const };
        }

        if (block.type === 'totals') {
          return { ...block, fields: ['subtotal', 'total'] as const };
        }

        return block;
      })
      .map((block) =>
        block.type === 'order'
          ? { ...block, fields: [...block.fields] }
          : block.type === 'totals'
            ? { ...block, fields: [...block.fields] }
            : block
      );

    const result = renderReceiptText(template, base);

    expect(result.content).not.toContain('Cliente:');
    expect(result.content).not.toContain('IVA incluido');
    expect(result.content).not.toContain('Propina');
  });

  it('no incluye el logo en el texto y avisa de caracteres no soportados', () => {
    const template = { ...defaultReceiptTemplate(), printLogo: true };
    const result = renderReceiptText(template, {
      ...base,
      order: { ...base.order, customerName: 'Ana 😀' },
    });

    expect(result.content).not.toContain('data:image');
    expect(
      result.warnings.some((warning) => warning.includes('Caracteres'))
    ).toBe(true);
  });

  it('genera HTML seguro para la vista previa', () => {
    const html = renderReceiptPreviewHtml(
      '{center}{b}Hola <cliente>{/b}{/center}{br}{left}{s}Total $10{/s}{/left}'
    );

    expect(html).toContain('<strong>');
    expect(html).toContain('&lt;cliente&gt;');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:left');
  });

  it('valida la plantilla antes de guardarla', () => {
    const template = defaultReceiptTemplate();

    expect(receiptTemplateSchema.safeParse(template).success).toBe(true);
    expect(
      receiptTemplateSchema.safeParse({ ...template, blocks: [] }).success
    ).toBe(false);
  });
});
