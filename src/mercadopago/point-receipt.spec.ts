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
  organizationRfc: 'XAXX010101000',
  branchName: 'Sucursal Centro',
  branchAddress: null,
  currency: 'MXN',
  order: {
    ticketNumber: 42,
    ticketUid: '20261124042',
    tableNumber: '4',
    partySize: 2,
    isTakeaway: false,
    channel: 'DINE_IN',
    customerName: 'Ana',
    issuedAt: new Date('2026-11-24T19:45:00Z'),
    subtotal: '103.45',
    taxTotal: '16.55',
    discountTotal: '0.00',
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
    expect(content).toContain('RFC: XAXX010101000');
    expect(content).toContain('Ticket #042');
    expect(content).toContain('2 x Tacos al pastor Orden');
    expect(content).toContain('TOTAL COBRADO');
    expect(content).toContain('Propina');
    expect(content).toContain('Efectivo');
    expect(content).toContain('#20261124042');
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
    const body = content.split('{br}').slice(0, -1).join('{br}');
    expect(body).not.toContain('{center}');

    expect(lines).toContain(
      'Mesa 4 - 2 personas'.padEnd(32, ' '),
    );
    expect(lines).toContain('Cliente: Ana'.padEnd(32, ' '));
    expect(lines).toContain('PRODUCTOS'.padEnd(32, ' '));
    expect(lines).toContain('PAGOS'.padEnd(32, ' '));

    const subtotal = lines.find((line) => line.startsWith('Subtotal'));
    expect(subtotal).toBeDefined();
    expect(subtotal?.endsWith('$103.45')).toBe(true);
    expect(subtotal?.length).toBe(32);

    const tax = lines.find((line) => line.startsWith('IVA'));
    expect(tax).toBeDefined();
    expect(tax?.endsWith('$16.55')).toBe(true);
    expect(tax?.length).toBe(32);

    const payment = lines.find((line) => line.startsWith('Efectivo'));
    expect(payment).toBeDefined();
    expect(payment?.endsWith('$120.00')).toBe(true);
    expect(payment?.length).toBe(32);
  });

  it('muestra la sucursal aunque se llame igual que el negocio', () => {
    const content = buildPointReceipt({
      ...base,
      branchName: 'Naranja Pimienta',
      organizationRfc: null,
    });
    const lines = content
      .split('{br}')
      .map((line) => line.replace(/\{[^}]*\}/g, ''));

    expect(lines.some((line) => line.trim() === 'Naranja Pimienta')).toBe(
      true,
    );
    expect(content).not.toContain('RFC:');
  });

  it('agrupa artículos iguales de distintas rondas', () => {
    const content = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        items: [
          {
            name: 'Café',
            variant: 'Latte',
            quantity: 1,
            subtotal: '50.00',
          },
          {
            name: 'Café',
            variant: 'Latte',
            quantity: 2,
            subtotal: '100.00',
          },
          {
            name: 'Café',
            variant: 'Americano',
            quantity: 1,
            subtotal: '40.00',
          },
        ],
        payments: [
          { method: 'CARD', amount: '190.00', tipAmount: '0.00' },
        ],
      },
    });
    const lines = content
      .split('{br}')
      .map((line) => line.replace(/\{[^}]*\}/g, ''));
    const latte = lines.find((line) => line.startsWith('3 x Café Latte'));

    expect(latte).toBeDefined();
    expect(latte?.endsWith('$150.00')).toBe(true);
    expect(lines.some((line) => line.startsWith('2 x Café Latte'))).toBe(false);
    expect(
      lines.some(
        (line) => line.startsWith('1 x Café Americano') && line.endsWith('$40.00'),
      ),
    ).toBe(true);
  });

  it('sugiere propina en efectivo cuando todavía no hay propina', () => {
    const content = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        subtotal: '172.41',
        taxTotal: '27.59',
        total: '200.00',
        payments: [
          { method: 'CASH', amount: '200.00', tipAmount: '0.00' },
        ],
      },
    });
    const lines = content
      .split('{br}')
      .map((line) => line.replace(/\{[^}]*\}/g, ''));

    expect(lines).toContain('Propina sugerida'.padEnd(32));
    expect(lines.find((line) => line.startsWith('10%'))?.endsWith('$20.00')).toBe(
      true,
    );
    expect(lines.find((line) => line.startsWith('15%'))?.endsWith('$30.00')).toBe(
      true,
    );
    expect(lines.find((line) => line.startsWith('20%'))?.endsWith('$40.00')).toBe(
      true,
    );

    const total = lines.find((line) => line.startsWith('TOTAL'));
    expect(total?.endsWith('$200.00')).toBe(true);
    expect(total?.startsWith('TOTAL COBRADO')).toBe(false);
    expect(lines.at(-1)).toContain('#20261124042');
  });

  it('no sugiere propina si ya hay propina o el pago no es efectivo/transferencia', () => {
    const withTip = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        payments: [
          { method: 'CASH', amount: '120.00', tipAmount: '20.00' },
        ],
      },
    });
    const withCard = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        payments: [
          { method: 'CARD', amount: '120.00', tipAmount: '0.00' },
        ],
      },
    });

    expect(withTip).not.toContain('Propina sugerida');
    expect(withCard).not.toContain('Propina sugerida');
  });

  it('desglosa subtotal sin IVA, IVA, descuento, propina y total', () => {
    const content = buildPointReceipt({
      ...base,
      order: {
        ...base.order,
        subtotal: '155.17',
        taxTotal: '24.83',
        discountTotal: '20.00',
        total: '180.00',
        payments: [
          { method: 'CASH', amount: '180.00', tipAmount: '10.00' },
        ],
      },
    });
    const lines = content
      .split('{br}')
      .map((line) => line.replace(/\{[^}]*\}/g, ''));
    const find = (prefix: string) => {
      const line = lines.find((entry) => entry.startsWith(prefix));
      expect(line).toBeDefined();
      return line as string;
    };

    expect(find('Subtotal').endsWith('$175.17')).toBe(true);
    expect(find('IVA').endsWith('$24.83')).toBe(true);
    expect(find('Descuento').endsWith('-$20.00')).toBe(true);
    expect(find('Propina').endsWith('$10.00')).toBe(true);
    expect(find('TOTAL COBRADO').endsWith('$190.00')).toBe(true);

    // Orden fiscal: subtotal, IVA, descuento, propina y total.
    const order = ['Subtotal', 'IVA', 'Descuento', 'Propina', 'TOTAL COBRADO'].map(
      (prefix) => lines.indexOf(find(prefix)),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('agrega el descuento a las plantillas guardadas sin ese campo', () => {
    const legacy = { ...defaultReceiptTemplate(), version: 1 as const };
    legacy.blocks = legacy.blocks.map((block) =>
      block.type === 'totals'
        ? {
            ...block,
            fields: ['subtotal', 'tax', 'delivery', 'tip', 'total'],
          }
        : block,
    );

    const parsed = receiptTemplateSchema.parse(legacy);
    const totals = parsed.blocks.find((block) => block.type === 'totals');

    expect(parsed.version).toBe(3);
    expect(totals?.type).toBe('totals');
    expect(totals?.type === 'totals' ? totals.fields : []).toEqual([
      'subtotal',
      'tax',
      'discount',
      'delivery',
      'tip',
      'total',
    ]);
  });

  it('respeta una plantilla versión 2 que apaga el descuento', () => {
    const template = defaultReceiptTemplate();
    template.blocks = template.blocks.map((block) =>
      block.type === 'totals'
        ? {
            ...block,
            fields: ['subtotal', 'tax', 'delivery', 'tip', 'total'],
          }
        : block,
    );

    const parsed = receiptTemplateSchema.parse(template);
    const totals = parsed.blocks.find((block) => block.type === 'totals');

    expect(totals?.type === 'totals' ? totals.fields : []).not.toContain(
      'discount',
    );
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
    expect(result.content).not.toContain('IVA');
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
