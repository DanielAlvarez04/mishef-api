import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovementType, Prisma, UnitCode, CategoryKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  canonicalUnit,
  fromCanonicalQuantity,
  toCanonicalQuantity,
  toDisplayCost,
  toMoney,
} from '../common/units';
import { QuantityConverter } from '../common/quantity-converter.service';
import { isEmptyPatch, sameDecimal } from '../common/patch';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import {
  CreateRecipeDto,
  ProduceRecipeDto,
  PublishRecipeDto,
  RecipeIngredientInputDto,
  UpdateRecipeDto,
} from './dto/recipe.dto';

const ingredientSelect = {
  id: true,
  name: true,
  baseUnit: true,
  displayUnit: true,
  currentStock: true,
  unitCost: true,
  isActive: true,
} as const;

const recipeInclude = {
  category: { select: { id: true, name: true } },
  item: { select: { id: true, name: true, sku: true, price: true, isActive: true } },
  producesIngredient: {
    select: {
      id: true,
      name: true,
      baseUnit: true,
      displayUnit: true,
      currentStock: true,
      unitCost: true,
    },
  },
  ingredients: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: {
      ingredient: { select: ingredientSelect },
      options: {
        orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
        include: { ingredient: { select: ingredientSelect } },
      },
    },
  },
} satisfies Prisma.RecipeInclude;

type RecipeWithRelations = Prisma.RecipeGetPayload<{ include: typeof recipeInclude }>;

interface ResolvedLine {
  ingredientId: string;
  quantity: Prisma.Decimal;
  label: string | null;
  isOptional: boolean;
  alternatives: Array<{ ingredientId: string; quantity: Prisma.Decimal }>;
}

