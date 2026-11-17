/**
 * Estadística del benchmark anónimo.
 *
 * Todo se calcula sobre valores ya agregados por negocio: nunca se expone el
 * dato individual de otra organización, solo percentiles del grupo.
 */

/** Mínimo de negocios con datos para publicar percentiles. */
export const MIN_COHORT = 5;

/** Radio por defecto del benchmark local, en kilómetros. */
export const LOCAL_BENCHMARK_RADIUS_KM = 50;

export type BetterWhen = 'higher' | 'lower';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Distancia en kilómetros entre dos coordenadas (Haversine).
 *
 * Se usa para decidir si dos negocios están en la misma zona. No se guarda ni
 * se expone la ubicación de la otra organización: solo se compara la distancia.
 */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusKm = 6371.0088;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}


/** Percentil con interpolación lineal sobre una lista ya ordenada. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;

  const clamped = Math.min(1, Math.max(0, p));
  const index = (sorted.length - 1) * clamped;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Porcentaje del grupo que queda en tu valor o por debajo (0–100). */
export function percentileRank(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;

  const belowOrEqual = sorted.filter((item) => item <= value).length;

  return Math.round((belowOrEqual / sorted.length) * 100);
}

export interface BenchmarkMetric {
  key: string;
  label: string;
  betterWhen: BetterWhen;
  value: number;
  /** Percentil del negocio dentro del grupo (0–100). */
  percentile: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/**
 * Construye una métrica comparable.
 *
 * Devuelve `null` si el negocio no tiene valor o si el grupo no llega al
 * mínimo: con pocos negocios, un percentil permitiría deducir el dato de otro.
 */
export function buildBenchmarkMetric(input: {
  key: string;
  label: string;
  betterWhen: BetterWhen;
  mine: number | null;
  cohort: number[];
}): BenchmarkMetric | null {
  const values = input.cohort.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );

  if (input.mine === null || !Number.isFinite(input.mine)) return null;
  if (values.length < MIN_COHORT) return null;

  const sorted = [...values].sort((a, b) => a - b);

  const p25 = percentile(sorted, 0.25);
  const p50 = percentile(sorted, 0.5);
  const p75 = percentile(sorted, 0.75);
  const p90 = percentile(sorted, 0.9);

  if (p25 === null || p50 === null || p75 === null || p90 === null) {
    return null;
  }

  const round2 = (value: number) =>
    Math.round((value + Number.EPSILON) * 100) / 100;

  return {
    key: input.key,
    label: input.label,
    betterWhen: input.betterWhen,
    value: round2(input.mine),
    percentile: percentileRank(sorted, input.mine),
    p25: round2(p25),
    p50: round2(p50),
    p75: round2(p75),
    p90: round2(p90),
  };
}
