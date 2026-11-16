import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, UnitCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuantityConverter } from '../common/quantity-converter.service';
import { InventoryService } from './inventory.service';

function build() {
  const prisma = {
    ingredient: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    ingredientEquivalence: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    inventoryMovement: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    recipeIngredient: { count: jest.fn() },
    $transaction: jest.fn(),
  };

  const client = prisma as unknown as PrismaService;
  const service = new InventoryService(client, new QuantityConverter(client));

  return { service, prisma };
}

function ingredient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    organizationId: 'o1',
    name: 'Leche',
    baseUnit: UnitCode.ML,
    displayUnit: UnitCode.ML,
    currentStock: new Prisma.Decimal(0),
    minStock: new Prisma.Decimal(0),
    isActive: true,
    ...overrides,
  };
}

describe('InventoryService — ingredientes y alertas', () => {
  it('marca el stock bajo y calcula el déficit', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findMany.mockResolvedValue([
      ingredient({
        id: 'bajo',
        currentStock: new Prisma.Decimal(1),
        minStock: new Prisma.Decimal(5),
      }),
      ingredient({
        id: 'ok',
        currentStock: new Prisma.Decimal(10),
        minStock: new Prisma.Decimal(5),
      }),
    ]);

    const list = await service.listIngredients('o1');

    expect(list.map((item) => item.isLowStock)).toEqual([true, false]);
    expect(list[0].deficit.toString()).toBe('4');
    expect(list[1].deficit.toString()).toBe('0');
  });

  it('filtra por lowStockOnly en memoria', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findMany.mockResolvedValue([
      ingredient({
        id: 'bajo',
        currentStock: new Prisma.Decimal(0),
        minStock: new Prisma.Decimal(2),
      }),
      ingredient({
        id: 'ok',
        currentStock: new Prisma.Decimal(9),
        minStock: new Prisma.Decimal(2),
      }),
    ]);

    const list = await service.listIngredients('o1', { lowStockOnly: true });

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('bajo');
  });

  it('ordena las alertas por déficit descendente', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findMany.mockResolvedValue([
      ingredient({
        id: 'poco',
        currentStock: new Prisma.Decimal(4),
        minStock: new Prisma.Decimal(5),
      }),
      ingredient({
        id: 'nada',
        currentStock: new Prisma.Decimal(0),
        minStock: new Prisma.Decimal(10),
      }),
      ingredient({
        id: 'ok',
        currentStock: new Prisma.Decimal(10),
        minStock: new Prisma.Decimal(1),
      }),
    ]);

    const alerts = await service.listAlerts('o1');

    expect(alerts.map((alert) => alert.id)).toEqual(['nada', 'poco']);
    expect(alerts[0].deficit.toString()).toBe('10');
  });

  it('permite cambiar la unidad visible aunque haya movimientos y recetas', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());
    prisma.ingredient.update.mockResolvedValue(
      ingredient({ displayUnit: UnitCode.L }),
    );
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({ ingredient: { update: prisma.ingredient.update } }),
    );

    const updated = await service.updateIngredient('o1', 'i1', {
      displayUnit: UnitCode.L,
    });

    expect(updated.displayUnit).toBe(UnitCode.L);
    expect(prisma.recipeIngredient.count).not.toHaveBeenCalled();
    expect(prisma.inventoryMovement.count).not.toHaveBeenCalled();
  });

  it('rechaza una unidad visible de otra dimensión', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());

    await expect(
      service.updateIngredient('o1', 'i1', { displayUnit: UnitCode.KG }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.ingredient.update).not.toHaveBeenCalled();
  });

  it('convierte los valores capturados en la nueva unidad visible', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(
      ingredient({ baseUnit: UnitCode.G, displayUnit: UnitCode.G }),
    );
    prisma.ingredient.update.mockResolvedValue(
      ingredient({ baseUnit: UnitCode.G, displayUnit: UnitCode.KG }),
    );
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({ ingredient: { update: prisma.ingredient.update } }),
    );

    await service.updateIngredient('o1', 'i1', {
      displayUnit: UnitCode.KG,
      minStock: 0.5,
      maxStock: 2,
      unitCost: 25,
    });

    expect(prisma.ingredient.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: expect.objectContaining({
        displayUnit: UnitCode.KG,
        minStock: new Prisma.Decimal(500),
        maxStock: new Prisma.Decimal(2000),
        unitCost: new Prisma.Decimal('0.025'),
      }),
    });
  });
});

