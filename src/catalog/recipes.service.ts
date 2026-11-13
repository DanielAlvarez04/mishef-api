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
  sameDimension,
  toCanonicalQuantity,
  toDisplayCost,
  toMoney,
} from '../common/units';
import { QuantityConverter } from '../common/quantity-converter.service';
import { isEmptyPatch, sameDecimal } from '../common/patch';
import { CatalogEntriesService } from './catalog-entries.service';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import { ItemsService } from './items.service';
import { UpdateItemDto } from './dto/item.dto';
import {
  CreateRecipeDto,
  ProduceRecipeDto,
  PublishRecipeDto,
  RecipeIngredientInputDto,
  SaveRecipeDraftItemDto,
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
  catalogEntry: {
    select: {
      id: true,
      imageKey: true,
      imageUrl: true,
      imageVariants: true,
      imageName: true,
    },
  },
  category: { select: { id: true, name: true } },
  item: {
    select: {
      id: true,
      name: true,
      sku: true,
      price: true,
      isActive: true,
      isCombo: true,
      category: { select: { id: true, name: true } },
      catalogEntry: { select: { imageKey: true, imageUrl: true, imageVariants: true } },
      variants: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' as const }, { name: 'asc' as const }],
      },
    },
  },
  producesIngredient: {
    select: {
      id: true,
      name: true,
      sku: true,
      baseUnit: true,
      displayUnit: true,
      currentStock: true,
      minStock: true,
      unitCost: true,
      category: { select: { id: true, name: true, isCore: true } },
    },
  },
  ingredients: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: {
      ingredient: { select: ingredientSelect },
      variant: { select: { id: true, name: true } },
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
  variantId: string | null;
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
    private readonly catalogEntries: CatalogEntriesService,
    private readonly items: ItemsService,
  ) {}

  async list(organizationId: string | null, filters: RecipeFilters = {}) {
    const search = filters.search?.trim();

    const recipes = await this.prisma.recipe.findMany({
      where: {
        organizationId,
        // Las recetas por presentación son legado: ahora una sola receta
        // contiene los insumos comunes y los de cada presentación.
        variantId: null,
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

    if (dto.itemId) {
      if (dto.publish) {
        throw new BadRequestException(
          'El artículo ya existe: vincula la receta sin volver a publicarlo',
        );
      }

      const item = await this.prisma.item.findFirst({
        where: { id: dto.itemId, organizationId },
        select: { id: true },
      });

      if (!item) {
        throw new NotFoundException('Artículo no encontrado');
      }

      if (dto.variantId) {
        const variant = await this.prisma.itemVariant.findFirst({
          where: { id: dto.variantId, itemId: item.id },
          select: { id: true },
        });

        if (!variant) {
          throw new NotFoundException('Presentación no encontrada');
        }
      }

      // La base (variantId null) no está cubierta por el @@unique de Prisma
      // porque Postgres considera distintos los NULL: se valida aquí.
      const existing = await this.prisma.recipe.findFirst({
        where: { itemId: item.id, variantId: dto.variantId ?? null },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('El artículo ya tiene una receta');
      }
    }

    const lines = await this.resolveLines(
      organizationId,
      dto.itemId ?? null,
      dto.ingredients ?? [],
    );

    const recipeId = await this.prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: {
          organizationId,
          itemId: dto.itemId ?? null,
          variantId: dto.variantId ?? null,
          name,
          description: normalizeOptional(dto.description),
          notes: normalizeOptional(dto.notes),
          categoryId: dto.categoryId ?? null,
          isActive: dto.isActive ?? true,
          ingredients: {
            create: lines.map((line, index) => ({
              ingredientId: line.ingredientId,
              variantId: line.variantId,
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

      // Identidad del catálogo: si la receta se vincula a un artículo, comparte
      // su entrada; si es independiente, estrena una con su propio id.
      let catalogEntryId = recipe.id;

      if (dto.itemId) {
        const linked = await tx.item.findUniqueOrThrow({
          where: { id: dto.itemId },
          select: { id: true, catalogEntryId: true },
        });

        catalogEntryId = linked.catalogEntryId ?? linked.id;

        if (!linked.catalogEntryId) {
          await tx.catalogEntry.upsert({
            where: { id: linked.id },
            create: { id: linked.id, organizationId },
            update: {},
          });
          await tx.item.update({
            where: { id: linked.id },
            data: { catalogEntryId: linked.id },
          });
        }
      } else {
        await tx.catalogEntry.create({
          data: { id: recipe.id, organizationId },
        });
      }

      await tx.recipe.update({
        where: { id: recipe.id },
        data: { catalogEntryId },
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

    // Una receta despublicada conserva sus insumos por presentación: se validan
    // contra el artículo archivado (comparte `catalogEntryId`).
    const scopeItemId =
      recipe.itemId ??
      (await this.itemIdOfCatalogEntry(organizationId, recipe.catalogEntryId, true));

    const lines =
      dto.ingredients === undefined
        ? undefined
        : await this.resolveLines(organizationId, scopeItemId, dto.ingredients);

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const description =
      dto.description === undefined
        ? undefined
        : normalizeOptional(dto.description);
    const notes =
      dto.notes === undefined ? undefined : normalizeOptional(dto.notes);

    const data: Prisma.RecipeUncheckedUpdateInput = {};

    if (dto.produce && dto.clearProduce) {
      throw new BadRequestException(
        'No se puede convertir en insumo y desvincularlo a la vez',
      );
    }

    if (dto.clearProduce && recipe.producesIngredientId) {
      data.producesIngredientId = null;
      data.yieldQuantity = null;
      data.yieldUnit = null;
    }

    if (name !== undefined && name !== recipe.name) data.name = name;
    if (description !== undefined && description !== recipe.description) {
      data.description = description;
    }
    if (notes !== undefined && notes !== recipe.notes) {
      data.notes = notes;
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
      !dto.publish &&
      !dto.clearProduce &&
      dto.imageKey === undefined
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
            variantId: line.variantId,
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
            variantId: null,
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

    if (dto.imageKey !== undefined) {
      const entryId =
        recipe.catalogEntryId ??
        (await this.catalogEntries.ensureForRecipe(
          organizationId,
          recipe.id,
        ));

      // La imagen vive en la entrada compartida con el artículo publicado.
      await this.catalogEntries.applyImage(
        organizationId,
        entryId,
        name || recipe.name,
        dto.imageKey,
      );
    }

    return this.findOne(organizationId, id);
  }

  /**
   * Guarda el borrador de artículo de una receta.
   *
   * Conserva presentaciones y opciones aunque la receta todavía no se publique.
   * El artículo vive archivado (no aparece en Artículos ni en menús) y se
   * reutiliza cuando la receta se publica.
   */
  async saveDraftItem(
    organizationId: string | null,
    id: string,
    dto: SaveRecipeDraftItemDto,
  ) {
    const recipe = await this.getRecipe(organizationId, id);

    if (recipe.itemId) {
      throw new BadRequestException(
        'La receta ya está publicada como artículo',
      );
    }

    if (recipe.producesIngredientId) {
      throw new BadRequestException(
        'Un insumo no puede convertirse en artículo ni receta',
      );
    }

    const catalogEntryId =
      recipe.catalogEntryId ??
      (await this.catalogEntries.ensureForRecipe(organizationId, recipe.id));

    if (dto.categoryId) {
      await this.assertCategory(
        organizationId,
        dto.categoryId,
        CategoryKind.ARTICLE,
      );
    }

    const existing = await this.prisma.item.findFirst({
      where: { catalogEntryId, organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        categoryId: true,
        isActive: true,
        isArchived: true,
      },
    });

    const draftPrice =
      dto.price === undefined ? undefined : toMoney(dto.price);

    let item: { id: string };

    if (existing) {
      const data: Prisma.ItemUncheckedUpdateInput = {
        ...(existing.name !== recipe.name ? { name: recipe.name } : {}),
        ...(existing.description !== recipe.description
          ? { description: recipe.description }
          : {}),
        ...(draftPrice !== undefined && !existing.price.equals(draftPrice)
          ? { price: draftPrice }
          : {}),
        ...(dto.categoryId !== undefined &&
        (existing.categoryId ?? null) !== dto.categoryId
          ? { categoryId: dto.categoryId }
          : {}),
        ...(existing.isActive ? { isActive: false } : {}),
        ...(existing.isArchived ? {} : { isArchived: true }),
      };

      item = isEmptyPatch(data)
        ? existing
        : await this.prisma.item.update({
            where: { id: existing.id },
            data,
          });
    } else {
      item = await this.prisma.item.create({
        data: {
          organizationId,
          catalogEntryId,
          name: recipe.name,
          description: recipe.description,
          categoryId: dto.categoryId ?? null,
          price: draftPrice ?? new Prisma.Decimal(0),
          isActive: false,
          isArchived: true,
        },
      });
    }

    const changes: UpdateItemDto = {};

    if (dto.variants !== undefined) changes.variants = dto.variants;
    if (dto.optionGroups !== undefined) changes.optionGroups = dto.optionGroups;

    if (!isEmptyPatch(changes)) {
      await this.items.update(organizationId, item.id, changes);
    }

    return this.items.findOne(organizationId, item.id);
  }

  async remove(organizationId: string | null, id: string) {
    const recipe = await this.getRecipe(organizationId, id);

    if (recipe.itemId) {
      throw new BadRequestException(
        'La receta está publicada como artículo. Despublícala antes de eliminarla.',
      );
    }

    await this.prisma.recipe.delete({ where: { id: recipe.id } });

    // Si no queda artículo ni otra receta, se borra la entrada y su imagen.
    await this.catalogEntries.deleteIfOrphan(recipe.catalogEntryId, organizationId);

    return { ok: true };
  }

  /** Elimina varias recetas no publicadas; las publicadas deben despublicarse antes. */
  async removeMany(organizationId: string | null, ids: string[]) {
    const uniqueIds = [...new Set(ids)];

    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: uniqueIds }, organizationId },
      select: { id: true, itemId: true, catalogEntryId: true },
    });

    if (recipes.length !== uniqueIds.length) {
      throw new NotFoundException('Receta no encontrada');
    }

    if (recipes.some((recipe) => recipe.itemId)) {
      throw new BadRequestException(
        'Despublica las recetas publicadas como artículo antes de eliminarlas',
      );
    }

    await this.prisma.recipe.deleteMany({
      where: { id: { in: uniqueIds } },
    });

    const entryIds = [
      ...new Set(
        recipes
          .map((recipe) => recipe.catalogEntryId)
          .filter((id): id is string => id !== null),
      ),
    ];

    for (const entryId of entryIds) {
      await this.catalogEntries.deleteIfOrphan(entryId, organizationId);
    }

    return { deletedCount: recipes.length };
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

    // Solo una receta con insumos puede dejar de publicarse: el artículo se
    // retira del catálogo, pero la receta debe seguir siendo útil por sí sola.
    const ingredients = await this.prisma.recipeIngredient.count({
      where: { recipeId: recipe.id },
    });

    if (ingredients === 0) {
      throw new BadRequestException(
        'Agrega insumos a la receta antes de dejar de publicarla como artículo',
      );
    }

    const itemId = recipe.itemId;

    await this.prisma.$transaction(async (tx) => {
      await tx.recipe.update({
        where: { id: recipe.id },
        data: { itemId: null },
      });

      // Se retira de los menús y se archiva: desaparece del catálogo de
      // artículos, pero conserva sus presentaciones y opciones para cuando se
      // vuelva a publicar.
      await tx.menuItem.deleteMany({ where: { itemId } });
      await tx.item.update({
        where: { id: itemId },
        data: { isActive: false, isArchived: true },
      });
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
    itemId: string | null,
    input: RecipeIngredientInputDto[],
  ): Promise<ResolvedLine[]> {
    const lines: ResolvedLine[] = [];
    const seen = new Set<string>();

    for (const line of input) {
      const variantId = line.variantId ?? null;

      if (variantId) {
        if (!itemId) {
          throw new BadRequestException(
            'Solo una receta vinculada a un artículo puede tener insumos por presentación',
          );
        }

        const variant = await this.prisma.itemVariant.findFirst({
          where: { id: variantId, itemId },
          select: { id: true },
        });

        if (!variant) {
          throw new BadRequestException(
            'La presentación no pertenece al artículo de la receta',
          );
        }
      }

      const key = `${variantId ?? 'common'}:${line.ingredientId}`;

      if (seen.has(key)) {
        throw new BadRequestException(
          variantId
            ? 'El insumo está repetido en la misma presentación'
            : 'El insumo está repetido en la receta común',
        );
      }
      seen.add(key);

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
        variantId,
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

    if (recipe.producesIngredientId) {
      throw new BadRequestException(
        'Un insumo no puede publicarse como artículo',
      );
    }

    const categoryId = dto.categoryId ?? recipe.categoryId ?? null;

    if (categoryId) {
      // Al publicar, la categoría elegida explícitamente es de artículo; si se
      // hereda la de la receta se mantiene la validación histórica.
      await this.assertCategory(
        organizationId,
        categoryId,
        dto.categoryId ? CategoryKind.ARTICLE : CategoryKind.RECIPE,
      );
    }

    const sku = dto.sku?.trim() || null;

    const variants =
      dto.variants && dto.variants.length > 0
        ? dto.variants
        : [
            { name: 'Chico', priceAdjust: 0, recipeFactor: 0.8, sortOrder: 0 },
            { name: 'Regular', priceAdjust: 0, recipeFactor: 1, sortOrder: 1 },
            { name: 'Grande', priceAdjust: 0, recipeFactor: 1.3, sortOrder: 2 },
          ];

    // La receta ya tiene una entrada (la crea `create`). Si viene de datos
    // históricos sin entrada, se estrena aquí con su propio id.
    let catalogEntryId = recipe.catalogEntryId;

    if (!catalogEntryId) {
      await tx.catalogEntry.create({
        data: { id: recipe.id, organizationId },
      });
      catalogEntryId = recipe.id;
      await tx.recipe.update({
        where: { id: recipe.id },
        data: { catalogEntryId },
      });
    }

    // Al despublicar, el artículo se archiva en vez de borrarse: se reutiliza
    // esa misma fila (la entrada de catálogo es única) para no duplicarla.
    const archivedItem = await tx.item.findFirst({
      where: { catalogEntryId, organizationId },
      select: { id: true },
    });

    if (sku) {
      const existing = await tx.item.findFirst({
        where: {
          organizationId,
          sku: { equals: sku, mode: 'insensitive' },
          ...(archivedItem ? { id: { not: archivedItem.id } } : {}),
        },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException(`El SKU "${sku}" ya está en uso`);
      }
    }

    const itemData = {
      organizationId,
      categoryId,
      catalogEntryId,
      name: recipe.name,
      description: recipe.description,
      sku,
      price: toMoney(dto.price),
      taxRate:
        dto.taxRate === undefined || dto.taxRate === null
          ? null
          : new Prisma.Decimal(dto.taxRate),
      isActive: true,
      isArchived: false,
    };

    const item = archivedItem
      ? await tx.item.update({
          where: { id: archivedItem.id },
          data: itemData,
        })
      : await tx.item.create({
          data: {
            ...itemData,
            variants: {
              create: variants.map((variant, index) => ({
                name: variant.name.trim(),
                priceAdjust: toMoney(variant.priceAdjust ?? 0),
                recipeFactor: new Prisma.Decimal(variant.recipeFactor ?? 1),
                sortOrder: variant.sortOrder ?? index,
                isActive: variant.isActive ?? true,
                isPrimary: variant.isPrimary ?? false,
              })),
            },
          },
        });

    // Al republicar solo se tocan las presentaciones si el formulario las
    // envió; si no, se conservan las que tenía el artículo archivado.
    if (archivedItem && dto.variants && dto.variants.length > 0) {
      const current = await tx.itemVariant.findMany({
        where: { itemId: item.id },
        select: { id: true, name: true },
      });
      const keptIds = new Set<string>();

      for (const [index, variant] of variants.entries()) {
        const key = variant.name.trim().toLowerCase();
        const byId = variant.id
          ? current.find((candidate) => candidate.id === variant.id)
          : undefined;
        const match =
          byId ??
          current.find(
            (candidate) => candidate.name.trim().toLowerCase() === key,
          );

        if (match) keptIds.add(match.id);

        const data = {
          name: variant.name.trim(),
          priceAdjust: toMoney(variant.priceAdjust ?? 0),
          recipeFactor: new Prisma.Decimal(variant.recipeFactor ?? 1),
          sortOrder: variant.sortOrder ?? index,
          isActive: variant.isActive ?? true,
          ...(variant.isPrimary !== undefined
            ? { isPrimary: variant.isPrimary }
            : {}),
        };

        if (match) {
          await tx.itemVariant.update({ where: { id: match.id }, data });
        } else {
          await tx.itemVariant.create({
            data: { itemId: item.id, ...data },
          });
        }
      }

      const stale = current.filter((candidate) => !keptIds.has(candidate.id));

      if (stale.length > 0) {
        await tx.itemVariant.updateMany({
          where: { id: { in: stale.map((candidate) => candidate.id) } },
          data: { isActive: false, isPrimary: false },
        });
      }
    }

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
    production: {
      displayUnit: UnitCode;
      yieldQuantity: number;
      categoryId?: string;
      minStock?: number;
    },
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

    let categoryId: string | undefined;

    if (production.categoryId) {
      const category = await tx.ingredientCategory.findFirst({
        where: {
          id: production.categoryId,
          isActive: true,
          OR: [{ organizationId }, { organizationId: null }],
        },
        select: { id: true },
      });

      if (!category) {
        throw new BadRequestException(
          'Selecciona una categoría válida para el insumo',
        );
      }

      categoryId = category.id;
    }

    const canonicalMinStock =
      production.minStock === undefined
        ? undefined
        : toCanonicalQuantity(production.minStock, displayUnit);

    const name = recipeName.trim();
    const currentRecipe = await tx.recipe.findUnique({
      where: { id: recipeId },
      select: { producesIngredientId: true },
    });

    // Se busca primero por el vínculo de producción: así renombrar la receta
    // actualiza el mismo insumo en lugar de crear otro.
    let existing = currentRecipe?.producesIngredientId
      ? await tx.ingredient.findFirst({
          where: { id: currentRecipe.producesIngredientId, organizationId },
          include: { producedByRecipe: { select: { id: true } } },
        })
      : null;

    if (!existing) {
      existing = await tx.ingredient.findFirst({
        where: { organizationId, name },
        include: { producedByRecipe: { select: { id: true } } },
      });
    }

    if (existing?.producedByRecipe && existing.producedByRecipe.id !== recipeId) {
      throw new ConflictException(
        `El insumo "${name}" ya es producido por otra receta`,
      );
    }

    // El costo de preparación se reparte entre el rendimiento del lote.
    const { total: cost, complete: costComplete } = await this.computeCost(
      tx,
      organizationId,
      lines,
    );
    const unitCost =
      costComplete && cost.gt(0) && canonicalYield.gt(0)
        ? cost
            .dividedBy(canonicalYield)
            .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
        : null;

    let ingredientId: string;

    if (existing) {
      if (existing.name !== name) {
        const duplicated = await tx.ingredient.findFirst({
          where: {
            organizationId,
            name,
            id: { not: existing.id },
          },
          select: { id: true },
        });

        if (duplicated) {
          throw new ConflictException(
            `Ya existe un insumo llamado "${name}"`,
          );
        }
      }

      if (!sameDimension(displayUnit, existing.baseUnit)) {
        throw new BadRequestException(
          'La unidad del rendimiento debe medir lo mismo que el insumo',
        );
      }

      ingredientId = existing.id;

      await tx.ingredient.update({
        where: { id: existing.id },
        data: {
          ...(existing.name !== name ? { name } : {}),
          ...(existing.displayUnit !== displayUnit ? { displayUnit } : {}),
          ...(existing.baseUnit !== baseUnit ? { baseUnit } : {}),
          ...(categoryId && existing.categoryId !== categoryId
            ? { categoryId }
            : {}),
          ...(canonicalMinStock && !canonicalMinStock.equals(existing.minStock)
            ? { minStock: canonicalMinStock }
            : {}),
          ...(unitCost !== null &&
          !(existing.unitCost && existing.unitCost.equals(unitCost))
            ? { unitCost }
            : {}),
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
          categoryId: categoryId ?? null,
          minStock: canonicalMinStock ?? new Prisma.Decimal(0),
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
    organizationId: string | null,
    lines: Array<{ ingredientId: string; quantity: Prisma.Decimal }>,
  ) {
    let total = new Prisma.Decimal(0);
    let complete = true;

    for (const line of lines) {
      const ingredient = await tx.ingredient.findFirst({
        where: { id: line.ingredientId, organizationId },
        select: { unitCost: true },
      });

      if (!ingredient?.unitCost) {
        complete = false;
        continue;
      }

      total = total.plus(line.quantity.times(ingredient.unitCost));
    }

    return { total, complete };
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

  /**
   * Artículo que comparte la entrada de catálogo de la receta. Con
   * `onlyArchived` solo devuelve el artículo archivado por despublicación.
   */
  private async itemIdOfCatalogEntry(
    organizationId: string | null,
    catalogEntryId: string | null,
    onlyArchived = false,
  ): Promise<string | null> {
    if (!catalogEntryId) return null;

    const item = await this.prisma.item.findFirst({
      where: { catalogEntryId, organizationId },
      select: { id: true, isArchived: true },
    });

    if (!item || (onlyArchived && !item.isArchived)) return null;

    return item.id;
  }

  private async assertCategory(
    organizationId: string | null,
    categoryId: string,
    kind: CategoryKind = CategoryKind.RECIPE,
  ) {
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

    if (category.kind !== kind) {
      throw new BadRequestException(
        kind === CategoryKind.ARTICLE
          ? 'La categoría no es de artículos'
          : 'La categoría no es de recetas y preparaciones',
      );
    }
  }

  private toResponse(recipe: RecipeWithRelations) {
    const { catalogEntry, item, ...rest } = recipe;

    const commonLines = recipe.ingredients.filter(
      (line) => line.variantId === null,
    );
    const scopedLines = recipe.ingredients.filter(
      (line) => line.variantId !== null,
    );

    const costFor = (variantId: string | null) => {
      const variantLines = variantId
        ? scopedLines.filter((line) => line.variantId === variantId)
        : [];
      const overridden = new Set(
        variantLines.map((line) => line.ingredientId),
      );
      const effective = [
        ...commonLines.filter((line) => !overridden.has(line.ingredientId)),
        ...variantLines,
      ];

      let cost = new Prisma.Decimal(0);
      let complete = true;

      for (const line of effective) {
        if (line.ingredient.unitCost === null) {
          complete = false;
        } else {
          cost = cost.plus(line.quantity.times(line.ingredient.unitCost));
        }
      }

      const factor = variantId
        ? (item?.variants.find((variant) => variant.id === variantId)
            ?.recipeFactor ?? new Prisma.Decimal(1))
        : new Prisma.Decimal(1);

      return {
        cost: cost.times(factor),
        complete,
        count: effective.length,
      };
    };

    const activeVariants = item
      ? item.variants.filter((variant) => variant.isActive)
      : [];
    const primaryVariant =
      activeVariants.find((variant) => variant.isPrimary) ?? activeVariants[0];
    const primaryCost = costFor(primaryVariant?.id ?? null);

    const ingredients = recipe.ingredients.map((line) => {
      const displayUnit = line.ingredient.displayUnit;
      const { variant, ...restLine } = line;

      return {
        ...restLine,
        variantName: variant?.name ?? null,
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

    // La imagen vive en la entrada compartida. Se aplana igual que en los
    // artículos para no cambiar el contrato de la web.
    const flatItem = item
      ? (() => {
          const { catalogEntry: itemEntry, ...itemRest } = item;

          return {
            ...itemRest,
            imageKey: itemEntry?.imageKey ?? null,
            imageUrl: itemEntry?.imageUrl ?? null,
            imageVariants: itemEntry?.imageVariants ?? null,
          };
        })()
      : null;

    return {
      ...rest,
      imageKey: catalogEntry?.imageKey ?? null,
      imageUrl: catalogEntry?.imageUrl ?? null,
      imageVariants: catalogEntry?.imageVariants ?? null,
      imageName: catalogEntry?.imageName ?? null,
      item: flatItem,
      producesIngredient: recipe.producesIngredient
        ? this.displayProducedIngredient(recipe.producesIngredient)
        : null,
      ingredients,
      estimatedCost:
        primaryCost.complete && primaryCost.count > 0
          ? primaryCost.cost
          : null,
      hasCompleteCost: primaryCost.complete && primaryCost.count > 0,
      canComputeConsumption: primaryCost.count > 0,
      variantCosts: activeVariants.map((variant) => {
        const result = costFor(variant.id);

        return {
          variantId: variant.id,
          variantName: variant.name,
          estimatedCost:
            result.complete && result.count > 0 ? result.cost.toString() : null,
          hasCompleteCost: result.complete && result.count > 0,
        };
      }),
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

  private displayProducedIngredient<
    T extends {
      displayUnit: UnitCode;
      currentStock: Prisma.Decimal;
      minStock: Prisma.Decimal;
      unitCost: Prisma.Decimal | null;
    },
  >(ingredient: T) {
    return {
      ...ingredient,
      currentStock: fromCanonicalQuantity(
        ingredient.currentStock,
        ingredient.displayUnit,
      ),
      minStock: fromCanonicalQuantity(
        ingredient.minStock,
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
    variantId: string | null;
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
      (line.variantId ?? null) !== (target.variantId ?? null) ||
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
