/**
 * Plantilla y renderer del ticket que se imprime en una terminal Point Smart.
 *
 * Mercado Pago recibe texto con etiquetas propias (`{b}`, `{w}`, `{s}`,
 * `{br}`, `{left}`, `{center}`). El contenido debe medir entre 100 y 4096
 * caracteres y el papel imprimible es de 32 columnas.
 *
 * El firmware de Point no respeta `{left}` de forma fiable (las líneas salen
 * centradas o corridas a la derecha), así que las líneas del ticket se arman
 * con espacios y se rellenan exactamente a 32 columnas. Así la posición no
 * depende de la alineación que aplique la terminal.
 */

import { z } from 'zod';

import { formatTicketNumber } from '../tickets/ticket-code';

export type ReceiptAlign = 'left' | 'center';
export type ReceiptSize = 'small' | 'normal' | 'large';

const receiptAlignSchema = z.enum(['left', 'center']);
const receiptSizeSchema = z.enum(['small', 'normal', 'large']);

const orderFieldSchema = z.enum(['place', 'partySize', 'customer']);
const totalFieldSchema = z.enum([
  'subtotal',
  'tax',
  'discount',
  'delivery',
  'tip',
  'total',
]);

type TotalField = z.infer<typeof totalFieldSchema>;

/** Orden fijo de los conceptos del ticket: subtotal, IVA, descuento, propina. */
const TOTAL_FIELD_ORDER = [
  'subtotal',
  'tax',
  'discount',
  'tip',
  'delivery',
  'total',
] as const satisfies readonly TotalField[];

const blockBase = {
  id: z.string().min(1).max(40),
};

const businessBlockSchema = z.object({
  ...blockBase,
  type: z.literal('business'),
  showName: z.boolean(),
  showBranch: z.boolean(),
  showRfc: z.boolean().default(true),
  showAddress: z.boolean(),
  align: receiptAlignSchema,
});

const ticketBlockSchema = z.object({
  ...blockBase,
  type: z.literal('ticket'),
  showTicket: z.boolean(),
  showDate: z.boolean(),
  align: receiptAlignSchema,
});

const orderBlockSchema = z.object({
  ...blockBase,
  type: z.literal('order'),
  fields: z.array(orderFieldSchema).max(3),
  align: receiptAlignSchema,
});

const itemsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('items'),
  showVariant: z.boolean(),
  showQuantity: z.boolean(),
  showLineTotal: z.boolean(),
});

const totalsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('totals'),
  fields: z.array(totalFieldSchema).max(6),
});

const paymentsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('payments'),
  showTitle: z.boolean().default(true),
  showMethod: z.boolean(),
  showAmount: z.boolean(),
});

const textBlockSchema = z.object({
  ...blockBase,
  type: z.literal('text'),
  text: z.string().max(500),
  align: receiptAlignSchema,
  size: receiptSizeSchema,
  bold: z.boolean(),
});

const dividerBlockSchema = z.object({
  ...blockBase,
  type: z.literal('divider'),
});

const tipSuggestionsBlockSchema = z.object({
  ...blockBase,
  type: z.literal('tipSuggestions'),
});

export const receiptBlockSchema = z.discriminatedUnion('type', [
  businessBlockSchema,
  ticketBlockSchema,
  orderBlockSchema,
  itemsBlockSchema,
  totalsBlockSchema,
  paymentsBlockSchema,
  textBlockSchema,
  dividerBlockSchema,
  tipSuggestionsBlockSchema,
]);

export const receiptTemplateSchema = z
  .object({
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    /** Imprime el logo como una acción `image` antes del ticket de texto. */
    printLogo: z.boolean(),
    blocks: z.array(receiptBlockSchema).min(1).max(40),
  })
  .transform((template) => upgradeTemplate(template));

export type ReceiptBlock = z.infer<typeof receiptBlockSchema>;

export type ReceiptTemplate = {
  version: 1 | 2 | 3 | 4 | 5;
  printLogo: boolean;
  blocks: ReceiptBlock[];
};

