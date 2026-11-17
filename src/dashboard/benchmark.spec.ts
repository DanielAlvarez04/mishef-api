import { PrismaService } from '../prisma/prisma.service';
import { distanceKm } from '../common/benchmark';
import { DashboardService } from './dashboard.service';

function build(
  orgIds: string[],
  current: Record<string, unknown> = { businessType: 'cafeteria' },
  nearby?: Array<{ id: string; latitude: number; longitude: number }>,
) {
  const revenue: Record<string, number> = {
    o1: 1000,
    o2: 2000,
    o3: 3000,
    o4: 4000,
    o5: 5000,
    o6: 6000,
  };

  const prisma: Record<string, any> = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(current),
      findMany: jest
        .fn()
        .mockResolvedValue(
          nearby ?? orgIds.map((id) => ({ id })),
        ),
    },
    payment: {
      aggregate: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve({
          _sum: { amount: revenue[where.organizationId] ?? 1000 },
        }),
      ),
    },
    order: { count: jest.fn().mockResolvedValue(10) },
    item: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const service = new DashboardService(prisma as unknown as PrismaService);

  return { service, prisma };
}

describe('DashboardService — benchmark', () => {
  it('no publica percentiles si la cohorte es pequeña', async () => {
    const { service } = build(['o1', 'o2', 'o3']);

    const result = await service.benchmark('o1', 30);

    expect(result.available).toBe(false);
    expect(result.reason).toBe('insufficient_cohort');
    expect(result.cohort).toMatchObject({ organizations: 3, minimum: 5 });
    expect(result.metrics).toEqual([]);
  });

  it('compara ticket promedio y rotación contra la cohorte', async () => {
    const { service } = build(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);

    const result = await service.benchmark('o1', 30);

    expect(result.available).toBe(true);

    const ticket = result.metrics.find((m) => m.key === 'averageTicket');
    expect(ticket).toMatchObject({
      value: 100,
      p50: 350,
      percentile: 17,
      betterWhen: 'higher',
    });

    const rotation = result.metrics.find((m) => m.key === 'rotation');
    // 10 cuentas / 30 días
    expect(rotation?.value).toBe(0.33);
  });

  it('omite food cost cuando ningún negocio tiene costos completos', async () => {
    const { service } = build(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);

    const result = await service.benchmark('o1', 30);

    expect(result.metrics.some((m) => m.key === 'foodCostPct')).toBe(false);
  });

  it('no devuelve datos sin organización', async () => {
    const { service, prisma } = build(['o1']);

    const result = await service.benchmark(null, 30);

    expect(result.available).toBe(false);
    expect(prisma.organization.findMany).not.toHaveBeenCalled();
  });

  it('usa la cohorte local de 50 km cuando hay suficientes negocios', async () => {
    const { service, prisma } = build(
      [],
      { businessType: 'cafeteria', latitude: 19.4326, longitude: -99.1332 },
      [
        { id: 'o1', latitude: 19.4326, longitude: -99.1332 },
        { id: 'o2', latitude: 19.433, longitude: -99.134 },
        { id: 'o3', latitude: 19.44, longitude: -99.14 },
        { id: 'o4', latitude: 19.45, longitude: -99.15 },
        { id: 'o5', latitude: 19.46, longitude: -99.16 },
      ],
    );

    const result = await service.benchmark('o1', 30);

    expect(result.available).toBe(true);
    expect(result.cohort).toMatchObject({
      scope: 'local',
      radiusKm: 50,
      organizations: 5,
    });
    expect(prisma.organization.findMany).toHaveBeenCalledTimes(1);
  });

  it('cae al grupo nacional si la zona no llega al mínimo', async () => {
    const { service, prisma } = build(
      [],
      { businessType: 'cafeteria', latitude: 19.4326, longitude: -99.1332 },
      [
        { id: 'o1', latitude: 19.4326, longitude: -99.1332 },
        { id: 'o2', latitude: 19.433, longitude: -99.134 },
      ],
    );
    prisma.organization.findMany.mockResolvedValueOnce([
      { id: 'o1', latitude: 19.4326, longitude: -99.1332 },
      { id: 'o2', latitude: 19.433, longitude: -99.134 },
    ]);
    prisma.organization.findMany.mockResolvedValueOnce([
      { id: 'o1' },
      { id: 'o2' },
      { id: 'o3' },
      { id: 'o4' },
      { id: 'o5' },
      { id: 'o6' },
    ]);

    const result = await service.benchmark('o1', 30);

    expect(result.available).toBe(true);
    expect(result.cohort).toMatchObject({
      scope: 'national',
      radiusKm: null,
      localCandidates: 2,
    });
    expect(prisma.organization.findMany).toHaveBeenCalledTimes(2);
  });

  it('calcula distancias reales entre coordenadas', () => {
    const cdmx = { latitude: 19.4326, longitude: -99.1332 };
    const gdl = { latitude: 20.6597, longitude: -103.3496 };

    const km = distanceKm(cdmx, gdl);

    expect(km).toBeGreaterThan(400);
    expect(km).toBeLessThan(550);
  });
});
