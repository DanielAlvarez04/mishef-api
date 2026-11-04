import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  CategoryKind,
  OptionEffectAction,
  OptionSelection,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IngredientQuantitiesService } from './ingredient-quantities.service';
import { fromCanonicalQuantity, toCanonicalQuantity, toMoney } from '../common/units';
import { isEmptyPatch, sameDecimal } from '../common/patch';
import { alphabetSuffix, categoryInitials } from '../common/sku';
import { CatalogEntriesService } from './catalog-entries.service';
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
  ComboPromotionInputDto,
} from './dto/item.dto';
import {
  ItemOptionEffectInputDto,
  ItemOptionGroupInputDto,
} from './dto/option.dto';
import { isNoPriceOptionGroup } from './option-presets';

const itemListInclude = {
  catalogEntry: {
    select: { id: true, imageKey: true, imageUrl: true, imageName: true },
  },
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
  comboComponents: {
    include: {
      componentItem: {
        select: { id: true, name: true, price: true, isActive: true },
      },
      variant: { select: { id: true, name: true } },
    },
  },
  recipes: {
    select: { id: true, name: true, variantId: true, isActive: true },
    orderBy: { variantId: 'asc' },
  },
  optionGroups: {
    orderBy: { sortOrder: 'asc' },
    include: {
      group: { select: { id: true, name: true } },
      values: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { value: { name: 'asc' } }],
        include: {
          value: {
            select: {
              id: true,
              name: true,
              kitchenLabel: true,
              isActive: true,
            },
          },
          effects: {
            select: {
              id: true,
              action: true,
              recipeIngredientId: true,
              replacesIngredientId: true,
              ingredientId: true,
              quantity: true,
            },
          },
        },
      },
    },
  },
  promotions: { orderBy: { createdAt: 'asc' } },
  menuItems: {
    orderBy: { sortOrder: 'asc' },
    include: {
      menu: { select: { id: true, name: true, isActive: true } },
    },
  },
} satisfies Prisma.ItemInclude;

const itemDetailInclude = {
  catalogEntry: {
    select: { id: true, imageKey: true, imageUrl: true, imageName: true },
  },
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
  optionGroups: {
    orderBy: { sortOrder: 'asc' },
    include: {
      group: { select: { id: true, name: true, description: true } },
      values: {
        orderBy: [{ sortOrder: 'asc' }, { value: { name: 'asc' } }],
        include: {
          value: {
            select: {
              id: true,
              name: true,
              kitchenLabel: true,
              isActive: true,
            },
          },
          effects: {
            select: {
              id: true,
              action: true,
              recipeIngredientId: true,
              replacesIngredientId: true,
              ingredientId: true,
              quantity: true,
            },
          },
        },
      },
    },
  },
  promotions: { orderBy: { createdAt: 'asc' } },
  menuItems: {
    orderBy: { sortOrder: 'asc' },
    include: {
      menu: { select: { id: true, name: true, isActive: true } },
    },
  },
} satisfies Prisma.ItemInclude;

