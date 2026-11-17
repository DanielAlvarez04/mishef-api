import { Prisma, CashSessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashService } from './cash.service';

function build() {
  const prisma: Record<string, any> = {
    cashSession: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    cashMovement: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation((fn: any) => fn(prisma));

  const service = new CashService(prisma as unknown as PrismaService);

  return { service, prisma };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    organizationId: 'org1',
    branchId: null,
    status: CashSessionStatus.OPEN,
    openedById: 'u1',
    openedAt: new Date('2026-11-17T18:00:00Z'),
    openingFloat: new Prisma.Decimal(500),
    closedById: null,
    closedAt: null,
    countedCash: null,
    expectedCash: null,
    difference: null,
    notes: null,
    closeIdempotencyKey: null,
    createdAt: new Date('2026-11-17T18:00:00Z'),
    updatedAt: new Date('2026-11-17T18:00:00Z'),
    branch: null,
    openedBy: null,
    closedBy: null,
    ...overrides,
  };
}

describe('CashService — cierre idempotente', () => {
  it('devuelve el mismo cierre al reintentar con la misma clave', async () => {
    const { service, prisma } = build();
    const closed = session({
      status: CashSessionStatus.CLOSED,
      closedById: 'u1',
      closedAt: new Date('2026-11-17T19:00:00Z'),
      countedCash: new Prisma.Decimal(500),
      expectedCash: new Prisma.Decimal(500),
      difference: new Prisma.Decimal(0),
      closeIdempotencyKey: 'key-1',
    });

    prisma.cashSession.findFirst
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(closed);
    prisma.cashSession.findUniqueOrThrow.mockResolvedValue(closed);

    const first = await service.close('org1', 's1', 'u1', {
      countedCash: 500,
      idempotencyKey: 'key-1',
    });

    expect(first.session.status).toBe(CashSessionStatus.CLOSED);
    expect(prisma.cashSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          closeIdempotencyKey: 'key-1',
          countedCash: new Prisma.Decimal(500),
        }),
      }),
    );

    const second = await service.close('org1', 's1', 'u1', {
      countedCash: 500,
      idempotencyKey: 'key-1',
    });

    expect(second.session.status).toBe(CashSessionStatus.CLOSED);
    expect(prisma.cashSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rechaza un cierre distinto sobre una caja ya cerrada', async () => {
    const { service, prisma } = build();
    prisma.cashSession.findFirst.mockResolvedValue(
      session({
        status: CashSessionStatus.CLOSED,
        closeIdempotencyKey: 'key-1',
      }),
    );

    await expect(
      service.close('org1', 's1', 'u1', {
        countedCash: 400,
        idempotencyKey: 'key-2',
      }),
    ).rejects.toBeTruthy();
  });
});
