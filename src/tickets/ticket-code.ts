/** Zona horaria del negocio para el corte diario de tickets. */
const BUSINESS_TIME_ZONE = 'America/Mexico_City';
const TICKET_NUMBER_WIDTH = 3;

/** `1` → `001`. */
export function formatTicketNumber(value: number): string {
  return String(value).padStart(TICKET_NUMBER_WIDTH, '0');
}

/** `2026-11-24 23:30 CDMX` → `20261124`. */
export function ticketDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return `${values.get('year')}${values.get('month')}${values.get('day')}`;
}

/**
 * Fecha de corte para `BranchDailySequence.date`.
 *
 * Se construye a medianoche UTC para que la columna `date` de PostgreSQL
 * guarde exactamente el día del negocio, sin depender del TZ del servidor.
 */
export function ticketDay(date: Date): Date {
  const key = ticketDayKey(date);

  return new Date(
    `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00.000Z`,
  );
}

/** `20261124` + `001` → `20261124001`. */
export function formatTicketUid(date: Date, number: number): string {
  return `${ticketDayKey(date)}${formatTicketNumber(number)}`;
}
