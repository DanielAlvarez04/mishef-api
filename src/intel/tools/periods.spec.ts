import { BadRequestException } from '@nestjs/common';

import { resolvePeriod } from './periods';

describe('resolvePeriod', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-23T12:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resuelve hoy desde el inicio del día', () => {
    const period = resolvePeriod({ period: 'today' });

    expect(period.label).toBe('Hoy');
    expect(period.from.getHours()).toBe(0);
    expect(period.from.getTime()).toBeLessThanOrEqual(period.to.getTime());
  });

  it('resuelve los últimos 7 días', () => {
    const period = resolvePeriod({ period: 'week' });

    expect(period.label).toBe('Últimos 7 días');
    expect(period.from.getHours()).toBe(0);
    expect(period.to.getTime() - period.from.getTime()).toBeGreaterThanOrEqual(
      6 * 24 * 60 * 60 * 1000,
    );
  });

  it('resuelve el mes actual desde el día 1', () => {
    const period = resolvePeriod({ period: 'month' });

    expect(period.label).toBe('Este mes');
    expect(period.from.getDate()).toBe(1);
    expect(period.from.getHours()).toBe(0);
  });

  it('acepta un rango personalizado y ajusta el final del día', () => {
    const period = resolvePeriod({
      from: '2026-11-01',
      to: '2026-11-15',
    });

    expect(period.key).toBe('custom');
    expect(period.to.getHours()).toBe(23);
    expect(period.to.getMinutes()).toBe(59);
  });

  it('rechaza un rango invertido', () => {
    expect(() =>
      resolvePeriod({ from: '2026-11-20', to: '2026-11-01' }),
    ).toThrow(BadRequestException);
  });

  it('exige from y to juntos', () => {
    expect(() => resolvePeriod({ from: '2026-11-01' })).toThrow(
      BadRequestException,
    );
  });
});
