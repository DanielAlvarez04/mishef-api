import { KitchenMode, Prisma } from '@prisma/client';

import { KitchenTicketingService } from './kitchen-ticketing.service';
import type { PrismaService } from '../prisma/prisma.service';

function buildTx(overrides: Partial<Record<string, unknown>> = {}) {
  const tx = {
    branch: {
      findUnique: jest.fn().mockResolvedValue({ kitchenMode: KitchenMode.ADVANCED }),
    },
    item: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    kitchenStationRule: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    kitchenStation: {
      findMany: jest.fn().mockResolvedValue([{ id: 's1' }]),
      create: jest.fn().mockResolvedValue({ id: 'fallback' }),
    },
    kitchenTicket: {
      create: jest.fn().mockImplementation(({ data }) => ({
        id: `ticket-${data.stationId}`,
        ...data,
      })),
    },
    orderItem: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
  };

  return tx as unknown as Prisma.TransactionClient & typeof tx;
}

describe('KitchenTicketingService', () => {
  const service = new KitchenTicketingService({} as PrismaService);

  it('no crea tickets en modo General', async () => {
    const tx = buildTx({
      branch: {
        findUnique: jest.fn().mockResolvedValue({ kitchenMode: KitchenMode.GENERAL }),
      },
    });

    const result = await service.createForRound(tx, {
      organizationId: 'org1',
      branchId: 'b1',
      roundId: 'r1',
      items: [{ id: 'oi1', itemId: 'i1' }],
    });

    expect(result).toEqual([]);
    expect(tx.kitchenTicket.create).not.toHaveBeenCalled();
  });

  it('rutea por estación primaria y por regla de categoría', async () => {
    const tx = buildTx({
      item: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'i1', categoryId: 'c1', defaultStationId: 's1' },
          { id: 'i2', categoryId: 'c2', defaultStationId: null },
        ]),
      },
      kitchenStation: {
        findMany: jest.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
        create: jest.fn(),
      },
      kitchenStationRule: {
        findMany: jest.fn().mockResolvedValue([
          { stationId: 's2', itemId: null, categoryId: 'c2', menuId: null },
        ]),
      },
    });

    const result = await service.createForRound(tx, {
      organizationId: 'org1',
      branchId: 'b1',
      roundId: 'r1',
      items: [
        { id: 'oi1', itemId: 'i1' },
        { id: 'oi2', itemId: 'i2' },
      ],
    });

    expect(result).toHaveLength(2);
    expect(tx.kitchenTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stationId: 's1',
          items: { create: [{ orderItemId: 'oi1' }] },
        }),
      }),
    );
    expect(tx.kitchenTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stationId: 's2',
          items: { create: [{ orderItemId: 'oi2' }] },
        }),
      }),
    );
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['oi1'] } },
      data: { stationId: 's1' },
    });
  });

  it('crea una estación de respaldo si no hay estaciones activas', async () => {
    const tx = buildTx({
      kitchenStation: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'fallback' }),
      },
      item: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'i1', categoryId: null, defaultStationId: null }]),
      },
    });

    await service.createForRound(tx, {
      organizationId: 'org1',
      branchId: 'b1',
      roundId: 'r1',
      items: [{ id: 'oi1', itemId: 'i1' }],
    });

    expect(tx.kitchenStation.create).toHaveBeenCalled();
    expect(tx.kitchenTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stationId: 'fallback' }),
      }),
    );
  });
});
