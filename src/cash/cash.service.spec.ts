import { CashMovementType, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashService } from './cash.service';

function build() {
  const prisma: Record<string, any> = {
    cashSession: { findFirst: jest.fn() },
    payment: { findMany: jest.fn() },
    cashMovement: { findMany: jest.fn() },
  };

  const service = new CashService(prisma as unknown as PrismaService);

  return { service, prisma };
}

const openSession = {
  id: 's1',
  organizationId: 'org1',
  status: 'OPEN',
  openedAt: new Date('2026-11-16T18:00:00Z'),
  openingFloat: 500,
  branch: null,
  openedBy: null,
  closedBy: null,
};

describe('CashService — conciliación del turno', () => {
  it('desglosa el efectivo esperado por origen y separa los otros medios', async () => {
    const { service, prisma } = build();
    prisma.cashSession.findFirst.mockResolvedValue(openSession);

    prisma.payment.findMany.mockResolvedValue([
      { method: PaymentMethod.CASH, amount: 1000, tipAmount: 50 },
      { method: PaymentMethod.CARD, amount: 300, tipAmount: 20 },
      { method: PaymentMethod.MERCADO_PAGO_POINT, amount: 200, tipAmount: 0 },
    ]);

    prisma.cashMovement.findMany.mockResolvedValue([
      { type: CashMovementType.WITHDRAWAL, amount: 100 },
      { type: CashMovementType.EXPENSE, amount: 50 },
      { type: CashMovementType.DEPOSIT, amount: 20 },
    ]);

    const result = await service.reconciliation('org1', 's1');

    // 500 fondo + 1000 efectivo + 50 propina efectivo + 20 ingreso − 100 − 50
    expect(result.cash.expected).toBe(1420);
    expect(result.cash.openingFloat).toBe(500);
    expect(result.cash.sales).toBe(1000);
    expect(result.cash.tips).toBe(50);
    expect(result.cash.withdrawals).toBe(100);
    expect(result.cash.expenses).toBe(50);
    expect(result.cash.deposits).toBe(20);

    // Tarjeta (320 con propina) + terminal (200)
    expect(result.other.total).toBe(520);
    expect(result.other.count).toBe(2);

    expect(result.tips).toEqual({ total: 70, cash: 50, other: 20 });
    expect(result.totals).toEqual({ payments: 3, amount: 1570 });
  });

  it('calcula la diferencia en vivo sin cerrar el turno', async () => {
    const { service, prisma } = build();
    prisma.cashSession.findFirst.mockResolvedValue(openSession);
    prisma.payment.findMany.mockResolvedValue([
      { method: PaymentMethod.CASH, amount: 1000, tipAmount: 0 },
    ]);
    prisma.cashMovement.findMany.mockResolvedValue([]);

    const result = await service.reconciliation('org1', 's1', 1480);

    expect(result.cash.expected).toBe(1500);
    expect(result.proposed).toEqual({ counted: 1480, difference: -20 });
    expect(result.status).toBe('OPEN');
  });

  it('avisa cuando el efectivo esperado es negativo', async () => {
    const { service, prisma } = build();
    prisma.cashSession.findFirst.mockResolvedValue({
      ...openSession,
      openingFloat: 100,
    });
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.cashMovement.findMany.mockResolvedValue([
      { type: CashMovementType.WITHDRAWAL, amount: 400 },
    ]);

    const result = await service.reconciliation('org1', 's1');

    expect(result.cash.expected).toBe(-300);
    expect(result.alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        'negative_cash',
        'withdrawals_exceed_available',
        'no_payments',
      ]),
    );
  });

  it('marca una diferencia grande antes de cerrar', async () => {
    const { service, prisma } = build();
    prisma.cashSession.findFirst.mockResolvedValue(openSession);
    prisma.payment.findMany.mockResolvedValue([
      { method: PaymentMethod.CASH, amount: 1000, tipAmount: 0 },
    ]);
    prisma.cashMovement.findMany.mockResolvedValue([]);

    const result = await service.reconciliation('org1', 's1', 1000);

    expect(result.proposed?.difference).toBe(-500);
    expect(result.alerts.map((alert) => alert.code)).toContain(
      'large_difference',
    );
  });
});