/**
 * Migra las plantillas al contrato actual.
 *
 * v1 → v2: agrega «Descuento» a los totales.
 * v2 → v3: inserta el bloque «Propina sugerida» antes del pie de página.
 * v3 → v4: quita el bloque de pagos; la cuenta se imprime antes de cobrar.
 * v4 → v5: vuelve a agregar «Pagos» para ventanilla y reimpresiones.
 *
 * Solo se aplica una vez por plantilla: al guardarla queda en la versión
 * actual y, si el usuario quita un bloque, ya no se vuelve a agregar.
 */
function upgradeTemplate(template: ReceiptTemplate): ReceiptTemplate {
  let blocks = template.blocks;

  if (template.version < 2) {
    blocks = blocks.map((block) => {
      if (
        block.type !== 'totals' ||
        block.fields.includes('discount')
      ) {
        return block;
      }

      const fields = [...block.fields];
      const taxIndex = fields.indexOf('tax');

      fields.splice(
        taxIndex >= 0 ? taxIndex + 1 : fields.length,
        0,
        'discount',
      );

      return { ...block, fields };
    });
  }

  if (template.version < 3) {
    blocks = insertTipSuggestions(blocks);
  }

  if (template.version < 4) {
    blocks = blocks.filter(
      (block) =>
        block.type !== 'payments' &&
        !(
          block.type === 'text' &&
          (block.id === 'payments-title' ||
            block.text.trim().toUpperCase() === 'PAGOS')
        ),
    );
  }

  if (template.version < 5) {
    blocks = insertPaymentsBlock(blocks);
  }

  return { ...template, version: 5, blocks };
}

