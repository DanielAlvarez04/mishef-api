import { OrderStatus } from '@prisma/client';

import { OrdersService } from './orders.service';
import type { PrismaService } from '../prisma/prisma.service';

function guest(id: string, sortOrder: number) {
  return {
    id,
    name: '',
    title: null,
    sex: null,
    ageRange: null,
    sortOrder,
    orderId: 'o1',
    createdAt: new Date(),
  };
}

function build(guests = [guest('g1', 0)], partySize = guests.length) {
  const prismaGuestFindMany = jest.fn().mockResolvedValue(guests);
  const txGuestFindMany = jest.fn();
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const orderUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    orderGuest: {
      findMany: txGuestFindMany,
      createMany,
      deleteMany,
    },
    order: { update: orderUpdate },
  };
  const prisma = {
    orderGuest: { findMany: prismaGuestFindMany },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const service = new OrdersService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  (service as never as Record<string, jest.Mock>).getOrderRow = jest
    .fn()
    .mockResolvedValue({
      id: 'o1',
      status: OrderStatus.OPEN,
      partySize,
    });

  return {
    service,
    prisma: prisma as never as {
      $transaction: jest.Mock;
    },
    tx,
    createMany,
    deleteMany,
    orderUpdate,
    txGuestFindMany,
  };
}

describe('OrdersService.setPartySize', () => {
  it('crea los comensales que faltan y actualiza partySize en una transacción', async () => {
    const { service, txGuestFindMany, createMany, orderUpdate } = build(
      [guest('g1', 0)],
      1,
    );
    txGuestFindMany
      .mockResolvedValueOnce([guest('g1', 0)])
      .mockResolvedValueOnce([
        guest('g1', 0),
        guest('g2', 1),
        guest('g3', 2),
      ]);

    const result = await service.setPartySize('org1', 'o1', 3);

    expect(result).toHaveLength(3);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { orderId: 'o1', name: '', sortOrder: 1 },
        { orderId: 'o1', name: '', sortOrder: 2 },
      ],
    });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { partySize: 3 },
    });
  });

  it('elimina los últimos comensales y actualiza partySize', async () => {
    const { service, txGuestFindMany, deleteMany, orderUpdate } = build(
      [guest('g1', 0), guest('g2', 1), guest('g3', 2)],
      3,
    );

    txGuestFindMany
      .mockResolvedValueOnce([guest('g1', 0), guest('g2', 1), guest('g3', 2)])
      .mockResolvedValueOnce([guest('g1', 0)]);

    const result = await service.setPartySize('org1', 'o1', 1);

    expect(result).toHaveLength(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['g2', 'g3'] } },
    });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { partySize: 1 },
    });
  });

  it('no escribe si el número y los comensales ya coinciden', async () => {
    const { service, prisma, createMany, deleteMany, orderUpdate } = build(
      [guest('g1', 0), guest('g2', 1)],
      2,
    );

    const result = await service.setPartySize('org1', 'o1', 2);

    expect(result).toHaveLength(2);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});
