import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';

function build(existing: Record<string, unknown> | null) {
  const prisma: Record<string, any> = {
    order: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn(),
    },
    branch: {
      findMany: jest.fn().mockResolvedValue([{ id: 'branch-1' }]),
    },
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

describe('OrdersService — idempotencia (offline)', () => {
  it('devuelve el pedido existente sin crear otro', async () => {
    const { service, prisma } = build({
      id: 'o1',
      organizationId: 'org1',
      status: 'OPEN',
    });

    const result = await service.create('org1', 'u1', {
      idempotencyKey: 'k1',
    } as never);

    expect(result).toMatchObject({ id: 'o1', duplicated: true });
    // Si la clave ya existe, no se vuelve a crear nada: reintentar la cola mil
    // veces produce un solo pedido.
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('rechaza reutilizar la clave en otro negocio', async () => {
    const { service, prisma } = build({
      id: 'o1',
      organizationId: 'org2',
    });

    await expect(
      service.create('org1', 'u1', { idempotencyKey: 'k1' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('normaliza la clave recortando espacios', async () => {
    const { service, prisma } = build({
      id: 'o1',
      organizationId: 'org1',
    });

    await service.create('org1', 'u1', {
      idempotencyKey: '  k1  ',
    } as never);

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: 'k1' } }),
    );
  });
});