export interface RecipeFilters {
  search?: string;
  categoryId?: string;
  includeInactive?: boolean;
  /** `published` = solo con artículo; `standalone` = sin artículo. */
  publication?: 'published' | 'standalone';
  /** `true` = solo recetas que producen un insumo. */
  producesIngredient?: boolean;
}

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingredientQuantities: IngredientQuantitiesService,
    private readonly quantities: QuantityConverter,
  ) {}

  async list(organizationId: string | null, filters: RecipeFilters = {}) {
    const search = filters.search?.trim();

    const recipes = await this.prisma.recipe.findMany({
      where: {
        organizationId,
        ...(filters.includeInactive ? {} : { isActive: true }),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.publication === 'published'
          ? { itemId: { not: null } }
          : filters.publication === 'standalone'
            ? { itemId: null }
            : {}),
        ...(filters.producesIngredient ? { producesIngredientId: { not: null } } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: recipeInclude,
      orderBy: [{ name: 'asc' }],
    });

    return recipes.map((recipe) => this.toResponse(recipe));
  }

  async findOne(organizationId: string | null, id: string) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id, organizationId },
      include: recipeInclude,
    });

    if (!recipe) {
      throw new NotFoundException('Receta no encontrada');
    }

    return this.toResponse(recipe);
  }

  async create(organizationId: string | null, dto: CreateRecipeDto) {
    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException('El nombre de la receta es obligatorio');
    }

    if (dto.categoryId) {
      await this.assertCategory(organizationId, dto.categoryId);
    }

    const lines = await this.resolveLines(organizationId, dto.ingredients ?? []);

    const recipeId = await this.prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: {
          organizationId,
          name,
          description: normalizeOptional(dto.description),
          categoryId: dto.categoryId ?? null,
          isActive: dto.isActive ?? true,
          ingredients: {
            create: lines.map((line, index) => ({
              ingredientId: line.ingredientId,
              label: line.label,
              quantity: line.quantity,
              isOptional: line.isOptional,
              sortOrder: index,
              options: {
                create: line.alternatives.map((alternative, optionIndex) => ({
                  ingredientId: alternative.ingredientId,
                  quantity: alternative.quantity,
                  sortOrder: optionIndex,
                })),
              },
            })),
          },
        },
      });

      if (dto.produce) {
        await this.attachProduction(tx, organizationId, recipe.id, recipe.name, dto.produce, lines);
      }

      if (dto.publish) {
        await this.publishInTx(tx, organizationId, recipe.id, dto.publish);
      }

      return recipe.id;
    });

    return this.findOne(organizationId, recipeId);
  }

  async update(organizationId: string | null, id: string, dto: UpdateRecipeDto) {
    const recipe = await this.getRecipe(organizationId, id);

    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      await this.assertCategory(organizationId, dto.categoryId);
    }

    const lines =
      dto.ingredients === undefined
        ? undefined
        : await this.resolveLines(organizationId, dto.ingredients);

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const description =
      dto.description === undefined
        ? undefined
        : normalizeOptional(dto.description);

    const data: Prisma.RecipeUncheckedUpdateInput = {};

    if (name !== undefined && name !== recipe.name) data.name = name;
    if (description !== undefined && description !== recipe.description) {
      data.description = description;
    }
    if (
      dto.categoryId !== undefined &&
      (dto.categoryId ?? null) !== recipe.categoryId
    ) {
      data.categoryId = dto.categoryId;
    }
    if (dto.isActive !== undefined && dto.isActive !== recipe.isActive) {
      data.isActive = dto.isActive;
    }

    const currentLines =
      lines === undefined
        ? []
        : await this.prisma.recipeIngredient.findMany({
            where: { recipeId: recipe.id },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            include: {
              options: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
            },
          });

    const linesChanged =
      lines !== undefined && !sameRecipeLines(currentLines, lines);

    if (
      isEmptyPatch(data) &&
      !linesChanged &&
      !dto.produce &&
      !dto.publish
    ) {
      return this.findOne(organizationId, id);
    }

    await this.prisma.$transaction(async (tx) => {
      if (!isEmptyPatch(data)) {
        await tx.recipe.update({
          where: { id: recipe.id },
          data,
        });
      }

      if (linesChanged && lines) {
        await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
        await tx.recipeIngredient.createMany({
          data: lines.map((line, index) => ({
            recipeId: recipe.id,
            ingredientId: line.ingredientId,
            label: line.label,
            quantity: line.quantity,
            isOptional: line.isOptional,
            sortOrder: index,
          })),
        });

        const created = await tx.recipeIngredient.findMany({
          where: { recipeId: recipe.id },
          orderBy: { sortOrder: 'asc' },
          select: { id: true },
        });

        for (const [index, line] of lines.entries()) {
          const ingredient = created[index];
          if (!ingredient) continue;

          if (line.alternatives.length > 0) {
            await tx.recipeIngredientOption.createMany({
              data: line.alternatives.map((alternative, optionIndex) => ({
                recipeIngredientId: ingredient.id,
                ingredientId: alternative.ingredientId,
                quantity: alternative.quantity,
                sortOrder: optionIndex,
              })),
            });
          }
        }
      }

      if (dto.produce) {
        const costLines =
          lines ??
          (
            await tx.recipeIngredient.findMany({
              where: { recipeId: recipe.id },
              select: { ingredientId: true, quantity: true },
            })
          ).map((line) => ({
            ingredientId: line.ingredientId,
            quantity: line.quantity,
            label: null,
            isOptional: false,
            alternatives: [],
          }));

        await this.attachProduction(
          tx,
          organizationId,
          recipe.id,
          dto.name?.trim() || recipe.name,
          dto.produce,
          costLines,
        );
      }

      if (dto.publish) {
        await this.publishInTx(tx, organizationId, recipe.id, dto.publish);
      }
    });

    return this.findOne(organizationId, id);
  }

  async remove(organizationId: string | null, id: string) {
    const recipe = await this.getRecipe(organizationId, id);

    if (recipe.itemId) {
      throw new BadRequestException(
        'La receta está publicada como artículo. Despublícala antes de eliminarla.',
      );
    }

    await this.prisma.recipe.delete({ where: { id: recipe.id } });

    return { ok: true };
  }

  /** Publica la receta como artículo vendible (crea el artículo y sus presentaciones). */
  async publish(organizationId: string | null, id: string, dto: PublishRecipeDto) {
    const recipe = await this.getRecipe(organizationId, id);

    if (recipe.variantId) {
      throw new BadRequestException(
        'Solo una receta base puede publicarse como artículo',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.publishInTx(tx, organizationId, recipe.id, dto);
    });

    return this.findOne(organizationId, id);
  }

  /** Quita el artículo de la receta; la receta sigue existiendo. */
  async unpublish(organizationId: string | null, id: string) {
    const recipe = await this.getRecipe(organizationId, id);

    if (!recipe.itemId) {
      throw new BadRequestException('La receta no está publicada como artículo');
    }

    const itemId = recipe.itemId;

    await this.prisma.$transaction(async (tx) => {
      const orders = await tx.orderItem.count({ where: { itemId } });

      await tx.recipe.update({
        where: { id: recipe.id },
        data: { itemId: null },
      });

      if (orders > 0) {
        // Conserva el artículo para el historial de pedidos, pero ya no se vende.
        await tx.item.update({
          where: { id: itemId },
          data: { isActive: false },
        });
      } else {
        await tx.item.delete({ where: { id: itemId } });
      }
    });

    return this.findOne(organizationId, id);
  }

  /**
   * Produce un lote del insumo asociado a la receta: suma stock en la sucursal
   * activa y registra el movimiento de kardex.
   */
  async produce(
    organizationId: string | null,
    userId: string,
    id: string,
    dto: ProduceRecipeDto,
    branchId: string | null,
  ) {
    if (!organizationId) {
      throw new BadRequestException('Organization required for inventory movement');
    }

    if (!branchId) {
      throw new BadRequestException(
        'Selecciona una sucursal para producir el insumo',
      );
    }

    const recipe = await this.getRecipe(organizationId, id);

    if (!recipe.producesIngredientId) {
      throw new BadRequestException(
        'La receta no está configurada para producir un insumo',
      );
    }

    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: recipe.producesIngredientId, organizationId },
    });

    if (!ingredient) {
      throw new NotFoundException('Insumo producido no encontrado');
    }

    let quantity: Prisma.Decimal;

    if (dto.quantity !== undefined) {
      quantity = await this.quantities.toBaseUnit(
        ingredient,
        dto.quantity,
        dto.unit ?? ingredient.displayUnit,
      );
    } else if (recipe.yieldQuantity && recipe.yieldQuantity.gt(0)) {
      quantity = new Prisma.Decimal(recipe.yieldQuantity);
    } else {
      throw new BadRequestException('Indica la cantidad a producir');
    }

    if (quantity.lte(0)) {
      throw new BadRequestException('La cantidad debe ser mayor que cero');
    }

    const amount = quantity.toString();

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "BranchStock" ("id", "branchId", "ingredientId", "quantity", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${branchId}, ${ingredient.id}, 0, NOW(), NOW())
        ON CONFLICT ("branchId", "ingredientId") DO NOTHING
      `;

      const branchRows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>`
        UPDATE "BranchStock"
        SET "quantity" = "quantity" + CAST(${amount} AS numeric),
            "updatedAt" = NOW()
        WHERE "branchId" = ${branchId}
          AND "ingredientId" = ${ingredient.id}
        RETURNING "quantity"
      `;

      const totals = await tx.$queryRaw<Array<{ currentStock: Prisma.Decimal }>>`
        UPDATE "Ingredient"
        SET "currentStock" = "currentStock" + CAST(${amount} AS numeric),
            "updatedAt" = NOW()
        WHERE "id" = ${ingredient.id}
          AND "organizationId" = ${organizationId}
        RETURNING "currentStock"
      `;

      const stockAfter = new Prisma.Decimal(branchRows[0].quantity);

      await tx.inventoryMovement.create({
        data: {
          organizationId,
          branchId,
          ingredientId: ingredient.id,
          ingredientName: ingredient.name,
          displayUnit: ingredient.displayUnit,
          userId,
          type: InventoryMovementType.PRODUCTION,
          quantity,
          stockAfter,
          reason: dto.reason?.trim() || `Producción: ${recipe.name}`,
          referenceType: 'RECIPE_PRODUCTION',
          referenceId: recipe.id,
        },
      });

      return { totalStock: new Prisma.Decimal(totals[0].currentStock), stockAfter };
    });

    return {
      ok: true,
      ingredientId: ingredient.id,
      ingredientName: ingredient.name,
      displayUnit: ingredient.displayUnit,
      quantity: fromCanonicalQuantity(quantity, ingredient.displayUnit),
      branchStock: fromCanonicalQuantity(result.stockAfter, ingredient.displayUnit),
      totalStock: fromCanonicalQuantity(result.totalStock, ingredient.displayUnit),
    };
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private async resolveLines(
    organizationId: string | null,
    input: RecipeIngredientInputDto[],
  ): Promise<ResolvedLine[]> {
    const lines: ResolvedLine[] = [];

    for (const line of input) {
      const resolved = await this.ingredientQuantities.resolve(organizationId, [
        {
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          unit: line.unit,
        },
        ...(line.alternatives ?? []).map((alternative) => ({
          ingredientId: alternative.ingredientId,
          quantity: alternative.quantity,
          unit: alternative.unit,
        })),
      ]);

      const [defaultOption, ...alternatives] = resolved;

      lines.push({
        ingredientId: defaultOption.ingredientId,
        quantity: defaultOption.quantity,
        label: line.label?.trim() || null,
        isOptional: line.isOptional ?? false,
        alternatives,
      });
    }

    return lines;
  }

  private async publishInTx(
    tx: Prisma.TransactionClient,
    organizationId: string | null,
    recipeId: string,
    dto: PublishRecipeDto,
  ) {
    const recipe = await tx.recipe.findUniqueOrThrow({ where: { id: recipeId } });

    if (recipe.itemId) {
      throw new BadRequestException('La receta ya está publicada como artículo');
    }

    const categoryId = dto.categoryId ?? recipe.categoryId ?? null;

    if (categoryId) {
      await this.assertCategory(organizationId, categoryId);
    }

    const sku = dto.sku?.trim() || null;

    if (sku) {
      const existing = await tx.item.findFirst({
        where: { organizationId, sku: { equals: sku, mode: 'insensitive' } },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException(`El SKU "${sku}" ya está en uso`);
      }
    }

    const variants =
      dto.variants && dto.variants.length > 0
        ? dto.variants
        : [
            { name: 'Chico', priceAdjust: 0, recipeFactor: 0.8, sortOrder: 0 },
            { name: 'Regular', priceAdjust: 0, recipeFactor: 1, sortOrder: 1 },
            { name: 'Grande', priceAdjust: 0, recipeFactor: 1.3, sortOrder: 2 },
          ];

    const item = await tx.item.create({
      data: {
        organizationId,
        categoryId,
        name: recipe.name,
        description: recipe.description,
        sku,
        price: toMoney(dto.price),
        taxRate:
          dto.taxRate === undefined || dto.taxRate === null
            ? null
            : new Prisma.Decimal(dto.taxRate),
        isActive: true,
        variants: {
          create: variants.map((variant, index) => ({
            name: variant.name.trim(),
            priceAdjust: toMoney(variant.priceAdjust ?? 0),
            recipeFactor: new Prisma.Decimal(variant.recipeFactor ?? 1),
            sortOrder: variant.sortOrder ?? index,
            isActive: variant.isActive ?? true,
          })),
        },
      },
    });

    await tx.recipe.update({
      where: { id: recipe.id },
      data: { itemId: item.id },
    });
  }

  private async attachProduction(
    tx: Prisma.TransactionClient,
    organizationId: string | null,
    recipeId: string,
    recipeName: string,
    production: { displayUnit: UnitCode; yieldQuantity: number },
    lines: ResolvedLine[],
  ) {
    const displayUnit = production.displayUnit;
    const baseUnit = canonicalUnit(displayUnit);
    const canonicalYield = toCanonicalQuantity(
      production.yieldQuantity,
      displayUnit,
    );

    if (canonicalYield.lte(0)) {
      throw new BadRequestException('El rendimiento debe ser mayor que cero');
    }

    const name = recipeName.trim();
    const existing = await tx.ingredient.findFirst({
      where: { organizationId, name },
      include: { producedByRecipe: { select: { id: true } } },
    });

    if (existing?.producedByRecipe && existing.producedByRecipe.id !== recipeId) {
      throw new ConflictException(
        `El insumo "${name}" ya es producido por otra receta`,
      );
    }

    const cost = await this.computeCost(tx, lines);
    const unitCost =
      cost.gt(0) && canonicalYield.gt(0)
        ? cost.dividedBy(canonicalYield).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
        : null;

    let ingredientId: string;

    if (existing) {
      ingredientId = existing.id;
      await tx.ingredient.update({
        where: { id: existing.id },
        data: {
          ...(existing.unitCost === null && unitCost !== null ? { unitCost } : {}),
        },
      });
    } else {
      const created = await tx.ingredient.create({
        data: {
          organizationId,
          name,
          displayUnit,
          baseUnit,
          unitCost,
          categoryId: null,
        },
      });
      ingredientId = created.id;
    }

    await tx.recipe.update({
      where: { id: recipeId },
      data: {
        producesIngredientId: ingredientId,
        yieldQuantity: canonicalYield,
        yieldUnit: baseUnit,
      },
    });
  }

  private async computeCost(
    tx: Prisma.TransactionClient,
    lines: Array<{ ingredientId: string; quantity: Prisma.Decimal }>,
  ) {
    let total = new Prisma.Decimal(0);

    for (const line of lines) {
      const ingredient = await tx.ingredient.findUnique({
        where: { id: line.ingredientId },
        select: { unitCost: true },
      });

      if (!ingredient?.unitCost) continue;

      total = total.plus(line.quantity.times(ingredient.unitCost));
    }

    return total;
  }

  private async getRecipe(organizationId: string | null, id: string) {
    const recipe = await this.prisma.recipe.findFirst({
      where: { id, organizationId },
    });

    if (!recipe) {
      throw new NotFoundException('Receta no encontrada');
    }

    return recipe;
  }

  private async assertCategory(organizationId: string | null, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: {
        id: categoryId,
        OR: [{ organizationId }, { organizationId: null, isCore: true }],
      },
      select: { id: true, kind: true, isActive: true },
    });

    if (!category) {
      throw new NotFoundException('Categoría no encontrada');
    }

    if (!category.isActive) {
      throw new BadRequestException('La categoría está desactivada');
    }

    if (category.kind !== CategoryKind.RECIPE) {
      throw new BadRequestException(
        'La categoría no es de recetas y preparaciones',
      );
    }
  }

  private toResponse(recipe: RecipeWithRelations) {
    let cost = new Prisma.Decimal(0);
    let complete = true;

    const ingredients = recipe.ingredients.map((line) => {
      const displayUnit = line.ingredient.displayUnit;

      if (line.ingredient.unitCost === null) {
        complete = false;
      } else {
        cost = cost.plus(line.quantity.times(line.ingredient.unitCost));
      }

      return {
        ...line,
        quantity: fromCanonicalQuantity(line.quantity, displayUnit),
        ingredient: this.displayIngredient(line.ingredient),
        options: line.options.map((option) => ({
          ...option,
          quantity: fromCanonicalQuantity(
            option.quantity,
            option.ingredient.displayUnit,
          ),
          ingredient: this.displayIngredient(option.ingredient),
        })),
      };
    });

    return {
      ...recipe,
      ingredients,
      estimatedCost: complete && recipe.ingredients.length > 0 ? cost : null,
      hasCompleteCost: complete && recipe.ingredients.length > 0,
      canComputeConsumption: recipe.ingredients.length > 0,
    };
  }

  private displayIngredient<
    T extends {
      displayUnit: UnitCode;
      currentStock: Prisma.Decimal;
      unitCost: Prisma.Decimal | null;
    },
  >(ingredient: T) {
    return {
      ...ingredient,
      currentStock: fromCanonicalQuantity(
        ingredient.currentStock,
        ingredient.displayUnit,
      ),
      unitCost:
        ingredient.unitCost === null
          ? null
          : toDisplayCost(ingredient.unitCost, ingredient.displayUnit),
    };
  }
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Compara las líneas guardadas con las que llegan del formulario.
 *
 * El orden importa: `sortOrder` se asigna por índice, así que reordenar
 * ingredientes sí es un cambio real.
 */
function sameRecipeLines(
  current: ReadonlyArray<{
    ingredientId: string;
    quantity: Prisma.Decimal;
    label: string | null;
    isOptional: boolean;
    options: ReadonlyArray<{
      ingredientId: string;
      quantity: Prisma.Decimal;
    }>;
  }>,
  next: ReadonlyArray<ResolvedLine>,
) {
  if (current.length !== next.length) return false;

  return current.every((line, index) => {
    const target = next[index];

    if (
      line.ingredientId !== target.ingredientId ||
      !sameDecimal(line.quantity, target.quantity) ||
      (line.label ?? null) !== (target.label ?? null) ||
      line.isOptional !== target.isOptional ||
      line.options.length !== target.alternatives.length
    ) {
      return false;
    }

    return line.options.every(
      (option, optionIndex) =>
        option.ingredientId === target.alternatives[optionIndex].ingredientId &&
        sameDecimal(option.quantity, target.alternatives[optionIndex].quantity),
    );
  });
}
