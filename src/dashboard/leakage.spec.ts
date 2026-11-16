import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

function build() {
  const prisma: Record<string, any> = {
    order: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const service = new DashboardService(prisma as unknown as PrismaService);

  return { service, prisma };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    userId: 'u1',
    status: 'CLOSED',
    total: 116,
    subtotal: 100,
    taxTotal: 16,
    ticketNumber: 1,
    tableNumber: '1',
    createdAt: new Date('2026-11-10T18:00:00Z'),
    updatedAt: new Date('2026-11-10T18:30:00Z'),
    payments: [
      { amount: 116, tipAmount: 0, status: 'CONFIRMED' },
    ],
    ...overrides,
  };
}

describe('DashboardService — fuga interna', () => {
  it('marca al mesero con cancelaciones repetidas', async () => {
    const { service, prisma } = build();

    prisma.order.findMany.mockResolvedValue([
      order({ id: 'o1', status: 'CANCELLED' }),
      order({ id: 'o2', status: 'CANCELLED' }),
      order({ id: 'o3', status: 'CANCELLED' }),
      order({ id: 'o4' }),
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ana', username: 'ana', email: 'ana@cafe.com' },
    ]);

    const result = await service.leakageReport('org1', 30);

    expect(result.summary?.cancelledOrders).toBe(3);
    expect(result.summary?.usersFlagged).toBe(1);
    expect(result.users[0]).toMatchObject({
      userId: 'u1',
      cancellations: 3,
      riskScore: 6,
      name: 'Ana',
    });
  });

  it('detecta cuentas cerradas sin el pago completo', async () => {
    const { service, prisma } = build();

    prisma.order.findMany.mockResolvedValue([
      order({
        id: 'o9',
        total: 200,
        subtotal: 172.41,
        taxTotal: 27.59,
        payments: [{ amount: 150, tipAmount: 0, status: 'CONFIRMED' }],
      }),
    ]);

    const result = await service.leakageReport('org1', 30);

    expect(result.summary?.ordersWithoutPayment).toBe(1);
    expect(result.summary?.missingAmount).toBe(50);
    expect(result.ordersWithoutPayment[0]).toMatchObject({
      id: 'o9',
      total: 200,
      paid: 150,
      missing: 50,
    });
  });

  it('detecta cuentas cuyo total no coincide con sus conceptos', async () => {
    const { service, prisma } = build();

    prisma.order.findMany.mockResolvedValue([
      order({
        id: 'o7',
        total: 90,
        subtotal: 100,
        taxTotal: 16,
        payments: [{ amount: 90, tipAmount: 0, status: 'CONFIRMED' }],
      }),
    ]);

    const result = await service.leakageReport('org1', 30);

    expect(result.summary?.discounts).toBe(1);
    expect(result.summary?.discountAmount).toBe(26);
    expect(result.discounts[0]).toMatchObject({
      id: 'o7',
      expected: 116,
      total: 90,
      difference: 26,
    });
  });

  it('cuenta reembolsos del AuditLog y los suma al riesgo', async () => {
    const { service, prisma } = build();

    prisma.order.findMany.mockResolvedValue([]);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'payment.refunded', userId: 'u2' },
      { action: 'payment.cancelled', userId: 'u2' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u2', name: 'Luis', username: 'luis', email: null },
    ]);

    const result = await service.leakageReport('org1', 30);

    expect(result.summary?.refunds).toBe(2);
    expect(result.users[0]).toMatchObject({
      userId: 'u2',
      refunds: 2,
      riskScore: 6,
    });
  });

  it('no devuelve señales sin organización', async () => {
    const { service, prisma } = build();

    const result = await service.leakageReport(null, 30);

    expect(result.summary).toBeNull();
    expect(result.users).toEqual([]);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