/** Id estable para los bloques que agrega la migración. */
function uniqueBlockId(blocks: ReceiptBlock[], base: string): string {
  let id = base;
  let suffix = 2;

  while (blocks.some((block) => block.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  return id;
}

/**
 * Inserta «Propina sugerida» entre dos separadores antes del texto libre.
 *
 * Si ya hay un separador justo antes del pie, se reutiliza como separador de
 * entrada y solo se agrega el de salida.
 */
function insertTipSuggestions(blocks: ReceiptBlock[]): ReceiptBlock[] {
  if (blocks.some((block) => block.type === 'tipSuggestions')) {
    return blocks;
  }

  const tipBlock: ReceiptBlock = {
    id: uniqueBlockId(blocks, 'tip-suggestions'),
    type: 'tipSuggestions',
  };
  const divider: ReceiptBlock = {
    id: uniqueBlockId([...blocks, tipBlock], 'divider-tip'),
    type: 'divider',
  };
  const footerIndex = blocks
    .map((block) => block.type)
    .lastIndexOf('text');

  if (footerIndex < 0) {
    return [...blocks, divider, tipBlock];
  }

  const hasLeadingDivider =
    footerIndex > 0 && blocks[footerIndex - 1].type === 'divider';
  const insertion = hasLeadingDivider ? [tipBlock] : [divider, tipBlock];

  return [
    ...blocks.slice(0, footerIndex),
    ...insertion,
    ...blocks.slice(footerIndex),
  ];
}

/**
 * Agrega «Pagos» una sola vez, antes de la propina sugerida o del pie.
 *
 * El bloque imprime su propio título y separador solo cuando hay pagos
 * confirmados, así que puede convivir con «Propina sugerida» en la plantilla.
 */
function insertPaymentsBlock(blocks: ReceiptBlock[]): ReceiptBlock[] {
  if (blocks.some((block) => block.type === 'payments')) {
    return blocks;
  }

  const payments: ReceiptBlock = {
    id: uniqueBlockId(blocks, 'payments'),
    type: 'payments',
    showTitle: true,
    showMethod: true,
    showAmount: true,
  };
  const tipIndex = blocks.findIndex(
    (block) => block.type === 'tipSuggestions',
  );

  if (tipIndex >= 0) {
    return [
      ...blocks.slice(0, tipIndex),
      payments,
      ...blocks.slice(tipIndex),
    ];
  }

  const footerIndex = blocks
    .map((block) => block.type)
    .lastIndexOf('text');

  if (footerIndex >= 0) {
    return [
      ...blocks.slice(0, footerIndex),
      payments,
      ...blocks.slice(footerIndex),
    ];
  }

  return [...blocks, payments];
}

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplate = {
  version: 5,
  printLogo: false,
  blocks: [
    {
      id: 'business',
      type: 'business',
      showName: true,
      showBranch: true,
      showRfc: true,
      showAddress: true,
      align: 'center',
    },
    {
      id: 'ticket',
      type: 'ticket',
      showTicket: true,
      showDate: true,
      align: 'center',
    },
    { id: 'divider-1', type: 'divider' },
    {
      id: 'order',
      type: 'order',
      fields: ['place', 'partySize', 'customer'],
      align: 'left',
    },
    {
      id: 'items-title',
      type: 'text',
      text: 'PRODUCTOS',
      align: 'left',
      size: 'normal',
      bold: true,
    },
    {
      id: 'items',
      type: 'items',
      showVariant: true,
      showQuantity: true,
      showLineTotal: true,
    },
    { id: 'divider-2', type: 'divider' },
    {
      id: 'totals',
      type: 'totals',
      fields: ['subtotal', 'tax', 'discount', 'tip', 'delivery', 'total'],
    },
    { id: 'divider-3', type: 'divider' },
    {
      id: 'payments',
      type: 'payments',
      showTitle: true,
      showMethod: true,
      showAmount: true,
    },
    { id: 'tip-suggestions', type: 'tipSuggestions' },
    {
      id: 'footer',
      type: 'text',
      text: '¡Gracias por su visita!',
      align: 'center',
      size: 'normal',
      bold: false,
    },
  ],
};

export interface PointReceiptItem {
  name: string;
  variant: string | null;
  quantity: number;
  subtotal: string;
}

export interface PointReceiptPayment {
  method: string;
  amount: string;
  tipAmount: string;
}

export interface PointReceiptInput {
  organizationName: string;
  organizationAddress: string | null;
  /** RFC del negocio (FiscalProfile); se imprime solo si existe. */
  organizationRfc: string | null;
  branchName: string | null;
  branchAddress: string | null;
  currency: string;
  order: {
    ticketNumber: number | null;
    /** AAAAMMDD + consecutivo, para reclamos. */
    ticketUid: string | null;
    tableNumber: string | null;
    partySize: number;
    isTakeaway: boolean;
    channel: string;
    customerName: string | null;
    issuedAt: Date;
    /** Neto sin IVA, ya con los descuentos aplicados (como la comanda). */
    subtotal: string;
    taxTotal: string;
    /** Suma de descuentos por promoción de las líneas. */
    discountTotal: string;
    deliveryFee: string;
    /** Total con IVA y descuentos; no incluye propina. */
    total: string;
    items: PointReceiptItem[];
    payments: PointReceiptPayment[];
  };
}

export interface ReceiptRenderResult {
  content: string;
  warnings: string[];
}

const LINE_WIDTH = 32;
/** Columnas que ocupa la letra grande (`{w}`). */
const LARGE_WIDTH = 18;
const MAX_CONTENT = 4096;
const CONTENT_BUDGET = 3700;
const MAX_ITEM_LINES = 25;

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  MERCADO_PAGO_POINT: 'Tarjeta - Terminal Point',
  MERCADO_PAGO_LINK: 'Mercado Pago (link)',
};

const DATE_FORMATTER = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'short',
  timeStyle: 'short',
  hour12: false,
  timeZone: 'America/Mexico_City',
});

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Plantilla por defecto clonada para que el editor pueda modificarla. */
export function defaultReceiptTemplate(): ReceiptTemplate {
  return JSON.parse(JSON.stringify(DEFAULT_RECEIPT_TEMPLATE)) as ReceiptTemplate;
}

/** Valida una plantilla. Lanza si no cumple el esquema. */
export function parseReceiptTemplate(value: unknown): ReceiptTemplate {
  return receiptTemplateSchema.parse(value);
}

