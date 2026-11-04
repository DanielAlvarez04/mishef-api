import { OptionEffectAction, Prisma } from '@prisma/client';
import { consumptionForItem } from './orders.service';

const d = (value: string | number) => new Prisma.Decimal(value);

function baseItem(
  overrides: Partial<Parameters<typeof consumptionForItem>[0]> = {},
): Parameters<typeof consumptionForItem>[0] {
  return {
    itemVariantId: 'A',
    extras: [],
    exclusions: [],
    ingredientChoices: [],
    options: [],
    item: {
      isCombo: false,
      variants: [
        { id: 'A', recipeFactor: d(1) },
        { id: 'B', recipeFactor: d(1.2) },
      ],
      recipes: [
        {
          variantId: null,
          ingredients: [
            {
              id: 'line-coffee',
              ingredientId: 'coffee',
              variantId: null,
              quantity: d(8),
              options: [],
            },
            {
              id: 'line-milk',
              ingredientId: 'milk',
              variantId: null,
              quantity: d(60),
              options: [],
            },
            {
              id: 'line-milk-a',
              ingredientId: 'milk',
              variantId: 'A',
              quantity: d(100),
              options: [],
            },
          ],
        },
      ],
      extras: [],
      comboComponents: [],
    },
    ...overrides,
  };
}

function quantities(
  item: Parameters<typeof consumptionForItem>[0],
): Record<string, string> {
  return Object.fromEntries(
    consumptionForItem(item).map((line) => [
      line.ingredientId,
      line.quantity.toString(),
    ]),
  );
}

describe('consumptionForItem — alcance por presentación', () => {
  it('usa la cantidad propia de la presentación en lugar de la común', () => {
    expect(quantities(baseItem())).toEqual({
      coffee: '8',
      milk: '100',
    });
  });

  it('sin presentación usa solo la receta común', () => {
    expect(quantities(baseItem({ itemVariantId: 'B' }))).toEqual({
      coffee: '9.6',
      milk: '72',
    });
  });

  it('aplica el factor de escala de la opción', () => {
    const item = baseItem({
      options: [
        {
          itemOptionValue: {
            scaleFactor: d(0.5),
            effects: [],
          },
        },
      ],
    });

    expect(quantities(item)).toEqual({
      coffee: '4',
      milk: '50',
    });
  });

  it('agrega insumos y quita el insumo indicado', () => {
    const item = baseItem({
      options: [
        {
          itemOptionValue: {
            scaleFactor: d(1),
            effects: [
              {
                action: OptionEffectAction.ADD,
                recipeIngredientId: null,
                replacesIngredientId: null,
                ingredientId: 'ice',
                quantity: d(50),
              },
              {
                action: OptionEffectAction.REMOVE,
                recipeIngredientId: null,
                replacesIngredientId: null,
                ingredientId: 'milk',
                quantity: null,
              },
            ],
          },
        },
      ],
    });

    expect(quantities(item)).toEqual({
      coffee: '8',
      ice: '50',
    });
  });

  it('reemplaza un insumo por otro sin depender del id de la línea', () => {
    const item = baseItem({
      options: [
        {
          itemOptionValue: {
            scaleFactor: d(1),
            effects: [
              {
                action: OptionEffectAction.REPLACE,
                recipeIngredientId: null,
                replacesIngredientId: 'milk',
                ingredientId: 'oat-milk',
                quantity: d(80),
              },
            ],
          },
        },
      ],
    });

    expect(quantities(item)).toEqual({
      coffee: '8',
      'oat-milk': '80',
    });
  });
});
