import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UnitCode, WasteReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WasteService } from './waste.service';

function build() {
  const prisma: Record<string, any> = {
    ingredient: { findFirst: jest.fn() },
    waste: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'w1', ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const service = new WasteService(prisma as unknown as PrismaService);

  return { service, prisma };
}

const ingredient = {
  id: 'i1',
  name: 'Leche',
  displayUnit: UnitCode.ML,
  unitCost: new Prisma.Decimal('0.02'),
};

describe('WasteService — merma', () => {
  it('calcula el costo con el costo actual del insumo', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    const result = await service.create('org1', 'u1', null, {
      ingredientId: 'i1',
      quantity: '500',
      reason: WasteReason.SPILL,
    });

    // 500 ml × 0.02 = 10
    expect(result.cost.toString()).toBe('10');
    expect(result.quantity.toString()).toBe('500');

    const data = prisma.waste.create.mock.calls[0][0].data;
    expect(data.ingredientName).toBe('Leche');
    expect(data.reason).toBe(WasteReason.SPILL);
  });

  it('convierte desde una unidad mayor', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    await service.create('org1', 'u1', null, {
      ingredientId: 'i1',
      quantity: '1.5',
      unit: UnitCode.L,
      reason: WasteReason.EXPIRED,
    });

    // 1.5 L = 1500 ml × 0.02 = 30
    const data = prisma.waste.create.mock.calls[0][0].data;
    expect(data.quantity.toString()).toBe('1500');
    expect(data.cost.toString()).toBe('30');
  });

  it('rechaza cantidades no positivas', async () => {
    const { service, prisma } = build();

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '0',
        reason: WasteReason.OTHER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('rechaza una unidad de otra dimensión', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '1',
        unit: UnitCode.UNIT,
        reason: WasteReason.DAMAGED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un insumo de otra organización', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(null);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'ajeno',
        quantity: '1',
        reason: WasteReason.OTHER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('suma el costo y agrupa por motivo', async () => {
    const { service, prisma } = build();

    prisma.waste.findMany.mockResolvedValue([
      {
        id: 'w1',
        ingredientName: 'Leche',
        quantity: new Prisma.Decimal(500),
        displayUnit: UnitCode.ML,
        reason: WasteReason.SPILL,
        note: null,
        cost: new Prisma.Decimal('10.00'),
        photoUrl: null,
        createdAt: new Date('2026-11-10T10:00:00Z'),
        user: null,
      },
      {
        id: 'w2',
        ingredientName: 'Pan',
        quantity: new Prisma.Decimal(3),
        displayUnit: UnitCode.UNIT,
        reason: WasteReason.EXPIRED,
        note: null,
        cost: new Prisma.Decimal('15.50'),
        photoUrl: null,
        createdAt: new Date('2026-11-11T10:00:00Z'),
        user: null,
      },
    ]);

    const result = await service.list('org1', null);

    expect(result.total).toBe(25.5);
    expect(result.byReason).toEqual(
      expect.arrayContaining([
        { reason: WasteReason.SPILL, count: 1, cost: 10 },
        { reason: WasteReason.EXPIRED, count: 1, cost: 15.5 },
      ]),
    );
  });

  it('no devuelve nada sin organización', async () => {
    const { service, prisma } = build();

    const result = await service.list(null, null);

    expect(result).toEqual({ items: [], total: 0, byReason: [] });
    expect(prisma.waste.findMany).not.toHaveBeenCalled();
  });
});