describe('InventoryService — ajustes', () => {
  it('rechaza cantidades en cero', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());

    await expect(
      service.adjust('o1', 'u1', {
        ingredientId: 'i1',
        quantity: '0',
        reason: 'Ajuste nulo',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un ajuste que dejaría stock negativo y no crea el movimiento', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());
    prisma.inventoryMovement.findUnique.mockResolvedValue(null);

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      inventoryMovement: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      service.adjust('o1', 'u1', {
        ingredientId: 'i1',
        quantity: '-5',
        reason: 'Salida imposible',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('convierte la cantidad a la unidad base y guarda el saldo resultante', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());
    prisma.inventoryMovement.findUnique.mockResolvedValue(null);

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ currentStock: '1250.5' }]),
      inventoryMovement: {
        create: jest.fn(async ({ data }) => ({
          id: 'm1',
          ingredient: { displayUnit: UnitCode.ML },
          ...data,
        })),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const movement = await service.adjust('o1', 'u1', {
      ingredientId: 'i1',
      quantity: '1',
      unit: UnitCode.L,
      reason: 'Entrada en litros',
    });

    const data = tx.inventoryMovement.create.mock.calls[0][0].data;
    expect(data.quantity.toString()).toBe('1000');
    expect(data.stockAfter.toString()).toBe('1250.5');
    expect(data.type).toBe('ADJUSTMENT');
    expect(movement.id).toBe('m1');
  });

  it('dedupeKey devuelve el movimiento existente sin repetirlo', async () => {
    const { service, prisma } = build();
    prisma.inventoryMovement.findUnique.mockResolvedValue({
      id: 'm-existente',
      organizationId: 'o1',
      quantity: new Prisma.Decimal(5),
      stockAfter: new Prisma.Decimal(10),
      displayUnit: UnitCode.ML,
      ingredient: { displayUnit: UnitCode.ML },
    });

    const result = await service.adjust('o1', 'u1', {
      ingredientId: 'i1',
      quantity: '5',
      reason: 'Reintento',
      dedupeKey: 'clave-1',
    });

    expect(result.id).toBe('m-existente');
    expect('duplicated' in result && result.duplicated === true).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('InventoryService — equivalencias', () => {
  it('rechaza equivalencias entre unidades de la misma dimensión', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());

    await expect(
      service.createEquivalence('o1', 'i1', {
        fromUnit: UnitCode.KG,
        toUnit: UnitCode.G,
        factor: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.ingredientEquivalence.create).not.toHaveBeenCalled();
  });

  it('rechaza equivalencias con la misma unidad de origen y destino', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient());

    await expect(
      service.createEquivalence('o1', 'i1', {
        fromUnit: UnitCode.ML,
        toUnit: UnitCode.ML,
        factor: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('guarda equivalencias entre dimensiones distintas', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(
      ingredient({ baseUnit: UnitCode.G }),
    );
    prisma.ingredientEquivalence.create.mockResolvedValue({ id: 'eq1' });

    const created = await service.createEquivalence('o1', 'i1', {
      fromUnit: UnitCode.ML,
      toUnit: UnitCode.G,
      factor: 1.2,
    });

    expect(created.id).toBe('eq1');
    expect(prisma.ingredientEquivalence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ingredientId: 'i1',
        fromUnit: UnitCode.ML,
        toUnit: UnitCode.G,
      }),
    });
  });
});
