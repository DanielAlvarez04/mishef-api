import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogEntriesService } from './catalog-entries.service';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import { ItemsService } from './items.service';

function build() {
  const prisma = {
    item: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    itemVariant: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    itemExtra: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    itemExtraIngredient: { deleteMany: jest.fn() },
    itemIngredientExclusion: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    comboComponent: {
      count: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    category: { findFirst: jest.fn() },
    ingredient: { findFirst: jest.fn() },
    catalogEntry: { create: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation((fn) => fn(prisma));

  const quantities = {
    resolve: jest.fn().mockResolvedValue([]),
  } as unknown as IngredientQuantitiesService;

  const catalogEntries = {
    ensureForItem: jest.fn(),
    applyImage: jest.fn(),
    deleteIfOrphan: jest.fn(),
  } as unknown as CatalogEntriesService;

  const service = new ItemsService(
    prisma as unknown as PrismaService,
    quantities,
    catalogEntries,
  );

  return { service, prisma };
}

describe('ItemsService — validaciones de alta', () => {
  it('rechaza componentes de combo en un artículo normal', async () => {
    const { service, prisma } = build();

    await expect(
      service.create('o1', {
        name: 'Producto',
        price: 10,
        comboComponents: [{ itemId: 'p2', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.item.create).not.toHaveBeenCalled();
  });

  it('exige al menos un componente cuando el artículo es combo', async () => {
    const { service, prisma } = build();

    await expect(
      service.create('o1', { name: 'Combo', price: 10, isCombo: true }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.item.create).not.toHaveBeenCalled();
  });

  it('normaliza el SKU a mayúsculas', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst
      .mockResolvedValueOnce(null) // SKU libre
      .mockResolvedValueOnce({
        id: 'p1',
        sku: 'CAF-01',
        menuItems: [],
        catalogEntry: null,
      }); // detalle posterior
    prisma.item.create.mockResolvedValue({ id: 'p1' });

    await service.create('o1', { name: 'Latte', sku: 'caf-01', price: 55 });

    const data = prisma.item.create.mock.calls[0][0].data;
    expect(data.sku).toBe('CAF-01');
    expect(data.price.toString()).toBe('55');
  });

  it('rechaza SKU duplicado sin distinguir mayúsculas', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({ id: 'otro' });

    await expect(
      service.create('o1', { name: 'Latte', sku: 'CAF-01', price: 55 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza categorías desactivadas', async () => {
    const { service, prisma } = build();
    prisma.category.findFirst.mockResolvedValue({
      id: 'c1',
      isActive: false,
    });

    await expect(
      service.create('o1', { name: 'Latte', price: 55, categoryId: 'c1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('devuelve 404 si la categoría no existe', async () => {
    const { service, prisma } = build();
    prisma.category.findFirst.mockResolvedValue(null);

    await expect(
      service.create('o1', { name: 'Latte', price: 55, categoryId: 'c1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ItemsService — combos', () => {
  it('rechaza dejar un combo sin componentes', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'c1',
      organizationId: 'o1',
      isCombo: true,
    });

    await expect(
      service.replaceComboComponents('o1', 'c1', []),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechaza un combo dentro de otro combo', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst
      .mockResolvedValueOnce({ id: 'c1', organizationId: 'o1', isCombo: true })
      .mockResolvedValueOnce({
        id: 'c2',
        organizationId: 'o1',
        name: 'Otro combo',
        isCombo: true,
        isActive: true,
      });

    await expect(
      service.replaceComboComponents('o1', 'c1', [
        { itemId: 'c2', quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza que un combo se contenga a sí mismo', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'c1',
      organizationId: 'o1',
      isCombo: true,
    });

    await expect(
      service.replaceComboComponents('o1', 'c1', [
        { itemId: 'c1', quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza componentes desactivados', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst
      .mockResolvedValueOnce({ id: 'c1', organizationId: 'o1', isCombo: true })
      .mockResolvedValueOnce({
        id: 'p2',
        organizationId: 'o1',
        name: 'Croissant',
        isCombo: false,
        isActive: false,
      });

    await expect(
      service.replaceComboComponents('o1', 'c1', [
        { itemId: 'p2', quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no permite configurar componentes en un artículo que no es combo', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'p1',
      organizationId: 'o1',
      isCombo: false,
    });

    await expect(
      service.replaceComboComponents('o1', 'p1', [
        { itemId: 'p2', quantity: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('desactiva un artículo aunque sea componente de un combo activo', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'p1',
      organizationId: 'o1',
    });
    prisma.item.update.mockResolvedValue({ id: 'p1', isActive: false });

    await service.deactivate('o1', 'p1');

    expect(prisma.item.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { isActive: false },
    });
  });
});

describe('ItemsService — exclusiones y variantes', () => {
  it('rechaza ingredientes repetidos en las exclusiones', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'p1',
      organizationId: 'o1',
    });
    prisma.ingredient.findFirst.mockResolvedValue({ id: 'i1' });

    await expect(
      service.replaceExclusions('o1', 'p1', [
        { ingredientId: 'i1' },
        { ingredientId: 'i1' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechaza variantes con el mismo nombre en el artículo', async () => {
    const { service, prisma } = build();
    prisma.item.findFirst.mockResolvedValueOnce({
      id: 'p1',
      organizationId: 'o1',
    });
    prisma.itemVariant.findFirst.mockResolvedValue({ id: 'v1' });

    await expect(
      service.createVariant('o1', 'p1', { name: 'Grande' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.itemVariant.create).not.toHaveBeenCalled();
  });
});
