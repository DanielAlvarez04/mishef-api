/**
 * Cálculo de food cost compartido por el reporte por artículo y el benchmark.
 *
 * El costo sale de la receta base × el costo actual del insumo; el precio se
 * compara **sin IVA**, que es como se mide el food cost en un restaurante.
 */

export interface FoodCostIngredient {
  quantity: unknown;
  isOptional: boolean;
  ingredient: { name: string; unitCost: unknown };
}

export interface FoodCostRecipe {
  variantId: string | null;
  ingredients: FoodCostIngredient[];
}

export interface FoodCostItemInput {
  id: string;
  name: string;
  price: unknown;
  taxRate: unknown;
  isCombo: boolean;
  recipes: FoodCostRecipe[];
}

export interface FoodCostRow {
  id: string;
  name: string;
  isCombo: boolean;
  price: number;
  netPrice: number;
  cost: number;
  foodCostPct: number;
  margin: number;
  marginPct: number;
  hasRecipe: boolean;
  missing: string[];
  complete: boolean;
  aboveTarget: boolean;
}

export interface FoodCostSummary {
  items: number;
  withRecipe: number;
  withoutRecipe: number;
  incomplete: number;
  aboveTarget: number;
  averageFoodCostPct: number | null;
}

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = (value: number) =>
  Math.round((value + Number.EPSILON) * 10000) / 10000;

export function computeFoodCost(
  items: FoodCostItemInput[],
  target: number,
): { items: FoodCostRow[]; summary: FoodCostSummary } {
  const rows = items.map((item) => {
    const recipe =
      item.recipes.find((candidate) => candidate.variantId === null) ??
      item.recipes[0];

    let cost = 0;
    const missing: string[] = [];

    if (recipe) {
      for (const line of recipe.ingredients) {
        if (line.isOptional) continue;

        const unitCost = line.ingredient.unitCost;

        if (!unitCost || Number(unitCost) <= 0) {
          missing.push(line.ingredient.name);
          continue;
        }

        cost += Number(line.quantity) * Number(unitCost);
      }
    }

    const price = Number(item.price);
    const taxRate = item.taxRate ? Number(item.taxRate) : 0;
    const netPrice = taxRate > 0 ? price / (1 + taxRate) : price;

    const hasRecipe = Boolean(recipe);
    const complete = hasRecipe && missing.length === 0 && cost > 0;
    const foodCostPct = netPrice > 0 ? cost / netPrice : 0;

    return {
      id: item.id,
      name: item.name,
      isCombo: item.isCombo,
      price: round2(price),
      netPrice: round2(netPrice),
      cost: round2(cost),
      foodCostPct: round4(foodCostPct),
      margin: round2(netPrice - cost),
      marginPct: round4(1 - foodCostPct),
      hasRecipe,
      missing,
      complete,
      aboveTarget: complete && foodCostPct > target,
    };
  });

  const costed = rows.filter((row) => row.complete);

  return {
    items: rows,
    summary: {
      items: rows.length,
      withRecipe: rows.filter((row) => row.hasRecipe).length,
      withoutRecipe: rows.filter((row) => !row.hasRecipe).length,
      incomplete: rows.filter((row) => row.hasRecipe && !row.complete).length,
      aboveTarget: rows.filter((row) => row.aboveTarget).length,
      averageFoodCostPct: costed.length
        ? round4(
            costed.reduce((sum, row) => sum + row.foodCostPct, 0) /
              costed.length,
          )
        : null,
    },
  };
}
