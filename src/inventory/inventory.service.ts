import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementType,
  Prisma,
  UnitCode,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch, sameDecimal } from '../common/patch';
import { QuantityConverter } from '../common/quantity-converter.service';
import { categoryInitials } from '../common/sku';
import { CORE_CATEGORIES } from '../catalog/core-categories';
import {
  canonicalFactor,
  canonicalUnit,
  fromCanonicalQuantity,
  sameDimension,
  toCanonicalCost,
  toCanonicalQuantity,
  toDisplayCost,
  toQuantity,
  unitDefinition,
} from '../common/units';
import {
  CreateAdjustmentDto,
  CreateEquivalenceDto,
  CreateIngredientDto,
  ImportIngredientRowDto,
  UpdateIngredientDto,
} from './dto/inventory.dto';

export interface IngredientFilters {
  search?: string;
  includeInactive?: boolean;
  lowStockOnly?: boolean;
  /** Modo Global: devuelve el stock de todas las sucursales. */
  includeBranchStocks?: boolean;
}

export interface MovementFilters {
  ingredientId?: string;
  type?: InventoryMovementType;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

const movementInclude = {
  ingredient: {
    select: {
      id: true,
      name: true,
      baseUnit: true,
      displayUnit: true,
    },
  },
  user: { select: { id: true, name: true, email: true } },
  branch: { select: { id: true, name: true } },
} as const;

/**
 * `referenceType` del movimiento que registra el stock inicial al crear un
 * insumo. Sirve para distinguir el alta de los ajustes manuales en el kardex.
 */
const INGREDIENT_CREATED_REFERENCE = 'INGREDIENT_CREATED';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quantities: QuantityConverter,
  ) {}

  async listIngredients(
    organizationId: string | null,
    filters: IngredientFilters = {},
    branchId: string | null = null,
  ) {
    const search = filters.search?.trim();

    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        organizationId,
        ...(filters.includeInactive ? {} : { isActive: true }),
        ...(search
          ? { name: { contains: search, mode: 'insensitive' as const } }
          : {}),
      },
      include: {
        _count: {
          select: {
            recipeIngredients: true,
            inventoryMovements: true,
          },
        },
        category: { select: { id: true, name: true, isCore: true } },
        location: { select: { id: true, name: true, isCore: true } },
        ...(filters.includeBranchStocks
          ? {
              branchStocks: {
                select: {
                  branchId: true,
                  quantity: true,
                  branch: { select: { id: true, name: true } },
                },
              },
            }
          : branchId
            ? {
                branchStocks: {
                  where: { branchId },
                  select: { branchId: true, quantity: true },
                },
              }
            : {}),
      },
      orderBy: { name: 'asc' },
    });

    return ingredients
      .map((ingredient) => {
        // Con sucursal activa se muestra su existencia; el total de la
        // organización se conserva en `organizationStock`. Si la sucursal aún
        // no tiene fila de stock, su existencia es 0 (no el total de la org).
        const branchStocks =
          (
            ingredient as {
              branchStocks?: Array<{
                branchId: string;
                quantity: Prisma.Decimal;
                branch?: { id: string; name: string };
              }>;
            }
          ).branchStocks ?? [];
        const branchStock = branchId
          ? branchStocks.find((row) => row.branchId === branchId)?.quantity
          : undefined;
        const stock = branchId
          ? (branchStock ?? new Prisma.Decimal(0))
          : ingredient.currentStock;
        const displayUnit = ingredient.displayUnit;
        const deficit = stock.lt(ingredient.minStock)
          ? ingredient.minStock.minus(stock)
          : new Prisma.Decimal(0);

        // Se devuelve todo en la unidad visible del ingrediente; la BD sigue
        // guardando la unidad canónica.
        return {
          ...ingredient,
          currentStock: fromCanonicalQuantity(stock, displayUnit),
          organizationStock: fromCanonicalQuantity(
            ingredient.currentStock,
            displayUnit,
          ),
          minStock: fromCanonicalQuantity(ingredient.minStock, displayUnit),
          maxStock:
            ingredient.maxStock == null
              ? null
              : fromCanonicalQuantity(ingredient.maxStock, displayUnit),
          unitCost:
            ingredient.unitCost == null
              ? null
              : toDisplayCost(ingredient.unitCost, displayUnit),
          branchStocks: branchStocks.map((row) => ({
            branchId: row.branchId,
            ...(row.branch ? { branch: row.branch } : {}),
            quantity: fromCanonicalQuantity(row.quantity, displayUnit),
          })),
          branchId,
          isLowStock: stock.lte(ingredient.minStock),
          deficit: fromCanonicalQuantity(deficit, displayUnit),
        };
      })
      .filter((ingredient) => !filters.lowStockOnly || ingredient.isLowStock);
  }

  async createIngredient(
    organizationId: string | null,
    userId: string,
    dto: CreateIngredientDto,
    branchId: string | null = null,
  ) {
    const name = dto.name.trim();
    await this.assertNameAvailable(organizationId, name);

    // La categoría es obligatoria y define el prefijo del SKU.
    const category = await this.resolveCategory(organizationId, dto.categoryId);
    const sku = await this.generateSku(organizationId, category.name);

    // Las cantidades y el costo llegan en la unidad visible y se guardan en la
    // unidad canónica de la dimensión.
    const displayUnit = dto.displayUnit ?? UnitCode.UNIT;
    const baseUnit = canonicalUnit(displayUnit);
    const initialStock = toCanonicalQuantity(dto.currentStock ?? 0, displayUnit);
    const minStock = toCanonicalQuantity(dto.minStock ?? 0, displayUnit);

    const ingredient = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ingredient.create({
        data: {
          organizationId,
          name,
          sku,
          baseUnit,
          displayUnit,
          minStock,
          maxStock:
            dto.maxStock !== undefined
              ? toCanonicalQuantity(dto.maxStock, displayUnit)
              : null,
          unitCost:
            dto.unitCost !== undefined
              ? toCanonicalCost(dto.unitCost, displayUnit)
              : null,
          categoryId: category.id,
          locationId: dto.locationId || null,
        },
      });

      if (initialStock.gt(0)) {
        if (!organizationId) {
          throw new BadRequestException(
            'Organization required for inventory movement',
          );
        }

        await tx.ingredient.update({
          where: { id: created.id },
          data: { currentStock: initialStock },
        });

        if (branchId) {
          await tx.branchStock.create({
            data: {
              branchId,
              ingredientId: created.id,
              quantity: initialStock,
            },
          });
        }

        await tx.inventoryMovement.create({
          data: {
            organizationId,
            branchId,
            ingredientId: created.id,
            ingredientName: name,
            displayUnit,
            userId,
            type: InventoryMovementType.ADJUSTMENT,
            quantity: initialStock,
            stockAfter: initialStock,
            reason: 'Stock inicial',
            referenceType: INGREDIENT_CREATED_REFERENCE,
          },
        });
      }

      return tx.ingredient.findUniqueOrThrow({ where: { id: created.id } });
    });

    return this.withFlags(ingredient);
  }

  /**
   * Alta masiva de ingredientes desde una sola pantalla.
   *
   * Cada ingrediente conserva su propio movimiento de stock inicial. Se valida
   * la lista completa antes de crear nada para no dejar altas a medias.
   */
  async createIngredients(
    organizationId: string | null,
    userId: string,
    dtos: CreateIngredientDto[],
    branchId: string | null = null,
  ) {
    const seen = new Set<string>();

    for (const dto of dtos) {
      const name = dto.name.trim();
      const key = name.toLowerCase();

      if (seen.has(key)) {
        throw new BadRequestException(
          `"${name}" está repetido en la lista`,
        );
      }

      seen.add(key);
    }

    for (const dto of dtos) {
      await this.assertNameAvailable(organizationId, dto.name.trim());
    }

    const created = [];

    for (const dto of dtos) {
      created.push(
        await this.createIngredient(organizationId, userId, dto, branchId),
      );
    }

    return created;
  }

  /**
   * Importa ingredientes desde CSV.
   *
   * Formato esperado (cabecera opcional):
   * nombre,unidad,categoria,ubicacion,costoUnitario,stockMaximo,stockInicial,stockMinimo
   *
   * - unidad: unidad visible del insumo (G, KG, ML, L, UNIT, etc.)
   * - currentStock/minStock/maxStock/unitCost: números en esa unidad visible
   * - categoria: obligatoria (nombre exacto); el SKU se genera automáticamente
   * - ubicacion: nombre de la ubicación (opcional)
   * - Las unidades deben ser códigos válidos del enum UnitCode
   *
   * `mode` decide qué hacer con los nombres repetidos (en el archivo o ya
   * existentes):
   * - `exclude`: se omiten (por defecto).
   * - `duplicate`: se crean con el sufijo "[ DUPLICADO]".
   * - `overwrite`: la fila reemplaza los datos del insumo existente; dentro del
   *   archivo gana la última aparición. El stock actual no se toca: solo cambia
   *   con ajustes auditables.
   */
  async importIngredientsFromCsv(
    organizationId: string | null,
    userId: string,
    csvText: string,
    branchId: string | null = null,
    mode: string = 'exclude',
  ) {
    if (mode !== 'exclude' && mode !== 'duplicate' && mode !== 'overwrite') {
      throw new BadRequestException(`Modo de importación inválido: ${mode}`);
    }

    const lines = csvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      throw new BadRequestException('El CSV está vacío');
    }

    // Detectar si la primera línea es cabecera
    const hasHeader =
      /nombre|name|unidad|baseunit|stock|min|category|categoria|location|ubicacion|cost|costo|variante|variant/i.test(
        lines[0],
      );
    const startIndex = hasHeader ? 1 : 0;

    // Cargar mapas de categorías y ubicaciones
    const categories = await this.prisma.ingredientCategory.findMany({
      where: { isActive: true,
        OR: [
          { organizationId },
          { organizationId: null },
        ],
      },
      select: { id: true, name: true },
    });
    const categoryMap = Object.fromEntries(
      categories.map((c) => [c.name.toLowerCase(), c.id])
    );

    const locations = await this.prisma.ingredientLocation.findMany({
      where: { isActive: true,
        OR: [
          { organizationId },
          { organizationId: null },
        ],
      },
      select: { id: true, name: true },
    });
    const locationMap = Object.fromEntries(
      locations.map((l) => [l.name.toLowerCase(), l.id])
    );

    const dtos: ImportIngredientRowDto[] = [];

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      // Parse CSV respetando campos entre comillas (las categorías pueden
      // contener comas, p. ej. "Aceites, salsas y condimentos").
      const cols = parseCsvLine(line);

      if (cols.length < 1 || cols[0] === '') {
        continue; // Saltar líneas vacías
      }

      const name = cols[0];
      if (!name || name.length < 2) {
        throw new BadRequestException(
          `Línea ${i + 1}: nombre de ingrediente inválido`,
        );
      }

      const displayUnit = (cols[1]?.toUpperCase() ?? 'UNIT') as UnitCode;
      const categoryName = cols[2]?.toLowerCase().trim();
      const locationName = cols[3]?.toLowerCase().trim();
      const unitCost = cols[4] ? Number(cols[4].replace(',', '.')) : undefined;
      const maxStock = cols[5] ? Number(cols[5].replace(',', '.')) : undefined;
      const currentStock = cols[6] ? Number(cols[6].replace(',', '.')) : 0;
      const minStock = cols[7] ? Number(cols[7].replace(',', '.')) : 0;

      if (displayUnit && !Object.values(UnitCode).includes(displayUnit)) {
        throw new BadRequestException(
          `Línea ${i + 1}: unidad "${cols[1]}" no válida. Unidades válidas: ${Object.values(UnitCode).join(', ')}`,
        );
      }

      if (!categoryName) {
        throw new BadRequestException(
          `Línea ${i + 1}: la categoría es obligatoria`,
        );
      }

      const categoryId = categoryMap[categoryName];
      if (!categoryId) {
        throw new BadRequestException(
          `Línea ${i + 1}: categoría "${cols[2]}" no encontrada`,
        );
      }

      const locationId = locationName ? locationMap[locationName] : undefined;
      if (locationName && !locationId) {
        throw new BadRequestException(
          `Línea ${i + 1}: ubicación "${cols[3]}" no encontrada`,
        );
      }

      if (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) {
        throw new BadRequestException(
          `Línea ${i + 1}: costo unitario inválido`,
        );
      }
      if (maxStock !== undefined && (!Number.isFinite(maxStock) || maxStock < 0)) {
        throw new BadRequestException(
          `Línea ${i + 1}: stock máximo inválido`,
        );
      }
      if (!Number.isFinite(currentStock) || currentStock < 0) {
        throw new BadRequestException(
          `Línea ${i + 1}: stock inicial inválido`,
        );
      }
      if (!Number.isFinite(minStock) || minStock < 0) {
        throw new BadRequestException(
          `Línea ${i + 1}: stock mínimo inválido`,
        );
      }

      dtos.push({
        name: name.trim(),
        displayUnit,
        categoryId,
        locationId,
        unitCost,
        maxStock,
        currentStock,
        minStock,
      });
    }

    if (dtos.length === 0) {
      throw new BadRequestException('No se encontraron ingredientes válidos en el CSV');
    }

    // Nombres ya existentes en el inventario (comparación sin distinguir
    // mayúsculas, igual que la restricción de unicidad).
    const existing = await this.prisma.ingredient.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const existingByName = new Map(
      existing.map((item) => [item.name.trim().toLowerCase(), item.id]),
    );

    const usedNames = new Set(existingByName.keys());
    /** Insumos nuevos a crear, indexados por nombre normalizado. */
    const pending = new Map<string, ImportIngredientRowDto>();
    /** Insumos existentes a sobreescribir, indexados por id. */
    const overwrites = new Map<string, ImportIngredientRowDto>();

    /** Genera un nombre libre añadiendo el sufijo de duplicado. */
    const makeDuplicateName = (name: string) => {
      let candidate = `${name} [ DUPLICADO]`;
      let counter = 2;

      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${name} [ DUPLICADO ${counter}]`;
        counter += 1;
      }

      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    for (const dto of dtos) {
      const key = dto.name.trim().toLowerCase();
      const existingId = existingByName.get(key);
      const alreadyInFile = pending.has(key);

      if (existingId) {
        if (mode === 'exclude') continue;

        if (mode === 'overwrite') {
          // La última fila del archivo manda.
          overwrites.set(existingId, dto);
          continue;
        }

        const duplicate = { ...dto, name: makeDuplicateName(dto.name) };
        pending.set(duplicate.name.toLowerCase(), duplicate);
        continue;
      }

      if (alreadyInFile) {
        if (mode === 'exclude') continue;

        if (mode === 'overwrite') {
          // La fila posterior reemplaza por completo a la anterior.
          pending.set(key, dto);
          continue;
        }

        const duplicate = { ...dto, name: makeDuplicateName(dto.name) };
        pending.set(duplicate.name.toLowerCase(), duplicate);
        continue;
      }

      usedNames.add(key);
      pending.set(key, dto);
    }

    const updated = [];

    for (const [id, dto] of overwrites) {
      updated.push(
        await this.updateIngredient(organizationId, id, {
          name: dto.name,
          displayUnit: dto.displayUnit,
          categoryId: dto.categoryId,
          locationId: dto.locationId,
          unitCost: dto.unitCost,
          minStock: dto.minStock,
          maxStock: dto.maxStock,
        }),
      );
    }

    const created = [];

    for (const dto of pending.values()) {
      created.push(
        await this.createIngredient(organizationId, userId, dto, branchId),
      );
    }

    return [...updated, ...created];
  }

  async updateIngredient(
    organizationId: string | null,
    id: string,
    dto: UpdateIngredientDto,
  ) {
    const ingredient = await this.getIngredient(organizationId, id);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.toLowerCase() !== ingredient.name.toLowerCase()) {
        await this.assertNameAvailable(organizationId, name, ingredient.id);
      }
    }

    // El SKU no se edita: se regenera con el prefijo de la nueva categoría.
    let nextCategoryId: string | undefined;
    let nextSku: string | undefined;

    if (dto.categoryId !== undefined) {
      const category = await this.resolveCategory(organizationId, dto.categoryId);
      nextCategoryId = category.id;

      if (category.id !== ingredient.categoryId) {
        nextSku = await this.generateSku(organizationId, category.name);
      }
    }

    // La unidad visible puede cambiar en cualquier momento: solo se valida que
    // siga midiendo lo mismo. Las cantidades guardadas no se reescriben.
    if (dto.displayUnit !== undefined && !sameDimension(dto.displayUnit, ingredient.baseUnit)) {
      throw new BadRequestException(
        'La unidad debe ser de la misma dimensión que el insumo (masa, volumen o conteo)',
      );
    }

    const displayUnit = dto.displayUnit ?? ingredient.displayUnit;

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const minStock =
      dto.minStock === undefined
        ? undefined
        : toCanonicalQuantity(dto.minStock, displayUnit);
    const maxStock =
      dto.maxStock === undefined
        ? undefined
        : toCanonicalQuantity(dto.maxStock, displayUnit);
    const unitCost =
      dto.unitCost === undefined
        ? undefined
        : toCanonicalCost(dto.unitCost, displayUnit);

    const data: Prisma.IngredientUncheckedUpdateInput = {};

    if (name !== undefined && name !== ingredient.name) data.name = name;
    if (dto.displayUnit !== undefined && dto.displayUnit !== ingredient.displayUnit) {
      data.displayUnit = dto.displayUnit;
    }
    if (minStock !== undefined && !minStock.equals(ingredient.minStock)) {
      data.minStock = minStock;
    }
    if (maxStock !== undefined && !sameDecimal(maxStock, ingredient.maxStock)) {
      data.maxStock = maxStock;
    }
    if (unitCost !== undefined && !sameDecimal(unitCost, ingredient.unitCost)) {
      data.unitCost = unitCost;
    }
    if (nextCategoryId && nextCategoryId !== ingredient.categoryId) {
      data.categoryId = nextCategoryId;
    }
    if (nextSku && nextSku !== ingredient.sku) data.sku = nextSku;
    // Solo se toca la ubicación si el formulario la envió: así un PATCH parcial
    // no borra la ubicación actual.
    if (
      dto.locationId !== undefined &&
      (dto.locationId || null) !== ingredient.locationId
    ) {
      data.locationId = dto.locationId || null;
    }
    if (dto.isActive !== undefined && dto.isActive !== ingredient.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) {
      return this.withFlags(ingredient);
    }

    const updated = await this.prisma.ingredient.update({
      where: { id: ingredient.id },
      data,
    });

    return this.withFlags(updated);
  }

  async deactivateIngredient(organizationId: string | null, id: string) {
    const ingredient = await this.getIngredient(organizationId, id);

    const inActiveRecipes = await this.prisma.recipeIngredient.count({
      where: { ingredientId: ingredient.id, recipe: { isActive: true } },
    });

    if (inActiveRecipes > 0) {
      throw new ConflictException(
        'El ingrediente forma parte de recetas activas. Quítalo de las recetas antes de desactivarlo',
      );
    }

    await this.prisma.ingredient.update({
      where: { id: ingredient.id },
      data: { isActive: false },
    });

    return { ok: true };
  }

  /**
   * Elimina insumos definitivamente (hard delete).
   *
   * Se borra también su kardex, stock por sucursal, equivalencias, consumo en
   * extras y exclusiones. Para los productos del catálogo core (`coreIds`),
   * las recetas que los usan quedan inactivas. Los productos que no son core
   * siguen bloqueados si están en una receta activa, y nadie se borra si
   * aparece en pedidos.
   */
  async deleteIngredients(
    organizationId: string | null,
    ids: string[],
    coreIds: string[] = [],
  ) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];

    if (uniqueIds.length === 0) {
      throw new BadRequestException('Selecciona al menos un insumo');
    }

    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        id: { in: uniqueIds },
        ...(organizationId ? { organizationId } : {}),
      },
      select: { id: true, name: true },
    });

    if (ingredients.length === 0) {
      throw new NotFoundException('Insumo no encontrado');
    }

    const ingredientIds = ingredients.map((ingredient) => ingredient.id);

    // Los productos del catálogo core no bloquean el borrado por recetas: las
    // recetas que los usan quedan inactivas.
    const coreSet = new Set(
      coreIds.filter((id) => ingredientIds.includes(id)),
    );
    const nonCoreIds = ingredientIds.filter((id) => !coreSet.has(id));

    // Los pedidos históricos («sin cebolla») deben conservarse: si el insumo
    // aparece en uno, se bloquea el borrado y se sugiere desactivarlo.
    const inOrders = await this.prisma.orderItemExclusion.findMany({
      where: { ingredientId: { in: ingredientIds } },
      select: { ingredient: { select: { name: true } } },
      take: 5,
    });

    if (inOrders.length > 0) {
      const names = [...new Set(inOrders.map((row) => row.ingredient.name))];
      throw new ConflictException(
        `No se puede eliminar: ${names.join(', ')} aparece en pedidos. Desactívalo para ocultarlo del inventario`,
      );
    }

    // Los productos que no son core mantienen la regla anterior: no se pueden
    // borrar si están en una receta activa.
    if (nonCoreIds.length > 0) {
      const inActiveRecipes = await this.prisma.recipeIngredient.findMany({
        where: {
          ingredientId: { in: nonCoreIds },
          recipe: { isActive: true },
        },
        select: { ingredient: { select: { name: true } } },
        take: 5,
      });

      if (inActiveRecipes.length > 0) {
        const names = [
          ...new Set(inActiveRecipes.map((row) => row.ingredient.name)),
        ];
        throw new ConflictException(
          `No se puede eliminar: ${names.join(', ')} se usa en recetas activas. Quítalo de las recetas o desactívalo`,
        );
      }
    }

    if (coreSet.size > 0) {
      const recipeRows = await this.prisma.recipeIngredient.findMany({
        where: { ingredientId: { in: [...coreSet] } },
        select: { recipeId: true },
      });

      const recipeIds = [...new Set(recipeRows.map((row) => row.recipeId))];

      if (recipeIds.length > 0) {
        await this.prisma.recipe.updateMany({
          where: { id: { in: recipeIds } },
          data: { isActive: false },
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // La FK de `InventoryMovement` es `SetNull`: el kardex se conserva.
      await tx.ingredient.deleteMany({ where: { id: { in: ingredientIds } } });
    });

    return { ok: true, deletedCount: ingredientIds.length };
  }

  /**
   * Sincroniza el catálogo core con el inventario de la organización.
   *
   * - Crea los productos marcados que aún no existen (sin stock inicial).
   * - Retira los desmarcados que existan. Si están en recetas, esas recetas
   *   quedan inactivas. Si aparecen en pedidos, se conservan.
   */
  async syncCoreItems(
    organizationId: string | null,
    userId: string,
    items: Array<{
      name: string;
      displayUnit: UnitCode;
      category: string;
      location: string;
    }>,
    removeNames: string[],
    removeItems: Array<{
      name: string;
      displayUnit: UnitCode;
      category: string;
      location: string;
    }> = [],
  ) {
    const [categories, locations, ingredients] = await Promise.all([
      this.prisma.ingredientCategory.findMany({
        where: {
          isActive: true,
          OR: [{ organizationId }, { organizationId: null }],
        },
        select: { id: true, name: true },
      }),
      this.prisma.ingredientLocation.findMany({
        where: {
          isActive: true,
          OR: [{ organizationId }, { organizationId: null }],
        },
        select: { id: true, name: true },
      }),
      this.prisma.ingredient.findMany({
        where: { ...(organizationId ? { organizationId } : {}) },
        select: {
          id: true,
          name: true,
          isActive: true,
          displayUnit: true,
          currentStock: true,
          minStock: true,
          maxStock: true,
          unitCost: true,
          category: { select: { name: true } },
          location: { select: { name: true } },
        },
      }),
    ]);

    const categoryIds = new Map(
      categories.map((category) => [category.name.trim().toLowerCase(), category.id]),
    );
    const locationIds = new Map(
      locations.map((location) => [location.name.trim().toLowerCase(), location.id]),
    );
    const existingByKey = new Map(
      ingredients.map((ingredient) => [
        ingredient.name.trim().toLowerCase(),
        ingredient,
      ]),
    );

    const created: string[] = [];
    const removed: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const item of items) {
      const name = item.name.trim();
      const key = name.toLowerCase();

      if (seen.has(key)) continue;
      seen.add(key);

      const existing = existingByKey.get(key);

      if (existing) {
        // Un insumo core desactivado desde Configuración se reactiva al
        // volver a marcarlo.
        if (!existing.isActive) {
          await this.prisma.ingredient.update({
            where: { id: existing.id },
            data: { isActive: true },
          });
          existing.isActive = true;
        }
        continue;
      }

      const categoryId = categoryIds.get(item.category.trim().toLowerCase());
      if (!categoryId) {
        skipped.push({ name, reason: 'categoría no encontrada' });
        continue;
      }

      const locationId = locationIds.get(item.location.trim().toLowerCase());
      if (!locationId) {
        skipped.push({ name, reason: 'ubicación no encontrada' });
        continue;
      }

      try {
        const ingredient = await this.createIngredient(
          organizationId,
          userId,
          {
            name,
            displayUnit: item.displayUnit,
            categoryId,
            locationId,
            currentStock: 0,
            minStock: 0,
          },
          null,
        );

        created.push(name);
      } catch (error) {
        skipped.push({
          name,
          reason:
            error instanceof Error ? error.message : 'no se pudo crear',
        });
      }
    }

    const hasCustomValues = (ingredient: (typeof ingredients)[number]) =>
      (ingredient.unitCost !== null && !ingredient.unitCost.isZero()) ||
      !ingredient.currentStock.isZero() ||
      !ingredient.minStock.isZero() ||
      (ingredient.maxStock !== null && !ingredient.maxStock.isZero());

    const matchesPreset = (
      ingredient: (typeof ingredients)[number],
      preset: { displayUnit: UnitCode; category: string; location: string },
    ) =>
      ingredient.displayUnit === preset.displayUnit &&
      // Una categoría nula puede venir de desactivar todas las categorías:
      // no cuenta como modificación manual.
      (ingredient.category === null ||
        ingredient.category.name === preset.category) &&
      (ingredient.location?.name ?? '') === preset.location;

    type Removal = {
      name: string;
      displayUnit?: UnitCode;
      category?: string;
      location?: string;
    };

    const removals: Removal[] =
      removeItems.length > 0
        ? removeItems
        : removeNames.map((name) => ({ name }));

    for (const item of removals) {
      const name = item.name.trim();
      const key = name.toLowerCase();
      const ingredient = existingByKey.get(key);

      // Solo se desactivan insumos core que sigan activos y sin cambios.
      if (!ingredient || !ingredient.isActive) continue;

      if (hasCustomValues(ingredient)) {
        skipped.push({ name, reason: 'tiene stock o costo modificado' });
        continue;
      }

      if (
        item.displayUnit &&
        !matchesPreset(ingredient, {
          displayUnit: item.displayUnit,
          category: item.category ?? '',
          location: item.location ?? '',
        })
      ) {
        skipped.push({
          name,
          reason: 'tiene unidad, categoría o ubicación modificada',
        });
        continue;
      }

      await this.prisma.ingredient.update({
        where: { id: ingredient.id },
        data: { isActive: false },
      });

      ingredient.isActive = false;
      removed.push(name);
    }

    return { created, removed, skipped };
  }

  /**
   * Activa o desactiva todas las categorías core de inventario.
   *
   * Al desactivarlas se limpia la categoría de los insumos que las usaban para
   * que no queden apuntando a una categoría oculta.
   */
  async setCoreIngredientCategoriesActive(isActive: boolean) {
    const categories = await this.prisma.ingredientCategory.findMany({
      where: { organizationId: null, isCore: true },
      select: { id: true },
    });

    if (categories.length === 0) {
      return { ok: true, updated: 0 };
    }

    const ids = categories.map((category) => category.id);

    return this.prisma.$transaction(async (tx) => {
      if (!isActive) {
        await tx.ingredient.updateMany({
          where: { categoryId: { in: ids } },
          data: { categoryId: null },
        });
      }

      const result = await tx.ingredientCategory.updateMany({
        where: { id: { in: ids } },
        data: { isActive },
      });

      return { ok: true, updated: result.count };
    });
  }

  // --------------------------------------------------------------------------
  // Movimientos
  // --------------------------------------------------------------------------

  async adjust(
    organizationId: string | null,
    userId: string,
    dto: CreateAdjustmentDto,
    branchId: string | null = null,
  ) {
    if (dto.dedupeKey) {
      const existing = await this.prisma.inventoryMovement.findUnique({
        where: { dedupeKey: dto.dedupeKey },
        include: movementInclude,
      });

      if (existing) {
        return this.toDisplayMovement({ ...existing, duplicated: true });
      }
    }

    const ingredient = await this.getIngredient(organizationId, dto.ingredientId);

    if (!ingredient.isActive) {
      throw new BadRequestException('El ingrediente está desactivado');
    }

    const rawQuantity = new Prisma.Decimal(dto.quantity);

    if (rawQuantity.isZero()) {
      throw new BadRequestException('La cantidad debe ser distinta de cero');
    }

    const quantity = await this.quantities.toBaseUnit(
      ingredient,
      rawQuantity,
      dto.unit,
    );

    if (quantity.isZero()) {
      throw new BadRequestException(
        'La cantidad es demasiado pequeña para la unidad del ingrediente',
      );
    }

    try {
      if (!organizationId) {
        throw new BadRequestException(
          'Organization required for inventory movement',
        );
      }

      const movement = await this.prisma.$transaction(async (tx) => {
        const stockAfter = branchId
          ? await this.applyBranchDelta(
              tx,
              organizationId,
              ingredient.id,
              branchId,
              quantity,
            )
          : await this.applyOrganizationDelta(
              tx,
              organizationId,
              ingredient.id,
              quantity,
            );

        return tx.inventoryMovement.create({
          data: {
            organizationId,
            branchId,
            ingredientId: ingredient.id,
            ingredientName: ingredient.name,
            displayUnit: ingredient.displayUnit,
            userId,
            type: InventoryMovementType.ADJUSTMENT,
            quantity,
            stockAfter,
            reason: dto.reason.trim(),
            referenceId: dto.referenceId?.trim() || null,
            referenceType: dto.referenceType?.trim() || 'MANUAL_ADJUSTMENT',
            dedupeKey: dto.dedupeKey?.trim() || null,
          },
          include: movementInclude,
        });
      });

      return this.toDisplayMovement(movement);
    } catch (error) {
      if (
        dto.dedupeKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.inventoryMovement.findUniqueOrThrow({
          where: { dedupeKey: dto.dedupeKey },
          include: movementInclude,
        });

        return this.toDisplayMovement({ ...existing, duplicated: true });
      }

      throw error;
    }
  }

  /**
   * Aplica un delta al stock de una sucursal.
   *
   * El total del ingrediente (`Ingredient.currentStock`) se mueve en paralelo
   * para que los reportes consolidados sigan siendo correctos.
   */
  private async applyBranchDelta(
    tx: Prisma.TransactionClient,
    organizationId: string,
    ingredientId: string,
    branchId: string,
    delta: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const amount = delta.toString();

    // La fila puede no existir todavía (primer movimiento en esa sucursal).
    await tx.$executeRaw`
      INSERT INTO "BranchStock" ("id", "branchId", "ingredientId", "quantity", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${branchId}, ${ingredientId}, 0, NOW(), NOW())
      ON CONFLICT ("branchId", "ingredientId") DO NOTHING
    `;

    const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>`
      UPDATE "BranchStock"
      SET "quantity" = "quantity" + CAST(${amount} AS numeric),
          "updatedAt" = NOW()
      WHERE "branchId" = ${branchId}
        AND "ingredientId" = ${ingredientId}
        AND "quantity" + CAST(${amount} AS numeric) >= 0
      RETURNING "quantity"
    `;

    if (rows.length === 0) {
      throw new BadRequestException('El ajuste dejaría el stock en negativo');
    }

    await tx.$executeRaw`
      UPDATE "Ingredient"
      SET "currentStock" = "currentStock" + CAST(${amount} AS numeric),
          "updatedAt" = NOW()
      WHERE "id" = ${ingredientId}
        AND "organizationId" = ${organizationId}
    `;

    return new Prisma.Decimal(rows[0].quantity);
  }

  /** Aplica un delta al stock consolidado (sin sucursal activa). */
  private async applyOrganizationDelta(
    tx: Prisma.TransactionClient,
    organizationId: string,
    ingredientId: string,
    delta: Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const amount = delta.toString();

    const rows = await tx.$queryRaw<Array<{ currentStock: Prisma.Decimal }>>`
      UPDATE "Ingredient"
      SET "currentStock" = "currentStock" + CAST(${amount} AS numeric),
          "updatedAt" = NOW()
      WHERE "id" = ${ingredientId}
        AND "organizationId" = ${organizationId}
        AND "currentStock" + CAST(${amount} AS numeric) >= 0
      RETURNING "currentStock"
    `;

    if (rows.length === 0) {
      throw new BadRequestException('El ajuste dejaría el stock en negativo');
    }

    return new Prisma.Decimal(rows[0].currentStock);
  }

  async listMovements(
    organizationId: string | null,
    filters: MovementFilters = {},
    branchId: string | null = null,
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        ...(branchId ? { branchId } : {}),
        ...(filters.ingredientId ? { ingredientId: filters.ingredientId } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.from || filters.to
          ? {
              createdAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      include: movementInclude,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return movements.map((movement) => this.toDisplayMovement(movement));
  }

  /** Expresa un movimiento en la unidad visible guardada en el kardex. */
  private toDisplayMovement<
    T extends {
      quantity: Prisma.Decimal;
      stockAfter: Prisma.Decimal | null;
      displayUnit: UnitCode;
    },
  >(movement: T) {
    const displayUnit = movement.displayUnit;

    return {
      ...movement,
      quantity: fromCanonicalQuantity(movement.quantity, displayUnit),
      stockAfter:
        movement.stockAfter === null
          ? null
          : fromCanonicalQuantity(movement.stockAfter, displayUnit),
    };
  }

  async listAlerts(
    organizationId: string | null,
    branchId: string | null = null,
  ) {
    // Return low stock ingredients sorted by deficit descending
    const low = await this.listIngredients(
      organizationId,
      { lowStockOnly: true },
      branchId,
    );
    // Sort descending by deficit (largest deficit first)
    return low.sort((a, b) => {
      if (a.deficit.gt(b.deficit)) return -1;
      if (a.deficit.lt(b.deficit)) return 1;
      return 0;
    });
  }



  async ensureCoreDefaults() {
    // Core categories that are shared across all organizations (organizationId = null)
    const coreCategories = [
      { name: 'Frutas y verduras', description: 'Productos frescos de origen vegetal', sortOrder: 1 },
      { name: 'Carnes, aves y pescados', description: 'Carnes rojas, aves, pescados y mariscos', sortOrder: 2 },
      { name: 'Lácteos y refrigerados', description: 'Leche, quesos, yogures, huevos y productos refrigerados', sortOrder: 3 },
      { name: 'Congelados', description: 'Productos congelados listos para usar', sortOrder: 4 },
      { name: 'Abarrotes y productos secos', description: 'Alimentos no perecederos, granos y harinas', sortOrder: 5 },
      { name: 'Aceites, salsas y condimentos', description: 'Aceites, vinagres, salsas, especias y adobos', sortOrder: 6 },
      { name: 'Panadería y tortillería', description: 'Pan, tortillas, masas y productos de panadería', sortOrder: 7 },
      { name: 'Café, té y bebidas', description: 'Café, té, cacao, jugos, refrescos y bases para bebidas', sortOrder: 8 },
      { name: 'Enlatados, conservas y encurtidos', description: 'Latas, conservas y encurtidos', sortOrder: 9 },
      { name: 'Repostería y decoración', description: 'Insumos de repostería, coberturas y decoración', sortOrder: 10 },
      { name: 'Desechables y empaques', description: 'Vasos, cubiertos, servilletas, bolsas y film', sortOrder: 11 },
      { name: 'Limpieza e higiene', description: 'Detergentes, desinfectantes, jabones y papel', sortOrder: 12 },
      { name: 'Artículos de operación', description: 'Utensilios, equipo menor y artículos de operación', sortOrder: 13 },
      { name: 'Bebidas alcohólicas y coctelería', description: 'Licores, cervezas, vinos y mezcladores', sortOrder: 14 },
    ];

    // Core locations shared globally (organizationId = null)
    const coreLocations = [
      { name: 'Almacén seco', description: 'Zona de almacenamiento a temperatura ambiente', sortOrder: 1 },
      { name: 'Refrigerador', description: 'Cámara fría / refrigerador principal (2-8°C)', sortOrder: 2 },
      { name: 'Congelador', description: 'Congelador / freezer (-18°C o menos)', sortOrder: 3 },
      { name: 'Cocina / Área de preparación', description: 'Zona de trabajo y mise en place', sortOrder: 4 },
      { name: 'Barra de bebidas', description: 'Área de servicio de bebidas y café', sortOrder: 5 },
      { name: 'Almacén de desechables', description: 'Stock de vasos, cubiertos, servilletas, empaques', sortOrder: 6 },
      { name: 'Área de limpieza', description: 'Productos de limpieza e higiene', sortOrder: 7 },
      { name: 'Bodega auxiliar', description: 'Almacén secundario / overflow', sortOrder: 8 },
    ];

    // Insert or refresh core categories. Se busca por nombre porque el índice
    // único `(organizationId, name)` no detecta duplicados con `NULL`.
    for (const cat of coreCategories) {
      const existing = await this.prisma.ingredientCategory.findFirst({
        where: { organizationId: null, name: cat.name },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.ingredientCategory.update({
          where: { id: existing.id },
          data: { ...cat, isCore: true, isActive: true },
        });
      } else {
        try {
          await this.prisma.ingredientCategory.create({
            data: { organizationId: null, ...cat, isCore: true, isActive: true },
          });
        } catch (e) {
          // Otra petición simultánea pudo crearla: el índice parcial global
          // impide duplicados y aquí se ignora la carrera.
          if (
            !(
              e instanceof Prisma.PrismaClientKnownRequestError &&
              e.code === 'P2002'
            )
          ) {
            throw e;
          }
        }
      }
    }

    // Insert core locations
    for (const loc of coreLocations) {
      try {
        await this.prisma.ingredientLocation.create({
          data: { organizationId: null as any, ...loc, isCore: true, isActive: true },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // duplicate, ignore
        } else {
          throw e;
        }
      }
    }

    // Categorías core de artículos y recetas (globales y no editables).
    for (const category of CORE_CATEGORIES) {
      const existing = await this.prisma.category.findUnique({
        where: {
          kind_code: { kind: category.kind, code: category.code },
        },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.category.update({
          where: { id: existing.id },
          data: {
            organizationId: null,
            name: category.name,
            description: category.description,
            kind: category.kind,
            sortOrder: category.sortOrder,
            isCore: true,
            isActive: true,
          },
        });
      } else {
        await this.prisma.category.create({
          data: {
            organizationId: null,
            code: category.code,
            name: category.name,
            description: category.description,
            kind: category.kind,
            sortOrder: category.sortOrder,
            isCore: true,
            isActive: true,
          },
        });
      }
    }
  }

  async listIngredientCategories(
    organizationId: string | null,
    includeInactive = false,
  ) {
    return this.prisma.ingredientCategory.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        OR: [
          { organizationId },
          { organizationId: null },
        ],
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        isCore: true,
        isActive: true,
        sortOrder: true,
      },
    });
  }

  async listIngredientLocations(organizationId: string | null) {
    return this.prisma.ingredientLocation.findMany({
      where: { isActive: true,
        OR: [
          { organizationId },
          { organizationId: null },
        ],
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        isCore: true,
        isActive: true,
        sortOrder: true,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Equivalencias entre dimensiones
  // --------------------------------------------------------------------------

  async listEquivalences(organizationId: string | null, ingredientId: string) {
    const ingredient = await this.getIngredient(organizationId, ingredientId);

    const equivalences = await this.prisma.ingredientEquivalence.findMany({
      where: { ingredientId: ingredient.id },
      orderBy: { createdAt: 'asc' },
    });

    // Se guardan contra la unidad canónica; la UI las ve contra la visible.
    const displayFactor = canonicalFactor(ingredient.displayUnit);

    return equivalences.map((equivalence) => {
      if (equivalence.toUnit === ingredient.baseUnit) {
        return {
          ...equivalence,
          toUnit: ingredient.displayUnit,
          factor: equivalence.factor
            .dividedBy(displayFactor)
            .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP),
        };
      }

      if (equivalence.fromUnit === ingredient.baseUnit) {
        return {
          ...equivalence,
          fromUnit: ingredient.displayUnit,
          factor: equivalence.factor
            .times(displayFactor)
            .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP),
        };
      }

      return equivalence;
    });
  }

  async createEquivalence(
    organizationId: string | null,
    ingredientId: string,
    dto: CreateEquivalenceDto,
  ) {
    const ingredient = await this.getIngredient(organizationId, ingredientId);

    if (dto.fromUnit === dto.toUnit) {
      throw new BadRequestException('Las unidades deben ser distintas');
    }

    const source = unitDefinition(dto.fromUnit);
    const target = unitDefinition(dto.toUnit);

    if (source.dimension === target.dimension) {
      throw new BadRequestException(
        `La conversión ${source.label} → ${target.label} ya es fija y no requiere equivalencia`,
      );
    }

    // Se normaliza a unidades canónicas: 1 fromCanonical = factor' toCanonical.
    const fromUnit = canonicalUnit(dto.fromUnit);
    const toUnit = canonicalUnit(dto.toUnit);
    const factor = new Prisma.Decimal(dto.factor)
      .times(canonicalFactor(dto.fromUnit))
      .dividedBy(canonicalFactor(dto.toUnit))
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);

    try {
      return await this.prisma.ingredientEquivalence.create({
        data: {
          ingredientId: ingredient.id,
          fromUnit,
          toUnit,
          factor,
          note: dto.note?.trim() || null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe una equivalencia para ese par de unidades',
        );
      }
      throw error;
    }
  }

  async deleteEquivalence(
    organizationId: string | null,
    ingredientId: string,
    equivalenceId: string,
  ) {
    const ingredient = await this.getIngredient(organizationId, ingredientId);

    const { count } = await this.prisma.ingredientEquivalence.deleteMany({
      where: { id: equivalenceId, ingredientId: ingredient.id },
    });

    if (count === 0) {
      throw new NotFoundException('Equivalencia no encontrada');
    }

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async getIngredient(organizationId: string | null, id: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, ...(organizationId ? { organizationId } : {}) },
    });

    if (!ingredient) {
      throw new NotFoundException('Ingrediente no encontrado');
    }

    return ingredient;
  }

  /**
   * Valida que la categoría exista (core o de la organización) y esté activa.
   * Es obligatoria porque de su nombre se deriva el SKU.
   */
  private async resolveCategory(
    organizationId: string | null,
    categoryId: string,
  ) {
    const category = await this.prisma.ingredientCategory.findFirst({
      where: {
        id: categoryId,
        isActive: true,
        OR: [{ organizationId }, { organizationId: null }],
      },
      select: { id: true, name: true },
    });

    if (!category) {
      throw new BadRequestException(
        'Selecciona una categoría válida para el ingrediente',
      );
    }

    return category;
  }

  /**
   * Prefijo de 3 letras para el SKU a partir del nombre de la categoría.
   *
   * Usa la inicial de las tres primeras palabras significativas (omite
   * artículos y preposiciones). Si hay menos palabras, completa con las
   * siguientes letras de la última.
   *
   * Ej.: "Frutas y verduras" → FVE · "Artículos de operación" → AOP
   */
  private categoryPrefix(name: string): string {
    return categoryInitials(name, 3);
  }

  /**
   * Genera el siguiente SKU de la categoría: `PREFIX###` desde 100.
   *
   * El consecutivo es por organización y prefijo; se calcula a partir del
   * mayor número ya usado para no reutilizar códigos aunque se borren filas.
   */
  private async generateSku(
    organizationId: string | null,
    categoryName: string,
  ): Promise<string> {
    const prefix = this.categoryPrefix(categoryName);
    const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');

    const existing = await this.prisma.ingredient.findMany({
      where: {
        organizationId,
        sku: { startsWith: prefix, mode: 'insensitive' },
      },
      select: { sku: true },
    });

    let max = 99;

    for (const row of existing) {
      const match = row.sku?.match(pattern);
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }

    let next = max + 1;
    let sku = `${prefix}${next}`;

    // Salvaguarda ante carreras o SKUs manuales heredados.
    while (await this.skuExists(organizationId, sku)) {
      next += 1;
      sku = `${prefix}${next}`;
    }

    return sku;
  }

  private async skuExists(organizationId: string | null, sku: string) {
    const existing = await this.prisma.ingredient.findFirst({
      where: { organizationId, sku: { equals: sku, mode: 'insensitive' } },
      select: { id: true },
    });

    return Boolean(existing);
  }

  private async assertNameAvailable(
    organizationId: string | null,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.ingredient.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ya existe un ingrediente con ese nombre');
    }
  }

  private withFlags<T extends { currentStock: Prisma.Decimal; minStock: Prisma.Decimal }>(
    ingredient: T,
  ) {
    return {
      ...ingredient,
      isLowStock: ingredient.currentStock.lte(ingredient.minStock),
      deficit: ingredient.currentStock.lt(ingredient.minStock)
        ? ingredient.minStock.minus(ingredient.currentStock)
        : new Prisma.Decimal(0),
    };
  }
}

/**
 * Divide una línea CSV respetando comillas dobles.
 *
 * Necesario porque nombres de categoría como "Aceites, salsas y condimentos"
 * contienen comas que no deben separar columnas.
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());

  return values;
}