export interface ItemFilters {
  search?: string;
  categoryId?: string;
  includeInactive?: boolean;
  /** Incluye artículos archivados (borradores de recetas). */
  includeArchived?: boolean;
  onlyCombos?: boolean;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingredientQuantities: IngredientQuantitiesService,
    private readonly catalogEntries: CatalogEntriesService,
  ) {}

  async list(organizationId: string | null, filters: ItemFilters = {}) {
    const search = filters.search?.trim();

    const items = await this.prisma.item.findMany({
      where: {
        organizationId,
        // Los artículos despublicados se archivan: salen del catálogo de
        // artículos aunque se pidan los inactivos. El catálogo los pide con
        // `includeArchived` para conservar los borradores de las recetas.
        ...(filters.includeArchived ? {} : { isArchived: false }),
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

    return items.map((item) => this.withMenus(item));
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
   * Los artículos exponen los menús donde se usan como `menus` planos
   * (`{ id, name, isActive }`), que es lo que consume la tabla del catálogo.
   */
  private withMenus<
    T extends {
      menuItems: Array<{
        menu: { id: string; name: string; isActive: boolean };
      }>;
      catalogEntry: {
        id: string;
        imageKey: string | null;
        imageUrl: string | null;
        imageName: string | null;
      } | null;
    },
  >(item: T) {
    const { menuItems, catalogEntry, ...rest } = item;

    // La imagen vive en la entrada compartida; la API la expone plana para no
    // cambiar el contrato que ya consumen la tabla y las tarjetas.
    return {
      ...rest,
      catalogEntryId: catalogEntry?.id ?? null,
      imageKey: catalogEntry?.imageKey ?? null,
      imageUrl: catalogEntry?.imageUrl ?? null,
      imageName: catalogEntry?.imageName ?? null,
      menus: menuItems.map((row) => row.menu),
    };
  }

  /**
   * Las cantidades de recetas y extras se guardan en la unidad canónica del
   * ingrediente; la UI las recibe en su unidad visible.
   */
  private withDisplayUnits(
    item: Prisma.ItemGetPayload<{ include: typeof itemDetailInclude }>,
  ) {
    const base = this.withMenus(item);

    return {
      ...base,
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

    const optionGroups = await this.validateOptionGroups(
      organizationId,
      null,
      dto.optionGroups ?? [],
    );

    const promotions = this.promotionData(dto.promotions ?? []);

    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.item.create({
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
                ? {
                    variant: { connect: { id: component.componentVariantId } },
                  }
                : {}),
            })),
          },
          optionGroups: {
            create: optionGroups.map((group) => ({
              group: { connect: { id: group.groupId } },
              isRequired: group.isRequired,
              selection: group.selection,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: group.sortOrder,
              values: {
                create: group.values.map((value) => ({
                  ...(value.valueId
                    ? { value: { connect: { id: value.valueId } } }
                    : {}),
                  customName: value.customName,
                  priceDelta: value.priceDelta,
                  scaleFactor: value.scaleFactor,
                  isDefault: value.isDefault,
                  sortOrder: value.sortOrder,
                  isActive: value.isActive,
                  effects: { create: value.effects },
                })),
              },
            })),
          },
          promotions: { create: promotions },
        },
      });

      // La entrada nace con el id del artículo: la carpeta `catalog/{id}/`
      // coincide con el artículo y no cambia si luego se le vincula una receta.
      await tx.catalogEntry.create({
        data: { id: created.id, organizationId },
      });
      await tx.item.update({
        where: { id: created.id },
        data: { catalogEntryId: created.id },
      });

      return created;
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
      await this.prisma.comboPromotion.deleteMany({
        where: { itemId: item.id },
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

    // Solo se arma el `data` con los campos que realmente cambiaron.
    const name = dto.name === undefined ? undefined : dto.name.trim();
    const description =
      dto.description === undefined
        ? undefined
        : normalizeOptional(dto.description);
    const nextSku = dto.sku === undefined ? sku : normalizeSku(dto.sku);
    const price = dto.price === undefined ? undefined : toMoney(dto.price);
    const taxRate =
      dto.taxRate === undefined
        ? undefined
        : dto.taxRate === null
          ? null
          : new Prisma.Decimal(dto.taxRate);

    const data: Prisma.ItemUncheckedUpdateInput = {};

    if (name !== undefined && name !== item.name) data.name = name;
    if (description !== undefined && description !== item.description) {
      data.description = description;
    }
    if (nextSku !== undefined && nextSku !== item.sku) data.sku = nextSku;
    if (
      dto.categoryId !== undefined &&
      (dto.categoryId ?? null) !== item.categoryId
    ) {
      data.categoryId = dto.categoryId;
    }
    if (price !== undefined && !price.equals(item.price)) data.price = price;
    if (taxRate !== undefined && !sameDecimal(taxRate, item.taxRate)) {
      data.taxRate = taxRate;
    }
    if (dto.isCombo !== undefined && dto.isCombo !== item.isCombo) {
      data.isCombo = dto.isCombo;
    }
    if (dto.isActive !== undefined && dto.isActive !== item.isActive) {
      data.isActive = dto.isActive;
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== item.sortOrder) {
      data.sortOrder = dto.sortOrder;
    }

    if (!isEmptyPatch(data)) {
      await this.prisma.item.update({
        where: { id: item.id },
        data,
      });
    }

    if (imageKey !== undefined) {
      const entryId =
        item.catalogEntryId ??
        (await this.catalogEntries.ensureForItem(organizationId, item.id));

      // La imagen vive en la entrada compartida con la receta, si existe.
      await this.catalogEntries.applyImage(
        organizationId,
        entryId,
        name || item.name,
        imageKey,
      );
    }

    if (dto.variants !== undefined) {
      await this.syncVariants(item.id, dto.variants, nextSku ?? item.sku);
    } else if (nextSku && nextSku !== item.sku) {
      // La base cambió sin tocar presentaciones: solo se renumeran los sufijos.
      await this.renumberVariantSkus(item.id, nextSku);
    }

    if (dto.optionGroups !== undefined) {
      await this.syncOptionGroups(
        organizationId,
        item.id,
        dto.optionGroups,
      );
    }

    if (dto.promotions !== undefined) {
      await this.replaceComboPromotions(
        organizationId,
        item.id,
        dto.promotions,
      );
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
        // Solo se escribe la presentación si algo cambió de verdad.
        const priceAdjust = toMoney(variant.priceAdjust ?? 0);
        const recipeFactor =
          variant.recipeFactor === undefined
            ? undefined
            : new Prisma.Decimal(variant.recipeFactor);
        const sortOrder = variant.sortOrder ?? index;
        const isActive = variant.isActive ?? true;
        const isPrimary = index === primaryIndex;

        const data: Prisma.ItemVariantUncheckedUpdateInput = {};

        if (name !== match.name) data.name = name;
        if (sku !== undefined && sku !== match.sku) data.sku = sku;
        if (isPrimary !== match.isPrimary) data.isPrimary = isPrimary;
        if (!priceAdjust.equals(match.priceAdjust)) {
          data.priceAdjust = priceAdjust;
        }
        // Sin factor en el DTO se conserva el actual (recetas publicadas).
        if (recipeFactor !== undefined && !recipeFactor.equals(match.recipeFactor)) {
          data.recipeFactor = recipeFactor;
        }
        if (sortOrder !== match.sortOrder) data.sortOrder = sortOrder;
        if (isActive !== match.isActive) data.isActive = isActive;

        if (!isEmptyPatch(data)) {
          await this.prisma.itemVariant.update({
            where: { id: match.id },
            data,
          });
        }
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
      const sku = `${baseSku}${alphabetSuffix(index)}`;

      if (sku === variant.sku) continue;

      await this.prisma.itemVariant.update({
        where: { id: variant.id },
        data: { sku },
      });
    }
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
      select: { id: true, name: true, catalogEntryId: true },
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

    // La base ya no referencia las entradas: se borran las que quedaron sin
    // artículo ni receta, junto con su objeto de R2.
    await Promise.all(
      items.map((item) =>
        this.catalogEntries.deleteIfOrphan(item.catalogEntryId),
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

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const priceAdjust =
      dto.priceAdjust === undefined ? undefined : toMoney(dto.priceAdjust);
    const recipeFactor =
      dto.recipeFactor === undefined
        ? undefined
        : new Prisma.Decimal(dto.recipeFactor);

    const data: Prisma.ItemVariantUncheckedUpdateInput = {};

    if (name !== undefined && name !== variant.name) data.name = name;
    if (priceAdjust !== undefined && !priceAdjust.equals(variant.priceAdjust)) {
      data.priceAdjust = priceAdjust;
    }
    if (recipeFactor !== undefined && !recipeFactor.equals(variant.recipeFactor)) {
      data.recipeFactor = recipeFactor;
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== variant.sortOrder) {
      data.sortOrder = dto.sortOrder;
    }
    if (dto.isActive !== undefined && dto.isActive !== variant.isActive) {
      data.isActive = dto.isActive;
    }

    const updated = isEmptyPatch(data)
      ? variant
      : await this.prisma.itemVariant.update({
          where: { id: variant.id },
          data,
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

    const currentIngredients = await this.prisma.itemExtraIngredient.findMany({
      where: { itemExtraId: extra.id },
      select: { ingredientId: true, quantity: true },
    });

    const ingredientsChanged =
      ingredients !== undefined &&
      !sameIngredientQuantities(currentIngredients, ingredients);

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const price = dto.price === undefined ? undefined : toMoney(dto.price);

    const data: Prisma.ItemExtraUncheckedUpdateInput = {};

    if (name !== undefined && name !== extra.name) data.name = name;
    if (price !== undefined && !price.equals(extra.price)) data.price = price;
    if (dto.isActive !== undefined && dto.isActive !== extra.isActive) {
      data.isActive = dto.isActive;
    }

    const hasChanges = !isEmptyPatch(data) || ingredientsChanged;

    const updated = hasChanges
      ? await this.prisma.$transaction(async (tx) => {
          if (ingredientsChanged && ingredients) {
            await tx.itemExtraIngredient.deleteMany({
              where: { itemExtraId: extra.id },
            });
          }

          return tx.itemExtra.update({
            where: { id: extra.id },
            data: {
              ...data,
              ...(ingredientsChanged && ingredients
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
        })
      : extra;

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

    const current = await this.prisma.itemIngredientExclusion.findMany({
      where: { itemId: item.id },
      select: { ingredientId: true, label: true },
    });

    const byIngredient = (
      list: ReadonlyArray<{ ingredientId: string; label?: string | null }>,
    ) =>
      [...list].sort((left, right) =>
        left.ingredientId.localeCompare(right.ingredientId),
      );

    const nextRows = byIngredient(normalized);
    const currentRows = byIngredient(current);

    const unchanged =
      currentRows.length === nextRows.length &&
      currentRows.every(
        (row, index) =>
          row.ingredientId === nextRows[index].ingredientId &&
          (row.label ?? null) === (nextRows[index].label ?? null),
      );

    if (unchanged) {
      return this.findOne(organizationId, item.id);
    }

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

    const current = await this.prisma.comboComponent.findMany({
      where: { comboId: item.id },
      select: { componentItemId: true, componentVariantId: true, quantity: true },
    });

    const key = (row: {
      componentItemId: string;
      componentVariantId: string | null;
    }) => `${row.componentItemId}:${row.componentVariantId ?? ''}`;

    const byKey = (
      list: ReadonlyArray<{
        componentItemId: string;
        componentVariantId: string | null;
        quantity: number;
      }>,
    ) => [...list].sort((left, right) => key(left).localeCompare(key(right)));

    const currentRows = byKey(current);
    const nextRows = byKey(normalized);

    const unchanged =
      currentRows.length === nextRows.length &&
      currentRows.every(
        (row, index) =>
          key(row) === key(nextRows[index]) &&
          row.quantity === nextRows[index].quantity,
      );

    if (unchanged) {
      return this.findOne(organizationId, item.id);
    }

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
  // Opciones y promociones de combo
  // --------------------------------------------------------------------------

  async replaceComboPromotions(
    organizationId: string | null,
    itemId: string,
    promotions: ComboPromotionInputDto[],
  ) {
    const item = await this.getItem(organizationId, itemId);

    if (!item.isCombo && promotions.length > 0) {
      throw new BadRequestException(
        'Solo los combos pueden tener promociones',
      );
    }

    const normalized = this.promotionData(promotions);

    const current = await this.prisma.comboPromotion.findMany({
      where: { itemId: item.id },
      orderBy: { createdAt: 'asc' },
    });

    const signature = (rows: ReadonlyArray<Record<string, unknown>>) =>
      JSON.stringify(
        rows.map((row) => ({
          name: row.name,
          type: row.type,
          value: new Prisma.Decimal(row.value as Prisma.Decimal).toFixed(2),
          startsAt: row.startsAt ? new Date(row.startsAt as Date).toISOString() : null,
          endsAt: row.endsAt ? new Date(row.endsAt as Date).toISOString() : null,
          daysOfWeek: [...((row.daysOfWeek as number[]) ?? [])].sort(),
          startTime: row.startTime ?? null,
          endTime: row.endTime ?? null,
          isActive: row.isActive,
        })),
      );

    if (signature(current) === signature(normalized)) {
      return this.findOne(organizationId, item.id);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.comboPromotion.deleteMany({ where: { itemId: item.id } });

      if (normalized.length > 0) {
        await tx.comboPromotion.createMany({
          data: normalized.map((promotion) => ({
            itemId: item.id,
            ...promotion,
          })),
        });
      }
    });

    return this.findOne(organizationId, item.id);
  }

  private promotionData(input: ComboPromotionInputDto[]) {
    return input.map((promotion) => {
      const value = toMoney(promotion.value ?? 0);

      if (promotion.type === 'PERCENT' && value.gt(100)) {
        throw new BadRequestException(
          'El porcentaje de una promoción no puede superar 100',
        );
      }

      const startsAt = promotion.startsAt
        ? new Date(promotion.startsAt)
        : null;
      const endsAt = promotion.endsAt ? new Date(promotion.endsAt) : null;

      if (startsAt && Number.isNaN(startsAt.getTime())) {
        throw new BadRequestException('La fecha de inicio no es válida');
      }
      if (endsAt && Number.isNaN(endsAt.getTime())) {
        throw new BadRequestException('La fecha de fin no es válida');
      }
      if (startsAt && endsAt && endsAt < startsAt) {
        throw new BadRequestException(
          'La fecha de fin debe ser posterior a la de inicio',
        );
      }

      return {
        name: promotion.name.trim(),
        type: promotion.type,
        value,
        startsAt,
        endsAt,
        daysOfWeek: [...new Set(promotion.daysOfWeek ?? [])].sort(
          (left, right) => left - right,
        ),
        startTime: promotion.startTime || null,
        endTime: promotion.endTime || null,
        isActive: promotion.isActive ?? true,
      };
    });
  }

  private async validateOptionGroups(
    organizationId: string | null,
    itemId: string | null,
    input: ItemOptionGroupInputDto[],
  ) {
    if (input.length === 0) return [];

    const groupIds = input.map((group) => group.groupId);

    if (new Set(groupIds).size !== groupIds.length) {
      throw new BadRequestException(
        'Un grupo de opciones no puede repetirse en el artículo',
      );
    }

    const groups = await this.prisma.optionGroup.findMany({
      where: { id: { in: groupIds }, organizationId },
      include: { values: { select: { id: true, name: true } } },
    });

    const assignedGroupIds = itemId
      ? new Set(
          (
            await this.prisma.itemOptionGroup.findMany({
              where: { itemId },
              select: { groupId: true },
            })
          ).map((row) => row.groupId),
        )
      : new Set<string>();

    const byId = new Map(groups.map((group) => [group.id, group]));

    const ingredientIds = new Set<string>();
    const slotIds = new Set<string>();

    for (const group of input) {
      for (const value of group.values) {
        for (const effect of value.effects ?? []) {
          if (effect.ingredientId) ingredientIds.add(effect.ingredientId);
          if (effect.replacesIngredientId) {
            ingredientIds.add(effect.replacesIngredientId);
          }
          if (effect.recipeIngredientId) {
            slotIds.add(effect.recipeIngredientId);
          }
        }
      }
    }

    const [ingredients, slotRows, itemEntry] = await Promise.all([
      ingredientIds.size > 0
        ? this.prisma.ingredient.findMany({
            where: { id: { in: [...ingredientIds] }, organizationId },
            select: { id: true },
          })
        : [],
      itemId && slotIds.size > 0
        ? this.prisma.recipeIngredient.findMany({
            where: { id: { in: [...slotIds] }, recipe: { itemId } },
            select: { id: true },
          })
        : [],
      itemId
        ? this.prisma.item.findUnique({
            where: { id: itemId },
            select: { catalogEntryId: true },
          })
        : null,
    ]);

    const slots: Array<{ id: string }> = slotRows

    // Un borrador de receta aún no tiene `itemId`, pero comparte la entrada de
    // catálogo con su artículo. Sus efectos deben validarse contra la receta.
    if (itemId && itemEntry?.catalogEntryId && slotIds.size > 0) {
      const byEntry = await this.prisma.recipeIngredient.findMany({
        where: {
          id: { in: [...slotIds] },
          recipe: { catalogEntryId: itemEntry.catalogEntryId },
        },
        select: { id: true },
      });

      for (const row of byEntry) {
        if (!slots.some((slot) => slot.id === row.id)) {
          slots.push(row);
        }
      }
    }

    const knownIngredients = new Set(ingredients.map((row) => row.id));
    const knownSlots = new Set(slots.map((row) => row.id));

    return input.map((group, groupIndex) => {
      const catalog = byId.get(group.groupId);

      if (!catalog) {
        throw new NotFoundException('Grupo de opciones no encontrado');
      }

      if (!catalog.isActive && !assignedGroupIds.has(catalog.id)) {
        throw new BadRequestException(
          `El grupo ${catalog.name} está desactivado`,
        );
      }

      const selection = group.selection ?? OptionSelection.SINGLE;
      const isRequired = group.isRequired ?? false;
      const minSelect =
        group.minSelect ?? (isRequired ? 1 : 0);
      const maxSelect =
        group.maxSelect ?? (selection === OptionSelection.SINGLE ? 1 : group.values.length);

      if (selection === OptionSelection.SINGLE && maxSelect > 1) {
        throw new BadRequestException(
          `El grupo ${catalog.name} es de selección única`,
        );
      }

      if (maxSelect < minSelect) {
        throw new BadRequestException(
          `El máximo de ${catalog.name} no puede ser menor que el mínimo`,
        );
      }

      // Un grupo recién creado puede no tener opciones todavía.
      if (group.values.length > 0 && maxSelect > group.values.length) {
        throw new BadRequestException(
          `El grupo ${catalog.name} no tiene suficientes opciones para el máximo configurado`,
        );
      }

      if (isRequired && minSelect < 1) {
        throw new BadRequestException(
          `El grupo obligatorio ${catalog.name} debe pedir al menos una opción`,
        );
      }

      const catalogValues = new Set(catalog.values.map((value) => value.id));
      const catalogValueNames = new Set(
        catalog.values.map((value) => value.name.toLowerCase()),
      );
      const seenValues = new Set<string>();
      const seenCustomNames = new Set<string>();

      const values = group.values.map((value, valueIndex) => {
        const customName = value.customName?.trim();

        if (value.valueId && customName) {
          throw new BadRequestException(
            `La opción de ${catalog.name} no puede ser de la biblioteca y propia del artículo a la vez`,
          );
        }

        if (!value.valueId && !customName) {
          throw new BadRequestException(
            `Cada opción de ${catalog.name} necesita un valor de la biblioteca o un nombre propio`,
          );
        }

        if (value.valueId && !catalogValues.has(value.valueId)) {
          throw new BadRequestException(
            `La opción no pertenece al grupo ${catalog.name}`,
          );
        }

        if (customName) {
          const normalized = customName.toLowerCase();

          if (
            catalogValueNames.has(normalized) ||
            seenCustomNames.has(normalized)
          ) {
            throw new BadRequestException(
              `La opción ${customName} ya existe en ${catalog.name}`,
            );
          }

          seenCustomNames.add(normalized);
        }

        const valueKey = value.valueId
          ? `library:${value.valueId}`
          : `custom:${customName!.toLowerCase()}`;

        if (seenValues.has(valueKey)) {
          throw new BadRequestException(
            `Un valor no puede repetirse en ${catalog.name}`,
          );
        }

        seenValues.add(valueKey);

        // Los grupos "Sin ..." no pueden cargar un precio extra: la opción
        // solo quita un ingrediente.
        const priceDelta = isNoPriceOptionGroup(catalog.name)
          ? new Prisma.Decimal(0)
          : toMoney(value.priceDelta ?? 0);

        return {
          valueId: value.valueId ?? null,
          customName: customName ?? null,
          priceDelta,
          scaleFactor: new Prisma.Decimal(value.scaleFactor ?? 1),
          isDefault: value.isDefault ?? false,
          sortOrder: value.sortOrder ?? valueIndex,
          isActive: value.isActive ?? true,
          effects: (value.effects ?? []).map((effect) =>
            this.validateOptionEffect(
              catalog.name,
              effect,
              knownIngredients,
              knownSlots,
              Boolean(itemId),
            ),
          ),
        };
      });

      const defaults = values.filter((value) => value.isDefault);

      if (
        isRequired &&
        values.length > 0 &&
        !values.some((value) => value.isActive)
      ) {
        throw new BadRequestException(
          `El grupo obligatorio ${catalog.name} necesita al menos una opción disponible`,
        );
      }

      if (
        selection === OptionSelection.SINGLE &&
        values.length > 0 &&
        defaults.length !== 1
      ) {
        throw new BadRequestException(
          `Elige una opción por defecto para ${catalog.name}`,
        );
      }

      if (defaults.length > maxSelect) {
        throw new BadRequestException(
          `Las opciones por defecto de ${catalog.name} superan el máximo permitido`,
        );
      }

      return {
        groupId: group.groupId,
        isRequired,
        selection,
        minSelect,
        maxSelect,
        sortOrder: group.sortOrder ?? groupIndex,
        values,
      };
    });
  }

  private validateOptionEffect(
    groupName: string,
    effect: ItemOptionEffectInputDto,
    knownIngredients: Set<string>,
    knownSlots: Set<string>,
    hasItem: boolean,
  ) {
    const recipeIngredientId = effect.recipeIngredientId ?? null;
    const replacesIngredientId = effect.replacesIngredientId ?? null;
    const ingredientId = effect.ingredientId ?? null;

    if (effect.action === OptionEffectAction.ADD && !ingredientId) {
      throw new BadRequestException(
        `El efecto de ${groupName} necesita un insumo que añadir`,
      );
    }

    if (
      effect.action === OptionEffectAction.REPLACE &&
      ((!recipeIngredientId && !replacesIngredientId) || !ingredientId)
    ) {
      throw new BadRequestException(
        `El reemplazo de ${groupName} necesita el insumo original y el nuevo`,
      );
    }

    if (
      effect.action === OptionEffectAction.REMOVE &&
      !recipeIngredientId &&
      !ingredientId
    ) {
      throw new BadRequestException(
        `La exclusión de ${groupName} necesita un insumo o una línea de receta`,
      );
    }

    if (ingredientId && !knownIngredients.has(ingredientId)) {
      throw new NotFoundException('Ingrediente no encontrado');
    }

    if (replacesIngredientId && !knownIngredients.has(replacesIngredientId)) {
      throw new NotFoundException('Ingrediente a reemplazar no encontrado');
    }

    if (recipeIngredientId && !hasItem) {
      throw new BadRequestException(
        'Los efectos sobre la receta se configuran después de crear la receta',
      );
    }

    if (recipeIngredientId && !knownSlots.has(recipeIngredientId)) {
      throw new BadRequestException(
        'El efecto apunta a un insumo que no pertenece a la receta',
      );
    }

    if (effect.quantity !== undefined && effect.quantity <= 0) {
      throw new BadRequestException(
        'La cantidad del efecto debe ser mayor que cero',
      );
    }

    return {
      action: effect.action,
      recipeIngredientId,
      replacesIngredientId,
      ingredientId,
      quantity:
        effect.quantity === undefined
          ? null
          : effect.unit
            ? toCanonicalQuantity(effect.quantity, effect.unit)
            : new Prisma.Decimal(effect.quantity),
    };
  }

  private async syncOptionGroups(
    organizationId: string | null,
    itemId: string,
    input: ItemOptionGroupInputDto[],
  ) {
    const normalized = await this.validateOptionGroups(
      organizationId,
      itemId,
      input,
    );

    const existing = await this.prisma.itemOptionGroup.findMany({
      where: { itemId },
      include: {
        values: { include: { effects: true } },
      },
    });

    const incoming = new Map(normalized.map((group) => [group.groupId, group]));
    const removed = existing.filter(
      (group) => !incoming.has(group.groupId),
    );

    await this.prisma.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.itemOptionGroup.deleteMany({
          where: { id: { in: removed.map((group) => group.id) } },
        });
      }

      for (const group of normalized) {
        const current = existing.find(
          (candidate) => candidate.groupId === group.groupId,
        );

        if (!current) {
          await tx.itemOptionGroup.create({
            data: {
              itemId,
              groupId: group.groupId,
              isRequired: group.isRequired,
              selection: group.selection,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: group.sortOrder,
              values: {
                create: group.values.map((value) => ({
                  valueId: value.valueId,
                  customName: value.customName,
                  priceDelta: value.priceDelta,
                  scaleFactor: value.scaleFactor,
                  isDefault: value.isDefault,
                  sortOrder: value.sortOrder,
                  isActive: value.isActive,
                  effects: { create: value.effects },
                })),
              },
            },
          });
          continue;
        }

        const groupData: Prisma.ItemOptionGroupUncheckedUpdateInput = {};

        if (group.isRequired !== current.isRequired) {
          groupData.isRequired = group.isRequired;
        }
        if (group.selection !== current.selection) {
          groupData.selection = group.selection;
        }
        if (group.minSelect !== current.minSelect) {
          groupData.minSelect = group.minSelect;
        }
        if (group.maxSelect !== current.maxSelect) {
          groupData.maxSelect = group.maxSelect;
        }
        if (group.sortOrder !== current.sortOrder) {
          groupData.sortOrder = group.sortOrder;
        }

        if (!isEmptyPatch(groupData)) {
          await tx.itemOptionGroup.update({
            where: { id: current.id },
            data: groupData,
          });
        }

        const incomingValues = new Map(
          group.values.map((value) => [this.optionValueKey(value), value]),
        );
        const removedValues = current.values.filter(
          (value) => !incomingValues.has(this.optionValueKey(value)),
        );

        if (removedValues.length > 0) {
          await tx.itemOptionValue.deleteMany({
            where: { id: { in: removedValues.map((value) => value.id) } },
          });
        }

        for (const value of group.values) {
          const match = current.values.find(
            (candidate) =>
              this.optionValueKey(candidate) === this.optionValueKey(value),
          );

          if (!match) {
            await tx.itemOptionValue.create({
              data: {
                itemOptionGroupId: current.id,
                valueId: value.valueId,
                customName: value.customName,
                priceDelta: value.priceDelta,
                scaleFactor: value.scaleFactor,
                isDefault: value.isDefault,
                sortOrder: value.sortOrder,
                isActive: value.isActive,
                effects: { create: value.effects },
              },
            });
            continue;
          }

          const valueData: Prisma.ItemOptionValueUncheckedUpdateInput = {};

          if (!value.priceDelta.equals(match.priceDelta)) {
            valueData.priceDelta = value.priceDelta;
          }
          if (value.scaleFactor !== undefined && !value.scaleFactor.equals(match.scaleFactor)) {
            valueData.scaleFactor = value.scaleFactor;
          }
          if (value.isDefault !== match.isDefault) {
            valueData.isDefault = value.isDefault;
          }
          if (value.sortOrder !== match.sortOrder) {
            valueData.sortOrder = value.sortOrder;
          }
          if (value.isActive !== match.isActive) {
            valueData.isActive = value.isActive;
          }

          if (!isEmptyPatch(valueData)) {
            await tx.itemOptionValue.update({
              where: { id: match.id },
              data: valueData,
            });
          }

          if (this.effectsSignature(value.effects) !== this.effectsSignature(match.effects)) {
            await tx.itemOptionEffect.deleteMany({
              where: { itemOptionValueId: match.id },
            });

            if (value.effects.length > 0) {
              await tx.itemOptionEffect.createMany({
                data: value.effects.map((effect) => ({
                  itemOptionValueId: match.id,
                  ...effect,
                })),
              });
            }
          }
        }
      }
    });
  }

  private optionValueKey(value: {
    valueId: string | null;
    customName: string | null;
  }) {
    return value.valueId
      ? `library:${value.valueId}`
      : `custom:${(value.customName ?? '').trim().toLowerCase()}`;
  }

  private effectsSignature(
    effects: ReadonlyArray<{
      action: OptionEffectAction;
      recipeIngredientId?: string | null;
      replacesIngredientId?: string | null;
      ingredientId?: string | null;
      quantity?: Prisma.Decimal | null;
    }>,
  ) {
    return JSON.stringify(
      [...effects]
        .map(
          (effect) =>
            `${effect.action}|${effect.recipeIngredientId ?? ''}|${
              effect.replacesIngredientId ?? ''
            }|${effect.ingredientId ?? ''}|${
              effect.quantity ? new Prisma.Decimal(effect.quantity).toFixed(4) : ''
            }`,
        )
        .sort(),
    );
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

/** Compara dos listas de ingredientes con cantidad sin importar el orden. */
function sameIngredientQuantities(
  current: ReadonlyArray<{ ingredientId: string; quantity: Prisma.Decimal }>,
  next: ReadonlyArray<{ ingredientId: string; quantity: Prisma.Decimal }>,
) {
  if (current.length !== next.length) return false;

  const sort = (
    list: ReadonlyArray<{ ingredientId: string; quantity: Prisma.Decimal }>,
  ) =>
    [...list].sort((left, right) =>
      left.ingredientId.localeCompare(right.ingredientId),
    );

  const left = sort(current);
  const right = sort(next);

  return left.every(
    (row, index) =>
      row.ingredientId === right[index].ingredientId &&
      row.quantity.equals(right[index].quantity),
  );
}