/** Plantilla guardada o la default si está vacía/es inválida. */
export function receiptTemplateOrDefault(value: unknown): ReceiptTemplate {
  if (value === null || value === undefined) return defaultReceiptTemplate();

  const parsed = receiptTemplateSchema.safeParse(value);

  return parsed.success ? parsed.data : defaultReceiptTemplate();
}

function money(value: string, currency: string): string {
  const amount = Number(value);

  if (!Number.isFinite(amount)) return `$${value}`;

  let formatter = moneyFormatters.get(currency);

  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency,
        currencyDisplay: 'symbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      formatter = new Intl.NumberFormat('es-MX', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    moneyFormatters.set(currency, formatter);
  }

  return formatter.format(amount);
}

function cents(value: string): number {
  const amount = Number(value);

  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** Quita las llaves para que un nombre no rompa las etiquetas de MP. */
function sanitize(value: string): string {
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;

  return `${value.slice(0, Math.max(1, max - 3))}...`;
}

/**
 * Línea de ancho completo con el texto a la izquierda.
 *
 * El relleno de espacios hace que la línea mida exactamente 32 columnas, de
 * modo que se vea como se vea la alineación del firmware, el texto arranca en
 * el margen izquierdo.
 */
function fillLine(text: string, width = LINE_WIDTH): string {
  return truncate(text, width).padEnd(width, ' ');
}

/** Línea de ancho completo con el texto centrado. */
function centerLine(text: string, width = LINE_WIDTH): string {
  const value = truncate(text, width);
  const offset = Math.floor((width - value.length) / 2);

  return `${' '.repeat(offset)}${value}`.padEnd(width, ' ');
}

/** Línea de dos columnas (concepto a la izquierda, importe a la derecha). */
function pad(left: string, right: string): string {
  const maxLeft = Math.max(1, LINE_WIDTH - right.length - 1);
  const clipped =
    left.length > maxLeft
      ? `${left.slice(0, Math.max(1, maxLeft - 3))}...`
      : left;
  const spaces = Math.max(1, LINE_WIDTH - clipped.length - right.length);

  return `${clipped}${' '.repeat(spaces)}${right}`;
}

function placeLabel(order: PointReceiptInput['order']): string {
  return order.tableNumber
    ? `Mesa ${order.tableNumber}`
    : order.isTakeaway || order.channel === 'COUNTER'
      ? 'Mostrador'
      : order.channel === 'DELIVERY'
        ? 'Domicilio'
        : order.channel === 'PHONE'
          ? 'Teléfono'
          : 'Mostrador';
}

function wrapText(text: string, width: number): string[] {
  const normalized = sanitize(text);

  if (!normalized) return [''];

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }

      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }

      continue;
    }

    const next = current ? `${current} ${word}` : word;

    if (next.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);

  return lines.length > 0 ? lines : [''];
}

/**
 * Da formato a una línea.
 *
 * En tamaño normal la posición se resuelve con espacios y no con etiquetas:
 * `{left}` no funciona en la terminal y las líneas terminaban a la derecha.
 * Para tamaños pequeños/grandes se conservan las etiquetas de Mercado Pago.
 */
function styledLine(
  text: string,
  align: ReceiptAlign,
  size: ReceiptSize,
  bold: boolean,
): string {
  if (size === 'normal') {
    const line = align === 'center' ? centerLine(text) : fillLine(text);

    return bold ? `{b}${line}{/b}` : line;
  }

  const width = size === 'large' ? LARGE_WIDTH : LINE_WIDTH;
  const line =
    align === 'center' ? centerLine(text, width) : truncate(text, width);
  const sized = size === 'large' ? `{w}${line}{/w}` : `{s}${line}{/s}`;
  const styled = bold ? `{b}${sized}{/b}` : sized;

  return align === 'center' ? `{center}${styled}{/center}` : styled;
}

