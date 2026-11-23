import { trendFrom, weekdayFactorsFrom } from './forecast.service';

describe('forecast helpers', () => {
  it('devuelve factores neutros cuando no hay consumo', () => {
    expect(weekdayFactorsFrom(new Map(), 84, 0)).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ]);
  });

  it('compara cada día con el promedio y limita el factor', () => {
    const factors = weekdayFactorsFrom(
      new Map([
        [0, 14],
        [1, 7],
      ]),
      14,
      1,
    );

    expect(factors[0]).toBe(2);
    expect(factors[1]).toBe(2);
    expect(factors[2]).toBe(0.5);
  });

  it('limita la tendencia entre 0.7 y 1.3', () => {
    expect(trendFrom(10, 10)).toBe(1);
    expect(trendFrom(100, 10)).toBe(1.3);
    expect(trendFrom(1, 10)).toBe(0.7);
    expect(trendFrom(5, 0)).toBe(1);
  });
});
