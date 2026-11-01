import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, CategoryKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import { fromCanonicalQuantity, toMoney } from '../common/units';
import { alphabetSuffix, categoryInitials } from '../common/sku';
import {
  deleteR2Object,
  imageSnapshotName,
  itemImageFolder,
  maxUploadBytes,
  objectSize,
  publicUrlForKey,
} from '../uploads/r2';
import {
  ComboComponentInputDto,
  CreateExtraDto,
  CreateItemDto,
  CreateVariantDto,
  ExclusionInputDto,
  ExtraIngredientInputDto,
  UpdateExtraDto,
  UpdateItemDto,
  UpdateVariantDto,
} from './dto/item.dto';

const itemListInclude = {
  category: { select: { id: true, name: true } },
  variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
  extras: { orderBy: { name: 'asc' } },
  // El POS necesita saber qué ingredientes se pueden quitar al tomar la comanda.
  ingredientExclusions: {
    include: {
      ingredient: {
        select: { id: true, name: true, baseUnit: true, displayUnit: true },
      },
    },
  },
  _count: { select: { recipes: true } },
  recipes: {
    select: { id: true, name: true, variantId: true, isActive: true },
    orderBy: { variantId: 'asc' },
  },
} satisfies Prisma.ItemInclude;

const itemDetailInclude = {
  category: { select: { id: true, name: true } },
  variants: {
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { recipes: true } } },
  },
  extras: {
    orderBy: { name: 'asc' },
    include: {
      ingredients: {
        include: {
          ingredient: {
            select: {
              id: true,
              name: true,
              baseUnit: true,
              displayUnit: true,
              currentStock: true,
            },
          },
        },
      },
    },
  },
  ingredientExclusions: {
    include: {
      ingredient: {
        select: { id: true, name: true, baseUnit: true, displayUnit: true },
      },
    },
  },
  comboComponents: {
    include: {
      componentItem: {
        select: { id: true, name: true, price: true, isActive: true },
      },
      variant: { select: { id: true, name: true } },
    },
  },
  recipes: {
    orderBy: { variantId: 'asc' },
    include: {
      variant: { select: { id: true, name: true } },
      ingredients: {
        include: {
          ingredient: {
            select: { id: true, name: true, baseUnit: true, displayUnit: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ItemInclude;

export interface ItemFilters {
  search?: string;
  categoryId?: string;
  includeInactive?: boolean;
  onlyCombos?: boolean;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingredientQuantities: IngredientQuantitiesService,
  ) {}

  list(organizationId: string | null, filters: ItemFilters = {}) {
    const search = filters.search?.trim();

    return this.prisma.item.findMany({
      where: {
        organizationId,
        ...(filters.includeInactive ? {} : { isActive: true }),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.onlyCombos ? { isCombo: true } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { sku: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: itemListInclude,
      orderBy: [
        { category: { sortOrder: 'asc' } },
        { sortOrder: 'asc' },
        { name: 'asc' },
      ],
    });
  }

  async findOne(organizationId: string | null, id: string) {
    const item = await this.prisma.item.findFirst({
      where: { id, organizationId },
      include: itemDetailInclude,
    });

    if (!item) {
      throw new NotFoundException('Artículo no encontrado');
    }

    return this.withDisplayUnits(item);
  }

  /**
   * Las cantidades de recetas y extras se guardan en la unidad canónica del
   * ingrediente; la UI las recibe en su unidad visible.
   */
  private withDisplayUnits(
    item: Prisma.ItemGetPayload<{ include: typeof itemDetailInclude }>,
  ) {
    return {
      ...item,
      extras: (item.extras ?? []).map((extra) => ({
        ...extra,
        ingredients: (extra.ingredients ?? []).map((item) => ({
          ...item,
          quantity: fromCanonicalQuantity(
            item.quantity,
            item.ingredient.displayUnit,
          ),
          ingredient: {
            ...item.ingredient,
            currentStock: fromCanonicalQuantity(
              item.ingredient.currentStock,
              item.ingredient.displayUnit,
            ),
          },
        })),
      })),
      recipes: (item.recipes ?? []).map((recipe) => ({
        ...recipe,
        ingredients: (recipe.ingredients ?? []).map((item) => ({
          ...item,
          quantity: fromCanonicalQuantity(
            item.quantity,
            item.ingredient.displayUnit,
          ),
        })),
      })),
    };
  }

  async create(organizationId: string | null, dto: CreateItemDto) {
    const name = dto.name.trim();

    const category = dto.categoryId
      ? await this.assertCategory(organizationId, dto.categoryId)
      : null;

    // El SKU es automático: `X` + iniciales de la categoría + consecutivo.
    const providedSku = normalizeSku(dto.sku);
    if (providedSku) {
      await this.assertSkuAvailable(organizationId, providedSku);
    }

    const sku =
      providedSku ??
      (await this.generateArticleSku(organizationId, category?.name ?? null));

    const variants = dto.variants ?? [];
    const primaryIndex = variants.findIndex((variant) => variant.isPrimary);
    const primary = primaryIndex >= 0 ? primaryIndex : 0;

    const isCombo = dto.isCombo ?? false;
    const comboComponents = dto.comboComponents ?? [];

    if (isCombo && comboComponents.length === 0) {
      throw new BadRequestException(
        'Un combo debe tener al menos un componente',
      );
    }

    if (!isCombo && comboComponents.length > 0) {
      throw new BadRequestException(
        'Solo los artículos marcados como combo pueden tener componentes',
      );
    }

    const components = isCombo
      ? await this.validateComboComponents(organizationId, null, comboComponents)
      : [];

    const exclusions = await this.validateExclusions(
      organizationId,
      dto.exclusions ?? [],
    );

    const extras = await Promise.all(
      (dto.extras ?? []).map(async (extra) => ({
        name: extra.name.trim(),
        price: toMoney(extra.price),
        isActive: extra.isActive ?? true,
        ingredients: await this.resolveExtraIngredients(
          organizationId,
          extra.ingredients ?? [],
        ),
      })),
    );

    const item = await this.prisma.item.create({
      data: {
        organizationId,
        categoryId: dto.categoryId ?? null,
        name,
        description: normalizeOptional(dto.description),
        sku,
        price: toMoney(dto.price),
        taxRate:
          dto.taxRate === undefined || dto.taxRate === null
            ? null
            : new Prisma.Decimal(dto.taxRate),
        isCombo,
        sortOrder: dto.sortOrder ?? 0,
        variants: {
          create: variants.map((variant, index) => ({
            name: variant.name.trim(),
            sku: `${sku}${alphabetSuffix(index)}`,
            isPrimary: index === primary,
            priceAdjust: toMoney(variant.priceAdjust ?? 0),
            recipeFactor: new Prisma.Decimal(variant.recipeFactor ?? 1),
            sortOrder: variant.sortOrder ?? index,
            isActive: variant.isActive ?? true,
          })),
        },
        extras: {
          create: extras.map((extra) => ({
            name: extra.name,
            price: extra.price,
            isActive: extra.isActive,
            ingredients: {
              create: extra.ingredients.map((ingredient) => ({
                quantity: ingredient.quantity,
                ingredient: { connect: { id: ingredient.ingredientId } },
              })),
            },
          })),
        },
        ingredientExclusions: {
          create: exclusions.map((exclusion) => ({
            label: exclusion.label,
            ingredient: { connect: { id: exclusion.ingredientId } },
          })),
        },
        comboComponents: {
          create: components.map((component) => ({
            quantity: component.quantity,
            componentItem: { connect: { id: component.componentItemId } },
            ...(component.componentVariantId
              ? { variant: { connect: { id: component.componentVariantId } } }
              : {}),
          })),
        },
      },
    });

    return this.findOne(organizationId, item.id);
  }

  async update(organizationId: string | null, id: string, dto: UpdateItemDto) {
    const item = await this.getItem(organizationId, id);

    const category = dto.categoryId
      ? await this.assertCategory(organizationId, dto.categoryId)
      : null;

    const categoryChanged =
      dto.categoryId !== undefined &&
      (dto.categoryId ?? null) !== item.categoryId;

    let sku = dto.sku === undefined ? undefined : normalizeSku(dto.sku);

    if (sku) {
      await this.assertSkuAvailable(organizationId, sku, item.id);
    }

    // Cambiar de categoría (o estrenar el SKU) regenera el código y sus sufijos.
    if (!sku && (categoryChanged || !item.sku)) {
      sku = await this.generateArticleSku(
        organizationId,
        category?.name ?? null,
        item.id,
      );
    }

    const imageKey = dto.imageKey;

    if (dto.isCombo === false && item.isCombo) {
      await this.prisma.comboComponent.deleteMany({
        where: { comboId: item.id },
      });
    }

    if (dto.isCombo === true && !item.isCombo) {
      const usedAsComponent = await this.prisma.comboComponent.count({
        where: {
          componentItemId: item.id,
          combo: { isActive: true },
        },
      });

      if (usedAsComponent > 0) {
        throw new ConflictException(
          'El artículo es componente de un combo activo. No puede convertirse en combo',
        );
      }
    }

    await this.prisma.item.update({
      where: { id: item.id },
      data: {
        name: dto.name?.trim(),
        description:
          dto.description === undefined
            ? undefined
            : normalizeOptional(dto.description),
        sku: dto.sku === undefined ? sku : normalizeSku(dto.sku),
        categoryId: dto.categoryId,
        price: dto.price === undefined ? undefined : toMoney(dto.price),
        taxRate:
          dto.taxRate === undefined
            ? undefined
            : dto.taxRate === null
              ? null
              : new Prisma.Decimal(dto.taxRate),
        isCombo: dto.isCombo,
        isActive: dto.isActive,
        sortOrder: dto.sortOrder,
      },
    });

    if (imageKey !== undefined) {
      // Guarda la imagen en la carpeta del artículo y borra la anterior para
      // que solo quede una por artículo.
      await this.applyItemImage(
        organizationId,
        item.id,
        dto.name?.trim() || item.name,
        imageKey,
        item.imageKey,
      );
    }

    if (dto.variants !== undefined) {
      await this.syncVariants(item.id, dto.variants, sku ?? item.sku);
    } else if (sku && sku !== item.sku) {
      // La base cambió sin tocar presentaciones: solo se renumeran los sufijos.
      await this.renumberVariantSkus(item.id, sku);
    }

    return this.findOne(organizationId, item.id);
  }

  /**
   * Sincroniza presentaciones por nombre: actualiza las existentes, crea las
   * nuevas y desactiva las que ya no vienen (nunca las borra, para conservar
   * pedidos históricos).
   */
  private async syncVariants(
    itemId: string,
    variants: CreateVariantDto[],
    baseSku: string | null,
  ) {
    const existing = await this.prisma.itemVariant.findMany({
      where: { itemId },
    });
    const incoming = new Set(
      variants.map((variant) => variant.name.trim().toLowerCase()),
    );
    const primaryIndex = await this.resolvePrimaryIndex(itemId, variants);

    for (const [index, variant] of variants.entries()) {
      const name = variant.name.trim();
      const match = existing.find(
        (candidate) => candidate.name.trim().toLowerCase() === name.toLowerCase(),
      );
      const sku = baseSku ? `${baseSku}${alphabetSuffix(index)}` : undefined;

      if (match) {
        await this.prisma.itemVariant.update({
          where: { id: match.id },
          data: {
            name,
            sku,
            isPrimary: index === primaryIndex,
            priceAdjust: toMoney(variant.priceAdjust ?? 0),
            // Sin factor en el DTO se conserva el actual (recetas publicadas).
            recipeFactor:
              variant.recipeFactor === undefined
                ? undefined
                : new Prisma.Decimal(variant.recipeFactor),
            sortOrder: variant.sortOrder ?? index,
            isActive: variant.isActive ?? true,
          },
        });
      } else {
        await this.prisma.itemVariant.create({
          data: {
            itemId,
            name,
            sku,
            isPrimary: index === primaryIndex,
            priceAdjust: toMoney(variant.priceAdjust ?? 0),
            recipeFactor: new Prisma.Decimal(variant.recipeFactor ?? 1),
            sortOrder: variant.sortOrder ?? index,
            isActive: variant.isActive ?? true,
          },
        });
      }
    }

    for (const variant of existing) {
      if (
        variant.isActive &&
        !incoming.has(variant.name.trim().toLowerCase())
      ) {
        await this.prisma.itemVariant.update({
          where: { id: variant.id },
          data: { isActive: false, isPrimary: false },
        });
      }
    }
  }

  /**
   * Índice de la presentación principal.
   *
   * Si el DTO no marca ninguna se conserva la que ya lo era (para no robarle
   * la primacía a los clientes que no envían el campo); si no hay, la primera.
   */
  private async resolvePrimaryIndex(
    itemId: string,
    variants: CreateVariantDto[],
  ): Promise<number> {
    const explicit = variants.findIndex((variant) => variant.isPrimary);

    if (explicit >= 0) return explicit;

    const current = await this.prisma.itemVariant.findFirst({
      where: { itemId, isPrimary: true },
      select: { name: true },
    });

    if (current) {
      const index = variants.findIndex(
        (variant) =>
          variant.name.trim().toLowerCase() ===
          current.name.trim().toLowerCase(),
      );

      if (index >= 0) return index;
    }

    return 0;
  }

  /** Renumera los sufijos de SKU cuando cambia la base sin tocar presentaciones. */
  private async renumberVariantSkus(itemId: string, baseSku: string) {
    const variants = await this.prisma.itemVariant.findMany({
      where: { itemId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    for (const [index, variant] of variants.entries()) {
      await this.prisma.itemVariant.update({
        where: { id: variant.id },
        data: { sku: `${baseSku}${alphabetSuffix(index)}` },
      });
    }
  }

  /**
   * Guarda la imagen del artículo y borra la anterior.
   *
   * La subida ya fue directa a `{org}/catalog/{itemId}/{hash}.{ext}`, así que
   * aquí solo se valida la clave, se comprueba el tamaño real y se elimina el
   * objeto anterior: solo queda una imagen por artículo en el bucket.
   */
  private async applyItemImage(
    organizationId: string | null,
    itemId: string,
    name: string,
    imageKey: string | null,
    previousKey: string | null,
  ) {
    if (imageKey === previousKey) return;

    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona una organización antes de guardar imágenes',
      );
    }

    if (imageKey === null) {
      await this.prisma.item.update({
        where: { id: itemId },
        data: { imageKey: null, imageUrl: null, imageName: null },
      });

      // La base ya no apunta a la imagen: el objeto puede borrarse.
      if (previousKey) await deleteR2Object(previousKey);
      return;
    }

    const folder = itemImageFolder(organizationId, itemId);

    if (!imageKey.startsWith(`${folder}/`)) {
      throw new BadRequestException('La imagen no pertenece a este artículo');
    }

    // R2 no permite fijar el tamaño en la firma del PUT: se comprueba aquí.
    const size = await objectSize(imageKey);
    const maxBytes = maxUploadBytes();

    if (size !== null && size > maxBytes) {
      await deleteR2Object(imageKey);
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    await this.prisma.item.update({
      where: { id: itemId },
      data: {
        imageKey,
        imageUrl: publicUrlForKey(imageKey),
        // Nombre legible en la base; en R2 el objeto va hasheado.
        imageName: imageSnapshotName(name),
      },
    });

    // Solo una imagen por artículo: la anterior deja de existir en el bucket.
    if (previousKey) await deleteR2Object(previousKey);
  }

  /** Prefijo del SKU: `X` + dos letras de la categoría (XVA, XBE…). */
  private articleSkuPrefix(categoryName: string | null): string {
    return `X${categoryInitials(categoryName ?? 'General', 2)}`;
  }

  /**
   * Siguiente SKU del artículo: `XVA100`, `XVA101`…
   *
   * El consecutivo es por organización y prefijo, y arranca en 100. Se calcula
   * con el mayor número ya usado para no reutilizar códigos.
   */
  private async generateArticleSku(
    organizationId: string | null,
    categoryName: string | null,
    excludeId?: string,
  ): Promise<string> {
    const prefix = this.articleSkuPrefix(categoryName);
    const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');

    const existing = await this.prisma.item.findMany({
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

    while (await this.itemSkuExists(organizationId, sku, excludeId)) {
      next += 1;
      sku = `${prefix}${next}`;
    }

    return sku;
  }

  private async itemSkuExists(
    organizationId: string | null,
    sku: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.item.findFirst({
      where: {
        organizationId,
        sku: { equals: sku, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    return Boolean(existing);
  }

  async deactivate(organizationId: string | null, id: string) {
    const item = await this.getItem(organizationId, id);

    const usedInCombos = await this.prisma.comboComponent.count({
      where: {
        componentItemId: item.id,
        combo: { isActive: true },
      },
    });

    if (usedInCombos > 0) {
      throw new ConflictException(
        'El artículo es componente de un combo activo. Quítalo del combo antes de desactivarlo',
      );
    }

    await this.prisma.item.update({
      where: { id: item.id },
      data: { isActive: false },
    });

    return { ok: true };
  }

  /**
   * Elimina artículos de forma permanente.
   *
   * Los pedidos históricos guardan una copia del artículo, pero la relación
   * sigue apuntando a él: si aparece en pedidos se bloquea el borrado y se
   * sugiere desactivarlo (igual que en inventario). Las recetas, variantes,
   * extras y exclusiones del artículo se eliminan en cascada.
   */
  async deleteItems(organizationId: string | null, ids: string[]) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];

    if (uniqueIds.length === 0) {
      throw new BadRequestException('Selecciona al menos un artículo');
    }

    const items = await this.prisma.item.findMany({
      where: { id: { in: uniqueIds }, organizationId },
      select: { id: true, name: true, imageKey: true },
    });

    if (items.length === 0) {
      throw new NotFoundException('Artículo no encontrado');
    }

    const itemIds = items.map((item) => item.id);

    const inOrders = await this.prisma.orderItem.findMany({
      where: { itemId: { in: itemIds } },
      select: { item: { select: { name: true } } },
      take: 5,
    });

    if (inOrders.length > 0) {
      const names = [...new Set(inOrders.map((row) => row.item.name))];
      throw new ConflictException(
        `No se puede eliminar: ${names.join(', ')} aparece en pedidos. Desactívalo para ocultarlo de los menús`,
      );
    }

    // Los combos activos no pueden quedarse sin uno de sus componentes.
    const usedInCombos = await this.prisma.comboComponent.findMany({
      where: {
        componentItemId: { in: itemIds },
        combo: { isActive: true },
      },
      select: { componentItem: { select: { name: true } } },
      take: 5,
    });

    if (usedInCombos.length > 0) {
      const names = [
        ...new Set(usedInCombos.map((row) => row.componentItem.name)),
      ];
      throw new ConflictException(
        `No se puede eliminar: ${names.join(', ')} es componente de un combo activo. Quítalo del combo o desactívalo`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Los componentes que apuntan a estos artículos se quitan primero: la
      // relación es Restrict y bloquearía el borrado aunque el combo esté
      // inactivo.
      await tx.comboComponent.deleteMany({
        where: { componentItemId: { in: itemIds } },
      });
      await tx.item.deleteMany({ where: { id: { in: itemIds } } });
    });

    // La base ya no referencia las imágenes: se limpian del bucket.
    await Promise.all(
      items
        .filter((item) => item.imageKey)
        .map((item) =>
          deleteR2Object(item.imageKey as string).catch(() => undefined),
        ),
    );

    return { ok: true, deletedCount: items.length };
  }

  // --------------------------------------------------------------------------
  // Variantes
  // --------------------------------------------------------------------------

  async createVariant(
    organizationId: string | null,
    itemId: string,
    dto: CreateVariantDto,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const name = dto.name.trim();
    await this.assertVariantNameAvailable(item.id, name);

    const variant = await this.prisma.itemVariant.create({
      data: {
        itemId: item.id,
        name,
        priceAdjust: toMoney(dto.priceAdjust ?? 0),
        recipeFactor: new Prisma.Decimal(dto.recipeFactor ?? 1),
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });

    return this.findOne(organizationId, item.id).then((detail) => ({
      item: detail,
      variant,
    }));
  }

  async updateVariant(
    organizationId: string | null,
    itemId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const variant = await this.getVariant(item.id, variantId);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== variant.name) {
        await this.assertVariantNameAvailable(item.id, name, variant.id);
      }
    }

    const updated = await this.prisma.itemVariant.update({
      where: { id: variant.id },
      data: {
        name: dto.name?.trim(),
        priceAdjust:
          dto.priceAdjust === undefined
            ? undefined
            : toMoney(dto.priceAdjust),
        recipeFactor:
          dto.recipeFactor === undefined
            ? undefined
            : new Prisma.Decimal(dto.recipeFactor),
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });

    return this.findOne(organizationId, item.id).then((detail) => ({
      item: detail,
      variant: updated,
    }));
  }

  async deactivateVariant(
    organizationId: string | null,
    itemId: string,
    variantId: string,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const variant = await this.getVariant(item.id, variantId);

    const usedInCombos = await this.prisma.comboComponent.count({
      where: {
        componentVariantId: variant.id,
        combo: { isActive: true },
      },
    });

    if (usedInCombos > 0) {
      throw new ConflictException(
        'La variante es componente de un combo activo. Quítala del combo antes de desactivarla',
      );
    }

    await this.prisma.itemVariant.update({
      where: { id: variant.id },
      data: { isActive: false },
    });

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Extras
  // --------------------------------------------------------------------------

  async createExtra(
    organizationId: string | null,
    itemId: string,
    dto: CreateExtraDto,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const ingredients = await this.resolveExtraIngredients(
      organizationId,
      dto.ingredients ?? [],
    );

    const extra = await this.prisma.itemExtra.create({
      data: {
        itemId: item.id,
        name: dto.name.trim(),
        price: toMoney(dto.price),
        isActive: dto.isActive ?? true,
        ingredients: {
          create: ingredients.map((ingredient) => ({
            quantity: ingredient.quantity,
            ingredient: { connect: { id: ingredient.ingredientId } },
          })),
        },
      },
    });

    return this.findOne(organizationId, item.id).then((detail) => ({
      item: detail,
      extra,
    }));
  }

  async updateExtra(
    organizationId: string | null,
    itemId: string,
    extraId: string,
    dto: UpdateExtraDto,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const extra = await this.prisma.itemExtra.findFirst({
      where: { id: extraId, itemId: item.id },
    });

    if (!extra) {
      throw new NotFoundException('Extra no encontrado');
    }

    const ingredients =
      dto.ingredients === undefined
        ? undefined
        : await this.resolveExtraIngredients(organizationId, dto.ingredients);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (ingredients) {
        await tx.itemExtraIngredient.deleteMany({
          where: { itemExtraId: extra.id },
        });
      }

      return tx.itemExtra.update({
        where: { id: extra.id },
        data: {
          name: dto.name?.trim(),
          price: dto.price === undefined ? undefined : toMoney(dto.price),
          isActive: dto.isActive,
          ...(ingredients
            ? {
                ingredients: {
                  create: ingredients.map((ingredient) => ({
                    quantity: ingredient.quantity,
                    ingredient: { connect: { id: ingredient.ingredientId } },
                  })),
                },
              }
            : {}),
        },
      });
    });

    return this.findOne(organizationId, item.id).then((detail) => ({
      item: detail,
      extra: updated,
    }));
  }

  async deactivateExtra(
    organizationId: string | null,
    itemId: string,
    extraId: string,
  ) {
    const item = await this.getItem(organizationId, itemId);
    const extra = await this.prisma.itemExtra.findFirst({
      where: { id: extraId, itemId: item.id },
    });

    if (!extra) {
      throw new NotFoundException('Extra no encontrado');
    }

    await this.prisma.itemExtra.update({
      where: { id: extra.id },
      data: { isActive: false },
    });

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Exclusiones y combos (reemplazo completo)
  // --------------------------------------------------------------------------

  async replaceExclusions(
    organizationId: string | null,
    itemId: string,
    exclusions: ExclusionInputDto[],
  ) {
    const item = await this.getItem(organizationId, itemId);
    const normalized = await this.validateExclusions(
      organizationId,
      exclusions,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.itemIngredientExclusion.deleteMany({
        where: { itemId: item.id },
      });

      if (normalized.length > 0) {
        await tx.itemIngredientExclusion.createMany({
          data: normalized.map((exclusion) => ({
            itemId: item.id,
            ingredientId: exclusion.ingredientId,
            label: exclusion.label,
          })),
        });
      }
    });

    return this.findOne(organizationId, item.id);
  }

  async replaceComboComponents(
    organizationId: string | null,
    itemId: string,
    components: ComboComponentInputDto[],
  ) {
    const item = await this.getItem(organizationId, itemId);

    if (!item.isCombo) {
      throw new BadRequestException(
        'Marca el artículo como combo antes de configurar sus componentes',
      );
    }

    if (components.length === 0) {
      throw new BadRequestException(
        'El combo debe tener al menos un componente',
      );
    }

    const normalized = await this.validateComboComponents(
      organizationId,
      item.id,
      components,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.comboComponent.deleteMany({ where: { comboId: item.id } });
      await tx.comboComponent.createMany({
        data: normalized.map((component) => ({
          comboId: item.id,
          componentItemId: component.componentItemId,
          componentVariantId: component.componentVariantId,
          quantity: component.quantity,
        })),
      });
    });

    return this.findOne(organizationId, item.id);
  }

  // --------------------------------------------------------------------------
  // Validaciones
  // --------------------------------------------------------------------------

  private async getItem(organizationId: string | null, id: string) {
    const item = await this.prisma.item.findFirst({
      where: { id, organizationId },
    });

    if (!item) {
      throw new NotFoundException('Artículo no encontrado');
    }

    return item;
  }

  private async getVariant(itemId: string, variantId: string) {
    const variant = await this.prisma.itemVariant.findFirst({
      where: { id: variantId, itemId },
    });

    if (!variant) {
      throw new NotFoundException('Variante no encontrada');
    }

    return variant;
  }

  private async assertCategory(organizationId: string | null, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: {
        id: categoryId,
        OR: [{ organizationId }, { organizationId: null, isCore: true }],
      },
    });

    if (!category) {
      throw new NotFoundException('Categoría no encontrada');
    }

    if (!category.isActive) {
      throw new BadRequestException('La categoría está desactivada');
    }

    if (category.kind !== CategoryKind.ARTICLE) {
      throw new BadRequestException(
        'La categoría no es de artículos del catálogo',
      );
    }

    return category;
  }

  private async assertSkuAvailable(
    organizationId: string | null,
    sku: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.item.findFirst({
      where: {
        organizationId,
        sku: { equals: sku, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ya existe un artículo con ese SKU');
    }
  }

  private async assertVariantNameAvailable(
    itemId: string,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.itemVariant.findFirst({
      where: {
        itemId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        'Ya existe una variante con ese nombre en el artículo',
      );
    }
  }

  private async resolveExtraIngredients(
    organizationId: string | null,
    input: ExtraIngredientInputDto[],
  ) {
    return this.ingredientQuantities.resolve(organizationId, input);
  }

  private async validateExclusions(
    organizationId: string | null,
    input: ExclusionInputDto[],
  ) {
    const seen = new Set<string>();
    const result: Array<{ ingredientId: string; label?: string }> = [];

    for (const exclusion of input) {
      if (seen.has(exclusion.ingredientId)) {
        throw new BadRequestException(
          'Un ingrediente no puede repetirse en las exclusiones',
        );
      }
      seen.add(exclusion.ingredientId);

      const ingredient = await this.prisma.ingredient.findFirst({
        where: { id: exclusion.ingredientId, organizationId },
        select: { id: true },
      });

      if (!ingredient) {
        throw new NotFoundException('Ingrediente no encontrado');
      }

      result.push({
        ingredientId: ingredient.id,
        label: normalizeOptional(exclusion.label) ?? undefined,
      });
    }

    return result;
  }

  private async validateComboComponents(
    organizationId: string | null,
    comboId: string | null,
    input: ComboComponentInputDto[],
  ) {
    const seen = new Set<string>();
    const result: Array<{
      componentItemId: string;
      componentVariantId: string | null;
      quantity: number;
    }> = [];

    for (const item of input) {
      if (comboId && item.itemId === comboId) {
        throw new BadRequestException(
          'Un combo no puede contenerse a sí mismo',
        );
      }

      const key = `${item.itemId}:${item.variantId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          'Los componentes del combo no pueden repetirse',
        );
      }
      seen.add(key);

      const component = await this.prisma.item.findFirst({
        where: { id: item.itemId, organizationId },
      });

      if (!component) {
        throw new NotFoundException('Artículo componente no encontrado');
      }

      if (component.isCombo) {
        throw new BadRequestException(
          'No se permiten combos dentro de otro combo',
        );
      }

      if (!component.isActive) {
        throw new BadRequestException(
          `El artículo "${component.name}" está desactivado`,
        );
      }

      if (item.variantId) {
        const variant = await this.prisma.itemVariant.findFirst({
          where: { id: item.variantId, itemId: component.id },
        });

        if (!variant) {
          throw new NotFoundException(
            'La variante no pertenece al artículo componente',
          );
        }
      }

      result.push({
        componentItemId: component.id,
        componentVariantId: item.variantId ?? null,
        quantity: item.quantity ?? 1,
      });
    }

    return result;
  }
}

function normalizeOptional(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSku(value: string | undefined | null) {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

