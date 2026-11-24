/**
 * Ticket itemizado para imprimir en una terminal Point Smart.
 *
 * La API de impresión personalizada de Mercado Pago recibe texto con etiquetas
 * propias (`{b}`, `{w}`, `{s}`, `{br}`, `{center}`, ...). El contenido debe
 * medir entre 100 y 4096 caracteres, por eso se construye con presupuesto y se
 * recorta a un ancho de 42 columnas para el papel de 58 mm.
 */

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
  branchName: string | null;
  branchAddress: string | null;
  currency: string;
  order: {
    ticketNumber: number | null;
    tableNumber: string | null;
    partySize: number;
    isTakeaway: boolean;
    channel: string;
    customerName: string | null;
    issuedAt: Date;
    subtotal: string;
    taxTotal: string;
    deliveryFee: string;
    total: string;
    items: PointReceiptItem[];
    payments: PointReceiptPayment[];
  };
}

const LINE_WIDTH = 42;
const MAX_CONTENT = 4096;
/** Se deja espacio para totales y pie antes de llegar al límite de MP. */
const CONTENT_BUDGET = 3700;
const MAX_ITEM_LINES = 40;

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
  const place = order.tableNumber
    ? `Mesa ${order.tableNumber}`
    : order.isTakeaway || order.channel === 'COUNTER'
      ? 'Mostrador'
      : order.channel === 'DELIVERY'
        ? 'Domicilio'
        : order.channel === 'PHONE'
          ? 'Teléfono'
          : 'Mostrador';

  if (order.isTakeaway || order.channel !== 'DINE_IN' || order.partySize <= 1) {
    return place;
  }

  return `${place} - ${order.partySize} personas`;
}

/**
 * Construye el contenido del ticket.
 *
 * Es una función pura para poder probar el formato sin Mercado Pago ni la base
 * de datos.
 */
export function buildPointReceipt(input: PointReceiptInput): string {
  const { order } = input;
  const currency = input.currency || 'MXN';
  const lines: string[] = [];
  let length = 0;

  const push = (line: string): boolean => {
    const nextLength = length === 0 ? line.length : length + 4 + line.length;

    if (nextLength > CONTENT_BUDGET) return false;

    lines.push(line);
    length = nextLength;
    return true;
  };

  const organizationName = sanitize(
    input.organizationName || 'Naranja Pimienta',
  );
  const branchName = input.branchName ? sanitize(input.branchName) : null;
  const address = sanitize(
    input.branchAddress ?? input.organizationAddress ?? '',
  );
  const ticket = order.ticketNumber
    ? `Ticket #${order.ticketNumber}`
    : 'Cuenta';
  const date = DATE_FORMATTER.format(order.issuedAt);

  push(`{center}{w}${truncate(organizationName.toUpperCase(), 18)}{/w}{/center}`);

  if (
    branchName &&
    branchName.toUpperCase() !== organizationName.toUpperCase()
  ) {
    push(`{center}{s}${truncate(branchName, LINE_WIDTH)}{/s}{/center}`);
  }

  if (address) {
    push(`{center}{s}${truncate(address, LINE_WIDTH)}{/s}{/center}`);
  }

  push(`{center}{s}${ticket} - ${date}{/s}{/center}`);
  push('-'.repeat(LINE_WIDTH));
  push(`{left}{s}${truncate(placeLabel(order), LINE_WIDTH)}{/s}{/left}`);

  if (order.customerName) {
    push(
      `{left}{s}Cliente: ${truncate(
        sanitize(order.customerName),
        LINE_WIDTH - 9,
      )}{/s}{/left}`,
    );
  }

  push(`{left}{b}PRODUCTOS{/b}{/left}`);

  const visibleItems = order.items.slice(0, MAX_ITEM_LINES);

  for (const item of visibleItems) {
    const name = sanitize(item.name);
    const variant = item.variant ? ` (${sanitize(item.variant)})` : '';
    const label = `${item.quantity} x ${name}${variant}`;

    if (!push(`{s}${pad(label, money(item.subtotal, currency))}{/s}`)) break;
  }

  if (order.items.length > visibleItems.length) {
    push(`{s}... y ${order.items.length - visibleItems.length} más{/s}`);
  }

  push('-'.repeat(LINE_WIDTH));

  // Los precios del catálogo ya incluyen IVA. Se muestra el subtotal de los
  // productos y el IVA como dato informativo para que las sumas coincidan.
  const itemsGrossCents = order.items.reduce(
    (sum, item) => sum + cents(item.subtotal),
    0,
  );
  const subtotalCents =
    itemsGrossCents > 0 ? itemsGrossCents : cents(order.subtotal);

  push(pad('Subtotal', money((subtotalCents / 100).toFixed(2), currency)));

  if (cents(order.deliveryFee) > 0) {
    push(pad('Envío', money(order.deliveryFee, currency)));
  }

  if (cents(order.taxTotal) > 0) {
    push(pad('IVA incluido', money(order.taxTotal, currency)));
  }

  const tipCents = order.payments.reduce(
    (sum, payment) => sum + cents(payment.tipAmount),
    0,
  );
  const totalCents = cents(order.total);
  const grandTotalCents = totalCents + tipCents;

  if (tipCents > 0) {
    push(
      pad(
        'Propina',
        money((tipCents / 100).toFixed(2), currency),
      ),
    );
  }

  push(
    `{b}${pad(
      tipCents > 0 ? 'TOTAL COBRADO' : 'TOTAL',
      money((grandTotalCents / 100).toFixed(2), currency),
    )}{/b}`,
  );

  const paidCents = order.payments.reduce(
    (sum, payment) => sum + cents(payment.amount),
    0,
  );

  if (paidCents < totalCents) {
    push(pad('Pagado', money((paidCents / 100).toFixed(2), currency)));
    push(
      pad(
        'Saldo',
        money(((totalCents - paidCents) / 100).toFixed(2), currency),
      ),
    );
  }

  if (order.payments.length > 0) {
    push(`{left}{b}PAGOS{/b}{/left}`);

    for (const payment of order.payments) {
      const label =
        PAYMENT_METHOD_LABELS[payment.method] ?? sanitize(payment.method);

      push(`{s}${pad(label, money(payment.amount, currency))}{/s}`);
    }
  }

  push('-'.repeat(LINE_WIDTH));
  push('{center}¡Gracias por su visita!{/center}');
  push('{br}');

  let content = lines.join('{br}');

  if (content.length > MAX_CONTENT) {
    const safe = content.slice(0, MAX_CONTENT);
    const cut = safe.lastIndexOf('{br}');

    content = `${
      cut > 0 ? safe.slice(0, cut) : safe
    }{br}{center}{s}Ticket incompleto{/s}{/center}{br}`;
  }

  if (content.length < 100) {
    content += '{br}'.repeat(Math.ceil((100 - content.length) / 4));
  }

  return content;
}
