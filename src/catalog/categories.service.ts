import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CategoryKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch } from '../common/patch';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string | null,
    includeInactive = false,
    kind: CategoryKind = CategoryKind.ARTICLE,
  ) {
    // Las categorías core son filas compartidas entre organizaciones, así que
    // su visibilidad es una preferencia del negocio, no un cambio en la fila.
    const coreEnabled = await this.coreGroupEnabled(organizationId, kind);

    const categories = await this.prisma.category.findMany({
      where: {
        kind,
        OR: [
          {
            organizationId,
            ...(includeInactive ? {} : { isActive: true }),
          },
          ...(includeInactive || coreEnabled
            ? [{ organizationId: null, isCore: true }]
            : []),
        ],
      },
      include:
        kind === CategoryKind.RECIPE
          ? {
              // El conteo también se limita al negocio: el `_count` sin filtro
              // sumaría artículos o recetas de otras organizaciones.
              _count: { select: { recipes: { where: { organizationId } } } },
            }
          : {
              _count: { select: { items: { where: { organizationId } } } },
            },
    });

    // Las categorías core son globales: cada negocio puede personalizar su
    // descripción y color sin tocar la fila compartida.
    const coreIds = categories
      .filter((category) => category.isCore)
      .map((category) => category.id);

    const overrides =
      organizationId && coreIds.length > 0
        ? await this.prisma.categoryOverride.findMany({
            where: { organizationId, categoryId: { in: coreIds } },
            select: { categoryId: true, description: true, color: true },
          })
        : [];

    const overrideByCategory = new Map(
      overrides.map((override) => [override.categoryId, override]),
    );

    return categories
      .map((category) => {
        if (!category.isCore) return category;

        const override = overrideByCategory.get(category.id);

        return {
          ...category,
          description:
            override === undefined
              ? category.description
              : override.description === null
                ? category.description
                : override.description || null,
          color:
            override === undefined || override.color === null
              ? category.color
              : override.color || null,
          isActive: coreEnabled,
        };
      })
      .sort((a, b) => {
        // Alfabético (es) y las opciones "Otra/Otro…" al final.
        const aOther = isOtherCategory(a);
        const bOther = isOtherCategory(b);

        if (aOther !== bOther) return aOther ? 1 : -1;

        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      });
  }

  async create(organizationId: string | null, dto: CreateCategoryDto) {
    const name = dto.name.trim();
    const kind = dto.kind ?? CategoryKind.ARTICLE;

    await this.assertNameAvailable(organizationId, kind, name);

    return this.prisma.category.create({
      data: {
        organizationId,
        name,
        description: normalizeOptional(dto.description),
        color: normalizeOptional(dto.color),
        sortOrder: dto.sortOrder ?? 0,
        kind,
        isCore: false,
      },
    });
  }

  async update(organizationId: string | null, id: string, dto: UpdateCategoryDto) {
    const category = await this.find(organizationId, id);

    if (category.isCore) {
      // El nombre es global; descripción y color se guardan por negocio.
      if (dto.name !== undefined && dto.name.trim() !== category.name) {
        throw new BadRequestException(
          'El nombre de las categorías core no se puede cambiar',
        );
      }

      if (!organizationId) {
        throw new BadRequestException(
          'Personaliza la categoría desde un negocio',
        );
      }

      // `null` = hereda el valor core; `""` = el negocio lo dejó vacío.
      const description =
        dto.description === undefined
          ? undefined
          : (normalizeOptional(dto.description) ?? '');
      const color =
        dto.color === undefined
          ? undefined
          : (normalizeOptional(dto.color) ?? '');

      const existing = await this.prisma.categoryOverride.findUnique({
        where: {
          organizationId_categoryId: { organizationId, categoryId: id },
        },
      });

      if (!existing) {
        if (description === undefined && color === undefined) {
          return category;
        }

        const created = await this.prisma.categoryOverride.create({
          data: {
            organizationId,
            categoryId: id,
            ...(description !== undefined ? { description } : {}),
            ...(color !== undefined ? { color } : {}),
          },
        });

        return {
          ...category,
          description:
            created.description === null
              ? category.description
              : created.description || null,
          color:
            created.color === null ? category.color : created.color || null,
        };
      }

      const data: Prisma.CategoryOverrideUncheckedUpdateInput = {};

      if (description !== undefined && description !== existing.description) {
        data.description = description;
      }
      if (color !== undefined && color !== existing.color) {
        data.color = color;
      }

      if (isEmptyPatch(data)) {
        return {
          ...category,
          description:
            existing.description === null
              ? category.description
              : existing.description || null,
          color:
            existing.color === null ? category.color : existing.color || null,
        };
      }

      const updated = await this.prisma.categoryOverride.update({
        where: { id: existing.id },
        data,
      });

      return {
        ...category,
        description:
          updated.description === null
            ? category.description
            : updated.description || null,
        color:
          updated.color === null ? category.color : updated.color || null,
      };
    }

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== category.name) {
        await this.assertNameAvailable(
          organizationId,
          category.kind,
          name,
          id,
        );
      }
    }

    const name = dto.name === undefined ? undefined : dto.name.trim();
    const description =
      dto.description === undefined
        ? undefined
        : normalizeOptional(dto.description);
    const color =
      dto.color === undefined ? undefined : normalizeOptional(dto.color);

    const data: Prisma.CategoryUncheckedUpdateInput = {};

    if (name !== undefined && name !== category.name) data.name = name;
    if (description !== undefined && description !== category.description) {
      data.description = description;
    }
    if (color !== undefined && color !== category.color) {
      data.color = color;
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== category.sortOrder) {
      data.sortOrder = dto.sortOrder;
    }
    if (dto.isActive !== undefined && dto.isActive !== category.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) {
      return category;
    }

    return this.prisma.category.update({
      where: { id: category.id },
      data,
    });
  }

  async deactivate(organizationId: string | null, id: string) {
    const category = await this.find(organizationId, id);

    if (category.isCore) {
      throw new BadRequestException(
        'Las categorías core no se pueden desactivar',
      );
    }

    if (category.kind === CategoryKind.RECIPE) {
      const activeRecipes = await this.prisma.recipe.count({
        where: { categoryId: category.id, isActive: true },
      });

      if (activeRecipes > 0) {
        throw new ConflictException(
          `La categoría tiene ${activeRecipes} receta(s) activa(s). Desactívalas o muévelas antes de desactivarla`,
        );
      }
    } else {
      const activeItems = await this.prisma.item.count({
        where: { categoryId: category.id, isActive: true },
      });

      if (activeItems > 0) {
        throw new ConflictException(
          `La categoría tiene ${activeItems} artículo(s) activo(s). Desactívalos o muévelos antes de desactivarla`,
        );
      }
    }

    return this.prisma.category.update({
      where: { id: category.id },
      data: { isActive: false },
    });
  }

  /**
   * Activa o desactiva todas las categorías core de un tipo **para el negocio
   * actual**.
   *
   * Las categorías core son filas globales compartidas: no se tocan. La
   * preferencia se guarda en la organización y, al desactivar, solo se limpia
   * la categoría de los artículos o recetas de esa organización.
   */
  async setCoreGroupActive(
    organizationId: string | null,
    kind: CategoryKind,
    isActive: boolean,
  ) {
    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona un negocio para cambiar las categorías',
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { useCoreCategories: true, useCoreRecipeCategories: true },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    const enabled =
      kind === CategoryKind.RECIPE
        ? organization.useCoreRecipeCategories
        : organization.useCoreCategories;

    if (enabled === isActive) {
      return { ok: true, updated: 0 };
    }

    const categories = await this.prisma.category.findMany({
      where: { organizationId: null, isCore: true, kind },
      select: { id: true },
    });

    const ids = categories.map((category) => category.id);

    return this.prisma.$transaction(async (tx) => {
      let detached = 0;

      if (!isActive && ids.length > 0) {
        const result =
          kind === CategoryKind.RECIPE
            ? await tx.recipe.updateMany({
                where: { organizationId, categoryId: { in: ids } },
                data: { categoryId: null },
              })
            : await tx.item.updateMany({
                where: { organizationId, categoryId: { in: ids } },
                data: { categoryId: null },
              });

        detached = result.count;
      }

      await tx.organization.update({
        where: { id: organizationId },
        data:
          kind === CategoryKind.RECIPE
            ? { useCoreRecipeCategories: isActive }
            : { useCoreCategories: isActive },
      });

      return { ok: true, updated: detached };
    });
  }

  /** Preferencia del negocio sobre las categorías core del tipo indicado. */
  private async coreGroupEnabled(
    organizationId: string | null,
    kind: CategoryKind,
  ) {
    if (!organizationId) return true;

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { useCoreCategories: true, useCoreRecipeCategories: true },
    });

    if (!organization) return false;

    return kind === CategoryKind.RECIPE
      ? organization.useCoreRecipeCategories
      : organization.useCoreCategories;
  }

  private async find(organizationId: string | null, id: string) {
    const category = await this.prisma.category.findFirst({
      where: {
        id,
        OR: [{ organizationId }, { organizationId: null, isCore: true }],
      },
    });

    if (!category) {
      throw new NotFoundException('Categoría no encontrada');
    }

    return category;
  }

  private async assertNameAvailable(
    organizationId: string | null,
    kind: CategoryKind,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.category.findFirst({
      where: {
        organizationId,
        kind,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ya existe una categoría con ese nombre');
    }

    if (organizationId) {
      const core = await this.prisma.category.findFirst({
        where: {
          organizationId: null,
          isCore: true,
          kind,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });

      if (core) {
        throw new ConflictException(
          'Ya existe una categoría core con ese nombre',
        );
      }
    }
  }
}

function normalizeOptional(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Categorías tipo "Otra/Otras/Otro/Otros…" que van al final del listado. */
const OTHER_CATEGORY_PATTERN = /^otr[oa]s?\b/i;

function isOtherCategory(category: { code: string | null; name: string }) {
  return (
    category.code === 'other' || OTHER_CATEGORY_PATTERN.test(category.name)
  );
}
