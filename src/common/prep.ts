/**
 * Cálculo de tiempos de preparación y prioridad de cocina.
 *
 * Reglas (acordadas en el plan de cocina):
 * - El tiempo base es el del artículo o, si no tiene, el del negocio.
 * - El estimado de una ronda es el máximo de sus líneas más 15 % por cada
 *   línea distinta adicional: refleja preparación en paralelo con algo de
 *   carga. Se limita a 5–180 minutos.
 * - La calibración del promedio histórico termina a los 14 días o 20 rondas
 *   completadas, lo que ocurra primero (misma regla que la analítica).
 */

/** Minutos manuales por defecto cuando el negocio no configura otra cosa. */
export const DEFAULT_PREP_MINUTES = 15;

/** Rango permitido para cualquier tiempo de preparación. */
export const MIN_PREP_MINUTES = 5;
export const MAX_PREP_MINUTES = 180;

/** Carga añadida por cada línea distinta después de la primera. */
export const LINE_LOAD_FACTOR = 0.15;

/** Muestras y días que habilitan el promedio histórico. */
export const HISTORICAL_MIN_ROUNDS = 20;
export const HISTORICAL_MIN_DAYS = 14;

/** Ventana de datos usada para calcular el promedio histórico. */
export const HISTORICAL_WINDOW_DAYS = 30;

export type PrepPriority = 'on_time' | 'at_risk' | 'late';

export interface PrepEstimateInput {
  /** Minutos propios de cada línea (ya resueltos con el respaldo). */
  lineMinutes: number[];
  /** Número de líneas distintas (artículos diferentes). */
  distinctLines?: number;
}

/** Minutos válidos dentro del rango permitido. */
export function clampPrepMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREP_MINUTES;

  return Math.min(
    MAX_PREP_MINUTES,
    Math.max(MIN_PREP_MINUTES, Math.round(value)),
  );
}

/**
 * Estima los minutos de una ronda.
 *
 * `lineMinutes` debe traer un valor por línea de la comanda; las líneas
 * repetidas del mismo artículo cuentan para el máximo pero no para la carga.
 */
export function estimatePrepMinutes(input: PrepEstimateInput): number {
  const values = input.lineMinutes.filter((value) => Number.isFinite(value));

  if (values.length === 0) return DEFAULT_PREP_MINUTES;

  const base = Math.max(...values);
  const distinct = Math.max(
    1,
    input.distinctLines ?? new Set(values).size,
  );
  const estimate = base * (1 + LINE_LOAD_FACTOR * (distinct - 1));

  return clampPrepMinutes(estimate);
}

/** Etiqueta de prioridad a partir de la urgencia (tiempo / estimado). */
export function prepPriority(urgency: number): PrepPriority {
  if (urgency >= 1) return 'late';
  if (urgency >= 0.75) return 'at_risk';
  return 'on_time';
}

/** Mediana robusta: no la mueven los pedidos atípicos. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
