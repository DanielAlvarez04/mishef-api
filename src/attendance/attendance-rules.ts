/** Reglas de tolerancia del checador. */
export interface AttendanceRules {
  applyTolerance: boolean;
  lateGraceMinutes: number;
  lunchGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  defaultBreakMinutes: number;
}

/** Lunes 00:00 local de la semana de `date`. */
export function startOfWeek(date: Date = new Date()): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

/** Fecha local a medianoche, sin hora. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `YYYY-MM-DD` local de una fecha. */
export function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** `"09:00"` en el día indicado. */
export function timeOnDay(day: Date, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    0,
    0,
  );
}

/** Rango del turno; si la salida es menor que la entrada, cruza medianoche. */
export function scheduledRange(
  day: Date,
  startTime: string,
  endTime: string,
): { start: Date; end: Date } {
  const start = timeOnDay(day, startTime);
  let end = timeOnDay(day, endTime);

  if (end <= start) {
    end = addDays(end, 1);
  }

  return { start, end };
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Entrada efectiva:
 * - si llega dentro de la tolerancia, se registra la hora programada;
 * - si llega antes, cuenta la hora real (no se recorta);
 * - si llega después de la tolerancia, cuenta la hora real.
 */
export function effectiveStart(
  raw: Date,
  scheduledStart: Date | null,
  rules: AttendanceRules,
): Date {
  if (!scheduledStart || !rules.applyTolerance) return raw;
  if (raw <= scheduledStart) return raw;

  const graceEnd = addMinutes(scheduledStart, Math.max(0, rules.lateGraceMinutes));
  return raw <= graceEnd ? scheduledStart : raw;
}

/**
 * Salida efectiva:
 * - si sale dentro de la tolerancia antes del fin, se registra la hora
 *   programada;
 * - si sale antes de esa ventana, cuenta la hora real;
 * - si sale después, cuenta la hora real (horas extra).
 */
export function effectiveEnd(
  raw: Date,
  scheduledEnd: Date | null,
  rules: AttendanceRules,
): Date {
  if (!scheduledEnd || !rules.applyTolerance) return raw;

  const graceStart = addMinutes(
    scheduledEnd,
    -Math.max(0, rules.earlyLeaveGraceMinutes),
  );

  return raw >= graceStart && raw <= scheduledEnd ? scheduledEnd : raw;
}

/**
 * Minutos que se descuentan por una comida/descanso.
 *
 * Una comida más corta descuenta lo real; hasta la tolerancia se descuenta lo
 * planeado; pasada la tolerancia se descuenta lo real.
 */
export function effectiveBreakMinutes(
  rawMinutes: number,
  plannedMinutes: number,
  rules: AttendanceRules,
): number {
  const raw = Math.max(0, Math.round(rawMinutes));

  if (!rules.applyTolerance || plannedMinutes <= 0) return raw;
  if (raw <= plannedMinutes) return raw;

  return raw <= plannedMinutes + Math.max(0, rules.lunchGraceMinutes)
    ? plannedMinutes
    : raw;
}

/** Duración en minutos entre dos fechas, nunca negativa. */
export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}