/** Caracteres que el editor debe evitar (emojis, comillas tipográficas...). */
export function unsupportedReceiptChars(text: string): string[] {
  const found = new Set<string>();

  for (const char of text) {
    if (/[\p{L}\p{N}\s.,;:!¡?¿'"()\[\]\-_+*=@#%&$/]/u.test(char)) {
      continue;
    }

    found.add(char);
  }

  return [...found];
}

class ReceiptTextBuilder {
  private readonly lines: string[] = [];
  private length = 0;
  private skipped = false;
  readonly warnings: string[] = [];

  push(line: string): boolean {
    const nextLength = this.length === 0 ? line.length : this.length + 4 + line.length;

    if (nextLength > CONTENT_BUDGET) {
      this.skipped = true;
      return false;
    }

    this.lines.push(line);
    this.length = nextLength;
    return true;
  }

  /** Agrega un bloque de texto con salto de línea y etiquetas. */
  pushText(
    text: string,
    align: ReceiptAlign,
    size: ReceiptSize,
    bold: boolean,
  ): void {
    const width = size === 'large' ? LARGE_WIDTH : LINE_WIDTH;

    for (const line of wrapText(text, width)) {
      this.push(styledLine(line, align, size, bold));
    }
  }

  get content(): string {
    let content = this.lines.join('{br}');

    if (this.skipped) {
      this.warnings.push(
        'El ticket es muy largo: se omitieron bloques para no superar el límite de Mercado Pago.',
      );
    }

    if (content.length > MAX_CONTENT) {
      const safe = content.slice(0, MAX_CONTENT);
      const cut = safe.lastIndexOf('{br}');

      content = `${
        cut > 0 ? safe.slice(0, cut) : safe
      }{br}${centerLine('Ticket incompleto')}{br}`;
      this.warnings.push('El ticket superó 4096 caracteres y se recortó.');
    }

    if (content.length < 100) {
      content += '{br}'.repeat(Math.ceil((100 - content.length) / 4));
      this.warnings.push(
        'El ticket es muy corto; se rellenó para cumplir el mínimo de MP.',
      );
    }

    return content;
  }
}

function renderBusinessBlock(
  block: Extract<ReceiptBlock, { type: 'business' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const organizationName = sanitize(input.organizationName || 'Naranja Pimienta');
  const branchName = input.branchName ? sanitize(input.branchName) : null;
  const rfc = input.organizationRfc
    ? sanitize(input.organizationRfc).toUpperCase()
    : null;
  const address = sanitize(
    input.branchAddress ?? input.organizationAddress ?? '',
  );

  if (block.showName) {
    builder.push(
      styledLine(organizationName.toUpperCase(), block.align, 'normal', true),
    );
  }

  if (block.showBranch && branchName) {
    builder.push(styledLine(branchName, block.align, 'normal', false));
  }

  if (block.showRfc && rfc) {
    builder.push(
      styledLine(`RFC: ${rfc}`, block.align, 'normal', false),
    );
  }

  if (block.showAddress && address) {
    builder.push(styledLine(address, block.align, 'normal', false));
  }
}

function renderTicketBlock(
  block: Extract<ReceiptBlock, { type: 'ticket' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const parts: string[] = [];

  if (block.showTicket) {
    parts.push(
      input.order.ticketNumber
        ? `Ticket #${formatTicketNumber(input.order.ticketNumber)}`
        : 'Cuenta',
    );
  }

  if (block.showDate) {
    parts.push(DATE_FORMATTER.format(input.order.issuedAt));
  }

  if (parts.length > 0) {
    builder.push(
      styledLine(
        truncate(parts.join(' - '), LINE_WIDTH),
        block.align,
        'normal',
        false,
      ),
    );
  }
}

function renderOrderBlock(
  block: Extract<ReceiptBlock, { type: 'order' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const fields = new Set(block.fields);
  const order = input.order;

  if (fields.has('place')) {
    let line = placeLabel(order);

    if (fields.has('partySize') && order.partySize > 1) {
      line += ` - ${order.partySize} personas`;
    }

    builder.push(styledLine(line, block.align, 'normal', false));
  } else if (fields.has('partySize') && order.partySize > 1) {
    builder.push(
      styledLine(`${order.partySize} personas`, block.align, 'normal', false),
    );
  }

  if (fields.has('customer') && order.customerName) {
    builder.push(
      styledLine(
        `Cliente: ${truncate(sanitize(order.customerName), LINE_WIDTH - 9)}`,
        block.align,
        'normal',
        false,
      ),
    );
  }
}

interface GroupedReceiptItem {
  name: string;
  variant: string | null;
  quantity: number;
  subtotalCents: number;
}

/**
 * Agrupa líneas iguales aunque vengan de rondas distintas.
 *
 * La clave es nombre + presentación normalizados, que es justo lo que se
 * imprime. El subtotal se suma en centavos para no arrastrar decimales.
 */
function groupItems(
  items: PointReceiptInput['order']['items'],
  showVariant: boolean,
): GroupedReceiptItem[] {
  const groups = new Map<string, GroupedReceiptItem>();

  for (const item of items) {
    const name = sanitize(item.name);
    const variant =
      showVariant && item.variant ? sanitize(item.variant) : null;
    const key = `${name.toLowerCase()}::${(variant ?? '').toLowerCase()}`;
    const current = groups.get(key);

    if (current) {
      current.quantity += item.quantity;
      current.subtotalCents += cents(item.subtotal);
    } else {
      groups.set(key, {
        name,
        variant,
        quantity: item.quantity,
        subtotalCents: cents(item.subtotal),
      });
    }
  }

  return [...groups.values()];
}

function renderItemsBlock(
  block: Extract<ReceiptBlock, { type: 'items' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const grouped = groupItems(input.order.items, block.showVariant);
  const visibleItems = grouped.slice(0, MAX_ITEM_LINES);
  let rendered = 0;

  for (const item of visibleItems) {
    const variant = item.variant ? ` ${item.variant}` : '';
    const label = block.showQuantity
      ? `${item.quantity} x ${item.name}${variant}`
      : `${item.name}${variant}`;
    let pushed = false;

    if (block.showLineTotal) {
      const amount = money(
        (item.subtotalCents / 100).toFixed(2),
        input.currency,
      );

      if (label.length + amount.length + 1 > LINE_WIDTH) {
        // El nombre y el precio no caben en 32 columnas: el precio va en su
        // propia línea, alineado al borde derecho con espacios.
        pushed =
          builder.push(fillLine(label)) &&
          builder.push(pad('', amount));
      } else {
        pushed = builder.push(pad(label, amount));
      }
    } else {
      pushed = builder.push(fillLine(label));
    }

    if (!pushed) break;

    rendered += 1;
  }

  if (rendered < grouped.length) {
    builder.push(`... y ${grouped.length - rendered} más`);
  }
}

function renderTotalsBlock(
  block: Extract<ReceiptBlock, { type: 'totals' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const fields = new Set(block.fields);

  if (fields.size === 0) return;

  const taxCents = cents(input.order.taxTotal);
  const discountCents = cents(input.order.discountTotal);
  const deliveryCents = cents(input.order.deliveryFee);
  const tipCents = input.order.payments.reduce(
    (sum, payment) => sum + cents(payment.tipAmount),
    0,
  );
  const totalCents = cents(input.order.total);
  const grandTotalCents = totalCents + tipCents;

  // `order.subtotal` es el neto sin IVA que ya incluye el envío y los
  // descuentos (igual que la comanda). Para el ticket se muestra el precio de
  // lista sin IVA, de modo que la cuenta del SAT cierre:
  // subtotal + IVA - descuento + envío + propina = total cobrado.
  const storedNetCents = cents(input.order.subtotal) - deliveryCents;
  const itemsGrossCents = input.order.items.reduce(
    (sum, item) => sum + cents(item.subtotal),
    0,
  );
  const netItemsCents =
    cents(input.order.subtotal) > 0
      ? Math.max(0, storedNetCents)
      : Math.max(0, itemsGrossCents - taxCents);
  const subtotalCents = netItemsCents + discountCents;

  for (const field of TOTAL_FIELD_ORDER) {
    if (!fields.has(field)) continue;

    if (field === 'subtotal') {
      builder.push(
        pad('Subtotal', money((subtotalCents / 100).toFixed(2), input.currency)),
      );
    }

    if (field === 'tax' && taxCents > 0) {
      builder.push(
        pad('IVA', money((taxCents / 100).toFixed(2), input.currency)),
      );
    }

    if (field === 'discount' && discountCents > 0) {
      builder.push(
        pad(
          'Descuento',
          `-${money((discountCents / 100).toFixed(2), input.currency)}`,
        ),
      );
    }

    if (field === 'delivery' && deliveryCents > 0) {
      builder.push(
        pad('Envío', money((deliveryCents / 100).toFixed(2), input.currency)),
      );
    }

    if (field === 'tip' && tipCents > 0) {
      builder.push(
        pad('Propina', money((tipCents / 100).toFixed(2), input.currency)),
      );
    }

    if (field === 'total') {
      builder.push(
        `{b}${pad(
          tipCents > 0 ? 'TOTAL COBRADO' : 'TOTAL',
          money((grandTotalCents / 100).toFixed(2), input.currency),
        )}{/b}`,
      );
    }
  }

  const paidCents = input.order.payments.reduce(
    (sum, payment) => sum + cents(payment.amount),
    0,
  );

  if (
    fields.has('total') &&
    input.order.payments.length > 0 &&
    paidCents < totalCents
  ) {
    builder.push(
      pad('Pagado', money((paidCents / 100).toFixed(2), input.currency)),
    );
    builder.push(
      pad(
        'Saldo',
        money(((totalCents - paidCents) / 100).toFixed(2), input.currency),
      ),
    );
  }
}

function renderPaymentsBlock(
  block: Extract<ReceiptBlock, { type: 'payments' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  // En una cuenta de mesa sin pagar no se imprime la sección de pagos.
  if (input.order.payments.length === 0) return;

  if (block.showTitle) {
    builder.push(styledLine('PAGOS', 'left', 'normal', true));
  }

  for (const payment of input.order.payments) {
    const label =
      PAYMENT_METHOD_LABELS[payment.method] ?? sanitize(payment.method);
    const amount = money(payment.amount, input.currency);

    if (block.showMethod && block.showAmount) {
      builder.push(pad(label, amount));
    } else if (block.showMethod) {
      builder.push(fillLine(label));
    } else if (block.showAmount) {
      builder.push(pad('', amount));
    }
  }

  // Separador de salida solo cuando la sección se imprime.
  builder.push('-'.repeat(LINE_WIDTH));
}

/** Porcentajes de propina que se imprimen en el ticket. */
const TIP_SUGGESTION_PERCENTAGES = [10, 15, 20] as const;

/**
 * Sugerencias de propina para la cuenta de mesa antes de cobrar.
 *
 * Solo se imprimen en servicio a mesa y mientras no haya pagos confirmados:
 * en ventanilla el ticket lleva la sección de pagos, no sugerencias.
 */
function renderTipSuggestionsBlock(
  _block: Extract<ReceiptBlock, { type: 'tipSuggestions' }>,
  input: PointReceiptInput,
  builder: ReceiptTextBuilder,
): void {
  const isTableService =
    input.order.channel === 'DINE_IN' && !input.order.isTakeaway;
  const hasPayments = input.order.payments.length > 0;
  const tipCents = input.order.payments.reduce(
    (sum, payment) => sum + cents(payment.tipAmount),
    0,
  );

  if (!isTableService || hasPayments || tipCents > 0) return;

  builder.push(styledLine('Propina sugerida', 'left', 'normal', true));

  const totalCents = cents(input.order.total);

  for (const percent of TIP_SUGGESTION_PERCENTAGES) {
    const amountCents = Math.round((totalCents * percent) / 100);

    builder.push(
      pad(
        `${percent}%`,
        money((amountCents / 100).toFixed(2), input.currency),
      ),
    );
  }

  // Separador de salida: solo aparece cuando el bloque se imprime, así no
  // quedan dos líneas seguidas cuando no hay sugerencias.
  builder.push('-'.repeat(LINE_WIDTH));
}

/**
 * Construye el contenido del ticket a partir de la plantilla y los datos.
 *
 * Es una función pura para poder probar el formato sin Mercado Pago ni la base
 * de datos.
 */
export function renderReceiptText(
  template: ReceiptTemplate,
  input: PointReceiptInput,
): ReceiptRenderResult {
  const builder = new ReceiptTextBuilder();
  const warnings = builder.warnings;

  for (const block of template.blocks) {
    switch (block.type) {
      case 'business':
        renderBusinessBlock(block, input, builder);
        break;
      case 'ticket':
        renderTicketBlock(block, input, builder);
        break;
      case 'order':
        renderOrderBlock(block, input, builder);
        break;
      case 'items':
        renderItemsBlock(block, input, builder);
        break;
      case 'totals':
        renderTotalsBlock(block, input, builder);
        break;
      case 'payments':
        renderPaymentsBlock(block, input, builder);
        break;
      case 'tipSuggestions':
        renderTipSuggestionsBlock(block, input, builder);
        break;
      case 'text':
        builder.pushText(block.text, block.align, block.size, block.bold);
        break;
      case 'divider':
        builder.push('-'.repeat(LINE_WIDTH));
        break;
    }
  }

  const unsupported = new Set<string>();

  for (const line of [
    input.organizationName,
    input.organizationRfc ?? '',
    input.branchName ?? '',
    input.organizationAddress ?? '',
    input.branchAddress ?? '',
    input.order.customerName ?? '',
    ...input.order.items.flatMap((item) => [item.name, item.variant ?? '']),
    ...template.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text),
  ]) {
    for (const char of unsupportedReceiptChars(line)) unsupported.add(char);
  }

  if (unsupported.size > 0) {
    warnings.push(
      `Caracteres que la impresora podría no mostrar: ${[...unsupported].join(
        ' ',
      )}`,
    );
  }

  let content = builder.content;

  // Folio de reclamos: siempre al final, pequeño y centrado. Va fuera de la
  // plantilla para que ningún bloque lo desplace.
  if (input.order.ticketUid) {
    const uidLine = `{center}{s}#${input.order.ticketUid}{/s}{/center}`;
    const next = `${content}{br}${uidLine}`;

    if (next.length <= MAX_CONTENT) {
      content = next;
    } else {
      const cut = content.slice(0, MAX_CONTENT - uidLine.length - 4);
      const lastBreak = cut.lastIndexOf('{br}');

      content = `${
        lastBreak > 0 ? cut.slice(0, lastBreak) : cut
      }{br}${uidLine}`;
      warnings.push('El ticket se recortó para incluir el folio.');
    }
  }

  return { content, warnings };
}

/** Compatibilidad con el ticket clásico. */
export function buildPointReceipt(input: PointReceiptInput): string {
  return renderReceiptText(defaultReceiptTemplate(), input).content;
}

/** HTML seguro para la vista previa del editor (32 columnas). */
export function renderReceiptPreviewHtml(content: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const inline = (value: string): string => {
    const tokens = value.split(/(\{[^{}]*\})/g);
    let html = '';

    for (const token of tokens) {
      switch (token) {
        case '{b}':
          html += '<strong>';
          break;
        case '{/b}':
          html += '</strong>';
          break;
        case '{w}':
          html += '<span style="font-size:1.25em">';
          break;
        case '{/w}':
          html += '</span>';
          break;
        case '{s}':
          html += '<span style="font-size:0.78em">';
          break;
        case '{/s}':
          html += '</span>';
          break;
        default:
          html += escape(token);
      }
    }

    return html;
  };

  const lines = content.split('{br}');
  let html = '';

  for (const rawLine of lines) {
    let line = rawLine;
    let align: ReceiptAlign | null = null;

    if (line.startsWith('{center}') && line.endsWith('{/center}')) {
      align = 'center';
      line = line.slice('{center}'.length, -'{/center}'.length);
    } else if (line.startsWith('{left}') && line.endsWith('{/left}')) {
      align = 'left';
      line = line.slice('{left}'.length, -'{/left}'.length);
    }

    if (!line) {
      html += '<br/>';
      continue;
    }

    if (align) {
      html += `<div style="text-align:${align}">${inline(line)}</div>`;
    } else {
      html += `${inline(line)}<br/>`;
    }
  }

  return html;
}
