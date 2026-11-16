import {
  MIN_COHORT,
  buildBenchmarkMetric,
  percentile,
  percentileRank,
} from './benchmark';

describe('benchmark — estadística anónima', () => {
  it('calcula percentiles con interpolación', () => {
    const values = [10, 20, 30, 40, 50];

    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 1)).toBe(50);
    expect(percentile(values, 0.25)).toBe(20);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('calcula el percentil del negocio dentro del grupo', () => {
    const values = [10, 20, 30, 40, 50];

    expect(percentileRank(values, 10)).toBe(20);
    expect(percentileRank(values, 30)).toBe(60);
    expect(percentileRank(values, 50)).toBe(100);
    expect(percentileRank(values, 5)).toBe(0);
  });

  it('no publica percentiles con menos negocios que el mínimo', () => {
    const cohort = Array.from({ length: MIN_COHORT - 1 }, (_, i) => i + 1);

    expect(
      buildBenchmarkMetric({
        key: 'averageTicket',
        label: 'Ticket promedio',
        betterWhen: 'higher',
        mine: 10,
        cohort,
      }),
    ).toBeNull();
  });

  it('construye la métrica cuando el grupo alcanza el mínimo', () => {
    const metric = buildBenchmarkMetric({
      key: 'foodCostPct',
      label: 'Food cost',
      betterWhen: 'lower',
      mine: 0.28,
      cohort: [0.2, 0.25, 0.3, 0.35, 0.4],
    });

    expect(metric).not.toBeNull();
    expect(metric?.betterWhen).toBe('lower');
    expect(metric?.value).toBe(0.28);
    expect(metric?.p50).toBe(0.3);
    expect(metric?.percentile).toBe(40);
  });

  it('ignora valores inválidos del grupo y el valor propio ausente', () => {
    expect(
      buildBenchmarkMetric({
        key: 'rotation',
        label: 'Rotación',
        betterWhen: 'higher',
        mine: null,
        cohort: [1, 2, 3, 4, 5],
      }),
    ).toBeNull();

    expect(
      buildBenchmarkMetric({
        key: 'rotation',
        label: 'Rotación',
        betterWhen: 'higher',
        mine: 3,
        cohort: [1, 2, Number.NaN, 4, 5],
      }),
    ).toBeNull();
  });
});
