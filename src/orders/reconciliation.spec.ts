import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';

function build(options: {
  openOrder?: Record<string, unknown> | null;
  transactionError?: Error;
}) {
  const prisma: Record<string, any> = {
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(options.openOrder ?? null),
      create: jest.fn(),
    },
    branch: {
      findMany: jest.fn().mockResolvedValue([{ id: 'branch-1' }]),
    },
    $transaction: jest
      .fn()
      .mockRejectedValue(options.transactionError ?? new Error('stop')),
  };

  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as never, // events
    {} as never, // analytics
    {} as never, // kitchen
    {} as never, // kitchen ticketing
    {} as never, // splits
    {} as never, // tickets
  );

  return { service, prisma };
}

describe('OrdersService — reconciliación de mesas offline', () => {
  it('une la ronda a la cuenta abierta de la misma mesa', async () => {
    const { service, prisma } = build({
      openOrder: { id: 'open-1', organizationId: 'org1', status: 'OPEN' },
    });

    const result = await service.create('org1', 'u1', {
      tableNumber: '4',
      reuseOpenTable: true,
    } as never);

    expect(result).toMatchObject({ id: 'open-1', reconciled: true });
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org1',
          status: 'OPEN',
          tableNumber: '4',
        }),
      }),
    );
    // No se abre una segunda cuenta.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sin la marca de sincronización no reutiliza la mesa', async () => {
    const { service, prisma } = build({
      openOrder: { id: 'open-1', organizationId: 'org1' },
    });

    await expect(
      service.create('org1', 'u1', { tableNumber: '4' } as never),
    ).rejects.toThrow('stop');

    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('no busca mesa para una cuenta para llevar', async () => {
    const { service, prisma } = build({ openOrder: null });

    await expect(
      service.create('org1', 'u1', {
        isTakeaway: true,
        reuseOpenTable: true,
      } as never),
    ).rejects.toThrow('stop');

    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('crea la cuenta cuando la mesa no tiene nada abierto', async () => {
    const { service, prisma } = build({ openOrder: null });

    await expect(
      service.create('org1', 'u1', {
        tableNumber: '9',
        reuseOpenTable: true,
      } as never),
    ).rejects.toThrow('stop');

    expect(prisma.order.findFirst).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
