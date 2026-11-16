import { PrismaService } from '../prisma/prisma.service';
import { CatalogEntriesService } from './catalog-entries.service';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import { ItemsService } from './items.service';

function build() {
  const prisma = {
    item: { findMany: jest.fn() },
  };

  const quantities = {} as unknown as IngredientQuantitiesService;
  const catalogEntries = {} as unknown as CatalogEntriesService;

  const service = new ItemsService(
    prisma as unknown as PrismaService,
    quantities,
    catalogEntries,
    { releaseImage: jest.fn() } as never,
  );

  return { service, prisma };
}

describe('ItemsService — food cost', () => {
  it('calcula costo, precio sin IVA y food cost por artículo', async () => {
    const { service, prisma } = build();

    prisma.item.findMany.mockResolvedValue([
      {
        id: 'i1',
        name: 'Latte',
        price: 116,
        taxRate: 0.16,
        isCombo: false,
        recipes: [
          {
            variantId: null,
            ingredients: [
              {
                quantity: 18,
                isOptional: false,
                ingredient: { name: 'Café', unitCost: 0.5 },
              },
              {
                quantity: 200,
                isOptional: false,
                ingredient: { name: 'Leche', unitCost: 0.02 },
              },
            ],
          },
        ],
      },
    ]);

    const result = await service.foodCost('org1');

    // 18 × 0.5 + 200 × 0.02 = 13
    expect(result.items[0].cost).toBe(13);
    expect(result.items[0].netPrice).toBe(100);
    expect(result.items[0].foodCostPct).toBe(0.13);
    expect(result.items[0].margin).toBe(87);
    expect(result.items[0].aboveTarget).toBe(false);
    expect(result.summary?.averageFoodCostPct).toBe(0.13);
  });

  it('marca el artículo cuando supera el objetivo de food cost', async () => {
    const { service, prisma } = build();

    prisma.item.findMany.mockResolvedValue([
      {
        id: 'i2',
        name: 'Sándwich',
        price: 100,
        taxRate: 0,
        isCombo: false,
        recipes: [
          {
            variantId: null,
            ingredients: [
              {
                quantity: 60,
                isOptional: false,
                ingredient: { name: 'Pan', unitCost: 0.5 },
              },
            ],
          },
        ],
      },
    ]);

    const result = await service.foodCost('org1', 0.25);

    expect(result.items[0].cost).toBe(30);
    expect(result.items[0].foodCostPct).toBe(0.3);
    expect(result.items[0].aboveTarget).toBe(true);
    expect(result.summary?.aboveTarget).toBe(1);
  });

  it('marca incompleto cuando un insumo no tiene costo', async () => {
    const { service, prisma } = build();

    prisma.item.findMany.mockResolvedValue([
      {
        id: 'i3',
        name: 'Té',
        price: 40,
        taxRate: 0,
        isCombo: false,
        recipes: [
          {
            variantId: null,
            ingredients: [
              {
                quantity: 5,
                isOptional: false,
                ingredient: { name: 'Té', unitCost: null },
              },
            ],
          },
        ],
      },
    ]);

    const result = await service.foodCost('org1');

    expect(result.items[0].complete).toBe(false);
    expect(result.items[0].missing).toEqual(['Té']);
    expect(result.summary?.incomplete).toBe(1);
  });

  it('no calcula artículos sin receta', async () => {
    const { service, prisma } = build();

    prisma.item.findMany.mockResolvedValue([
      {
        id: 'i4',
        name: 'Refresco',
        price: 35,
        taxRate: 0.16,
        isCombo: false,
        recipes: [],
      },
    ]);

    const result = await service.foodCost('org1');

    expect(result.items[0].hasRecipe).toBe(false);
    expect(result.items[0].aboveTarget).toBe(false);
    expect(result.summary?.withoutRecipe).toBe(1);
  });
});
