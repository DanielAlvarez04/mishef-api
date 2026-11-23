import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderRoundStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch, sameJson } from '../common/patch';
import { normalizeGroupColors } from '../common/group-colors';
import { globalMenuIsFresh, markGlobalMenuSynced } from './global-menu-cache';
import {
  CreateMenuDto,
  MenuItemInputDto,
  UpdateMenuDto,
} from './dto/menu.dto';

const menuInclude = {
  items: {
    orderBy: [{ sortOrder: 'asc' }, { item: { name: 'asc' } }],
    include: {
      item: {
        select: {
          id: true,
          name: true,
          price: true,
          isActive: true,
          isCombo: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  },
} satisfies Prisma.MenuInclude;

/** Menú de referencia que se crea automáticamente para cada negocio. */
const GLOBAL_MENU_NAME = 'Menú global';
const GLOBAL_MENU_DESCRIPTION =
  'Menú de referencia con todos los artículos y combos del catálogo.';
/** Primer grupo del menú global: los combos. */
const COMBO_GROUP = 'Combos';
/** Grupo para artículos activos sin categoría. */
const UNCATEGORIZED_GROUP = 'Sin categoría';

/** Ventana del ranking de «Tendencia» del POS. */
const TRENDING_DAYS = 30;
/** Vigencia de la caché del ranking (por organización y sucursal). */
const TRENDING_TTL_MS = 60_000;
/** Tope de artículos devueltos; suficiente para el top 3 de cada grupo. */
const TRENDING_LIMIT = 500;

export interface TrendingMenuItem {
  itemId: string;
  quantity: number;
}

interface TrendingCacheEntry {
  at: number;
  items: TrendingMenuItem[];
}

type MenuRow = Prisma.MenuGetPayload<{ include: typeof menuInclude }>;

/**
 * Vigencia de un menú en un instante dado.
 *
 * Sin días ni horas = siempre disponible. Las horas admiten cruce de
 * medianoche (18:00 → 02:00). Las fechas son opcionales.
 */
export function menuIsAvailableNow(
  menu: {
    isActive: boolean;
    daysOfWeek: number[];
    startTime: string | null;
    endTime: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (!menu.isActive) return false;
  if (menu.startsAt && now < menu.startsAt) return false;
  if (menu.endsAt && now > menu.endsAt) return false;

  if (
    menu.daysOfWeek.length > 0 &&
    !menu.daysOfWeek.includes(now.getDay())
  ) {
    return false;
  }

  if (menu.startTime && menu.endTime) {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes(),
    ).padStart(2, '0')}`;
    const inWindow =
      menu.startTime <= menu.endTime
        ? hhmm >= menu.startTime && hhmm <= menu.endTime
        : hhmm >= menu.startTime || hhmm <= menu.endTime;

    if (!inWindow) return false;
  }

  return true;
}

@Injectable()
export class MenusService {
  private readonly trendingCache = new Map<string, TrendingCacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Artículos más vendidos en pedidos cobrados de la ventana reciente.
   *
   * Alimenta el chip «Tendencia» del POS: el cliente lo agrupa por sección y
   * se queda con los tres primeros de cada grupo. Solo cuenta pedidos
   * cerrados (cobrados) y descarta rondas canceladas.
   */
  async trending(
    organizationId: string | null,
    branchId: string | null,
    days = TRENDING_DAYS,
  ): Promise<{ days: number; items: TrendingMenuItem[] }> {
    if (!organizationId) return { days: TRENDING_DAYS, items: [] };

    const windowDays = Number.isFinite(days)
      ? Math.min(Math.max(Math.trunc(days), 1), 365)
      : TRENDING_DAYS;
    const key = `${organizationId}:${branchId ?? '*'}:${windowDays}`;
    const cached = this.trendingCache.get(key);

    if (cached && Date.now() - cached.at < TRENDING_TTL_MS) {
      return { days: windowDays, items: cached.items };
    }

    const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.orderItem.groupBy({
      by: ['itemId'],
      where: {
        orderRound: {
          status: { not: OrderRoundStatus.CANCELLED },
          order: {
            organizationId,
            status: OrderStatus.CLOSED,
            createdAt: { gte: from },
            ...(branchId ? { branchId } : {}),
          },
        },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: TRENDING_LIMIT,
    });

    const items = rows.map((row) => ({
      itemId: row.itemId,
      quantity: row._sum.quantity ?? 0,
    }));

    this.trendingCache.set(key, { at: Date.now(), items });

    return { days: windowDays, items };
  }

  async list(organizationId: string | null, includeInactive = false) {
    await this.ensureGlobalMenu(organizationId);

    const menus = await this.prisma.menu.findMany({
      where: {
        organizationId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: menuInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return menus.map((menu) => this.withAvailability(menu));
  }

  /**
   * Crea o sincroniza el «Menú global» de referencia.
   *
   * Junta todo el catálogo activo: los combos en el primer grupo y cada
   * artículo en un grupo con el nombre de su categoría. Queda siempre
   * disponible, sin horario ni fechas, y con todos los artículos asignados.
   *
   * El nombre, la descripción y la disponibilidad son editables por el
   * negocio; el contenido (artículos y grupos) se recalcula desde el catálogo
   * y no se puede editar a mano. Si aún no hay artículos no crea nada.
   */
  async ensureGlobalMenu(organizationId: string | null): Promise<void> {
    if (!organizationId) return;

    // Lecturas seguidas del POS no repiten la sincronización: el contenido solo
    // cambia con mutaciones del catálogo, que invalidan esta marca.
    if (globalMenuIsFresh(organizationId)) return;

    markGlobalMenuSynced(organizationId);

    const existing = await this.prisma.menu.findFirst({
      where: {
        organizationId,
        // Si el nombre ya está ocupado no se intenta crear en cada carga.
        OR: [{ isGlobal: true }, { name: GLOBAL_MENU_NAME }],
      },
      select: { id: true, isGlobal: true, groups: true, groupColors: true },
    });

    // Un menú del usuario con el mismo nombre no se toca.
    if (existing && !existing.isGlobal) return;

    const items = await this.prisma.item.findMany({
      where: { organizationId, isActive: true, isArchived: false },
      select: {
        id: true,
        name: true,
        isCombo: true,
        sortOrder: true,
        category: { select: { name: true } },
      },
      orderBy: [{ isCombo: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });

    if (items.length === 0) return;

    // El menú global se agrupa por categoría. Los nombres se ordenan
    // alfabéticamente (ignorando mayúsculas y acentos) para que el orden sea
    // estable y legible, sin depender del `sortOrder` de la categoría.
    const categoryNames = [
      ...new Set(
        items
          .filter(
            (item): item is typeof item & { category: { name: string } } =>
              !item.isCombo && Boolean(item.category?.name),
          )
          .map((item) => item.category.name),
      ),
    ];

    const groupFor = (item: (typeof items)[number]) =>
      item.isCombo
        ? COMBO_GROUP
        : (item.category?.name ?? UNCATEGORIZED_GROUP);

    const hasCombos = items.some((item) => item.isCombo);
    const hasUncategorized = items.some(
      (item) => !item.isCombo && !item.category?.name,
    );

    // Combos siempre primero; el resto en orden alfabético (incluido
    // «Sin categoría»). Así el POS muestra primero la sección de combos y
    // después las categorías, sin depender del `sortOrder` de la categoría.
    const sortedGroups = [
      ...new Set([
        ...categoryNames,
        ...(hasUncategorized ? [UNCATEGORIZED_GROUP] : []),
      ]),
    ].sort((left, right) =>
      left.localeCompare(right, 'es', { sensitivity: 'base' }),
    );

    const groups = [...(hasCombos ? [COMBO_GROUP] : []), ...sortedGroups];

    const groupColors = normalizeGroupColors(groups, existing?.groupColors);

    const groupOrder = new Map(groups.map((group, index) => [group, index]));
    const ordered = [...items].sort((left, right) => {
      const leftGroup = groupOrder.get(groupFor(left)) ?? groups.length;
      const rightGroup = groupOrder.get(groupFor(right)) ?? groups.length;

      return (
        leftGroup - rightGroup ||
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name, 'es')
      );
    });

    if (existing) {
      // El contenido del menú global siempre refleja el catálogo actual.
      await this.prisma.$transaction(async (tx) => {
        if (
          !sameJson(existing.groups, groups) ||
          !sameJson(existing.groupColors ?? {}, groupColors)
        ) {
          await tx.menu.update({
            where: { id: existing.id },
            data: { groups, groupColors },
          });
        }

        await this.syncItems(
          tx,
          existing.id,
          ordered.map((item, index) => ({
            itemId: item.id,
            sortOrder: index,
            group: groupFor(item),
          })),
        );
      });

      return;
    }

    try {
      await this.prisma.menu.create({
        data: {
          organizationId,
          name: GLOBAL_MENU_NAME,
          description: GLOBAL_MENU_DESCRIPTION,
          isGlobal: true,
          isActive: true,
          daysOfWeek: [],
          groups,
          groupColors,
          items: {
            create: ordered.map((item, index) => ({
              itemId: item.id,
              sortOrder: index,
              group: groupFor(item),
            })),
          },
        },
      });
    } catch (error) {
      // Otra petición lo creó a la vez, o ya existe un menú con ese nombre.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }

      throw error;
    }
  }

  async findOne(organizationId: string | null, id: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id, organizationId },
      include: menuInclude,
    });

    if (!menu) {
      throw new NotFoundException('Menú no encontrado');
    }

    return this.withAvailability(menu);
  }

  async create(organizationId: string | null, dto: CreateMenuDto) {
    const name = dto.name.trim();
    const schedule = this.normalizeSchedule(dto, {
      daysOfWeek: [],
      startTime: null,
      endTime: null,
      startsAt: null,
      endsAt: null,
    });
    const groups = this.normalizeGroups(dto.groups);
    const groupColors = normalizeGroupColors(groups, dto.groupColors);
    const items = await this.validateItems(
      organizationId,
      null,
      dto.items,
      groups,
    );

    try {
      const menu = await this.prisma.menu.create({
        data: {
          organizationId,
          name,
          description: normalizeOptional(dto.description),
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
          ...schedule,
          groups,
          groupColors,
          items: {
            create: items.map((item) => ({
              itemId: item.itemId,
              sortOrder: item.sortOrder,
              group: item.group,
            })),
          },
        },
        include: menuInclude,
      });

      return this.withAvailability(menu);
    } catch (error) {
      this.rethrowUnique(error, 'Ya existe un menú con ese nombre');
    }
  }

  async update(
    organizationId: string | null,
    id: string,
    dto: UpdateMenuDto,
  ) {
    const menu = await this.getMenu(organizationId, id);

    if (menu.isGlobal && (dto.items !== undefined || dto.groups !== undefined)) {
      throw new BadRequestException(
        'El menú global incluye todos los artículos automáticamente: no permite editar artículos ni grupos',
      );
    }

    const name = dto.name === undefined ? undefined : dto.name.trim();

    const data: Prisma.MenuUncheckedUpdateInput = {};

    if (name !== undefined && name !== menu.name) data.name = name;
    if (dto.description !== undefined) {
      const description = normalizeOptional(dto.description);
      if (description !== menu.description) data.description = description;
    }
    if (dto.isActive !== undefined && dto.isActive !== menu.isActive) {
      data.isActive = dto.isActive;
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== menu.sortOrder) {
      data.sortOrder = dto.sortOrder;
    }

    const schedule = this.normalizeSchedule(dto, {
      daysOfWeek: menu.daysOfWeek,
      startTime: menu.startTime,
      endTime: menu.endTime,
      startsAt: menu.startsAt,
      endsAt: menu.endsAt,
    });

    if (!sameJson(schedule.daysOfWeek, menu.daysOfWeek)) {
      data.daysOfWeek = schedule.daysOfWeek;
    }
    if (schedule.startTime !== menu.startTime) {
      data.startTime = schedule.startTime;
    }
    if (schedule.endTime !== menu.endTime) {
      data.endTime = schedule.endTime;
    }
    if (!sameDate(schedule.startsAt, menu.startsAt)) {
      data.startsAt = schedule.startsAt;
    }
    if (!sameDate(schedule.endsAt, menu.endsAt)) {
      data.endsAt = schedule.endsAt;
    }

    const groups =
      dto.groups === undefined
        ? menu.groups
        : this.normalizeGroups(dto.groups);
    const groupsChanged = !sameJson(groups, menu.groups);
    if (groupsChanged) data.groups = groups;

    const groupColors = normalizeGroupColors(
      groups,
      dto.groupColors ?? menu.groupColors,
    );
    if (!sameJson(groupColors, menu.groupColors ?? {})) {
      data.groupColors = groupColors;
    }

    const items =
      dto.items === undefined
        ? null
        : await this.validateItems(organizationId, menu.id, dto.items, groups);

    if (isEmptyPatch(data) && items === null) {
      return this.findOne(organizationId, menu.id);
    }

    await this.prisma.$transaction(async (tx) => {
      if (!isEmptyPatch(data)) {
        await tx.menu.update({ where: { id: menu.id }, data });
      }

      // Un grupo eliminado deja a sus artículos en «Sin grupo».
      if (groupsChanged) {
        await tx.menuItem.updateMany({
          where: {
            menuId: menu.id,
            ...(groups.length > 0
              ? { group: { notIn: groups } }
              : { group: { not: null } }),
          },
          data: { group: null },
        });
      }

      if (items !== null) {
        await this.syncItems(tx, menu.id, items);
      }
    });

    return this.findOne(organizationId, menu.id);
  }

  async deactivate(organizationId: string | null, id: string) {
    const menu = await this.getMenu(organizationId, id);

    await this.prisma.menu.update({
      where: { id: menu.id },
      data: { isActive: false },
    });

    return this.findOne(organizationId, menu.id);
  }

  /**
   * Copia un menú completo como borrador inactivo.
   *
   * Conserva descripción, programación y artículos (con su orden). El nombre
   * recibe el sufijo «(copia)» y se garantiza que sea único en la organización.
   */
  async duplicate(organizationId: string | null, id: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id, organizationId },
      include: {
        items: {
          select: { itemId: true, sortOrder: true, group: true },
          orderBy: [{ sortOrder: 'asc' }, { item: { name: 'asc' } }],
        },
      },
    });

    if (!menu) {
      throw new NotFoundException('Menú no encontrado');
    }

    const max = await this.prisma.menu.aggregate({
      where: { organizationId },
      _max: { sortOrder: true },
    });

    const name = await this.duplicateName(organizationId, menu.name);

    const copy = await this.prisma.menu.create({
      data: {
        organizationId,
        name,
        description: menu.description,
        isActive: false,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        daysOfWeek: menu.daysOfWeek,
        startTime: menu.startTime,
        endTime: menu.endTime,
        startsAt: menu.startsAt,
        endsAt: menu.endsAt,
        groups: menu.groups,
        groupColors: normalizeGroupColors(menu.groups, menu.groupColors),
        items: {
          create: menu.items.map((item) => ({
            itemId: item.itemId,
            sortOrder: item.sortOrder,
            group: item.group,
          })),
        },
      },
      include: menuInclude,
    });

    return this.withAvailability(copy);
  }

  /** Elimina el menú y sus asignaciones; los artículos no se tocan. */
  async remove(organizationId: string | null, id: string) {
    const menu = await this.getMenu(organizationId, id);

    if (menu.isGlobal) {
      throw new BadRequestException(
        'El menú global no se puede eliminar: representa todo el catálogo',
      );
    }

    await this.prisma.menu.delete({ where: { id: menu.id } });

    return { id: menu.id, deleted: true };
  }

  async replaceItems(
    organizationId: string | null,
    menuId: string,
    items: MenuItemInputDto[],
    groups?: string[],
  ) {
    const menu = await this.getMenu(organizationId, menuId);

    if (menu.isGlobal) {
      throw new BadRequestException(
        'El menú global no permite editar artículos: se actualiza solo con el catálogo',
      );
    }

    const normalized = await this.validateItems(
      organizationId,
      menu.id,
      items,
      groups === undefined ? menu.groups : this.normalizeGroups(groups),
    );

    await this.prisma.$transaction(async (tx) => {
      await this.syncItems(tx, menu.id, normalized);
    });

    return this.findOne(organizationId, menu.id);
  }

  private withAvailability(menu: MenuRow) {
    return {
      ...menu,
      groupColors: normalizeGroupColors(menu.groups, menu.groupColors),
      isAvailableNow: menuIsAvailableNow(menu),
    };
  }

  private async getMenu(organizationId: string | null, id: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        isActive: true,
        isGlobal: true,
        sortOrder: true,
        daysOfWeek: true,
        startTime: true,
        endTime: true,
        startsAt: true,
        endsAt: true,
        groups: true,
        groupColors: true,
      },
    });

    if (!menu) {
      throw new NotFoundException('Menú no encontrado');
    }

    return menu;
  }

  private normalizeSchedule(
    dto: {
      daysOfWeek?: number[];
      startTime?: string | null;
      endTime?: string | null;
      startsAt?: string | null;
      endsAt?: string | null;
    },
    current: {
      daysOfWeek: number[];
      startTime: string | null;
      endTime: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
    },
  ) {
    const daysOfWeek =
      dto.daysOfWeek === undefined
        ? current.daysOfWeek
        : [...new Set(dto.daysOfWeek)].sort((left, right) => left - right);

    const startTime =
      dto.startTime === undefined ? current.startTime : dto.startTime || null;
    const endTime =
      dto.endTime === undefined ? current.endTime : dto.endTime || null;

    if (Boolean(startTime) !== Boolean(endTime)) {
      throw new BadRequestException(
        'Indica la hora de inicio y la de fin del menú',
      );
    }

    const startsAt =
      dto.startsAt === undefined
        ? current.startsAt
        : dto.startsAt
          ? new Date(dto.startsAt)
          : null;
    const endsAt =
      dto.endsAt === undefined
        ? current.endsAt
        : dto.endsAt
          ? new Date(dto.endsAt)
          : null;

    if (startsAt && endsAt && endsAt < startsAt) {
      throw new BadRequestException(
        'La fecha de fin debe ser posterior a la de inicio',
      );
    }

    return { daysOfWeek, startTime, endTime, startsAt, endsAt };
  }

  private async validateItems(
    organizationId: string | null,
    menuId: string | null,
    input: MenuItemInputDto[],
    groups: string[],
  ) {
    if (input.length === 0) {
      throw new BadRequestException(
        'El menú debe tener al menos un artículo',
      );
    }

    const ids = input.map((row) => row.itemId);

    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Un artículo no puede repetirse dentro del menú',
      );
    }

    const items = await this.prisma.item.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, isActive: true },
    });

    const byId = new Map(items.map((item) => [item.id, item]));
    const assigned = menuId
      ? new Set(
          (
            await this.prisma.menuItem.findMany({
              where: { menuId },
              select: { itemId: true },
            })
          ).map((row) => row.itemId),
        )
      : new Set<string>();

    return input.map((row, index) => {
      const item = byId.get(row.itemId);

      if (!item) {
        throw new BadRequestException(
          'Uno de los artículos del menú no existe en el catálogo',
        );
      }

      if (!item.isActive && !assigned.has(item.id)) {
        throw new BadRequestException(
          'No se pueden añadir artículos desactivados a un menú',
        );
      }

      const group = row.group?.trim() || null;

      if (group !== null && !groups.includes(group)) {
        throw new BadRequestException(
          'El grupo del artículo no existe en el menú',
        );
      }

      return {
        itemId: item.id,
        sortOrder: row.sortOrder ?? index,
        group,
      };
    });
  }

  /** Nombres de sección sin vacíos ni duplicados, en el orden recibido. */
  private normalizeGroups(input?: string[]): string[] {
    if (!input) return [];

    const seen = new Set<string>();
    const groups: string[] = [];

    for (const value of input) {
      const name = value.trim();
      if (!name || seen.has(name)) continue;

      seen.add(name);
      groups.push(name);
    }

    return groups;
  }

  private async syncItems(
    tx: Prisma.TransactionClient,
    menuId: string,
    items: Array<{ itemId: string; sortOrder: number; group: string | null }>,
  ) {
    const current = await tx.menuItem.findMany({
      where: { menuId },
      select: { itemId: true, sortOrder: true, group: true },
    });

    const byKey = (
      list: ReadonlyArray<{
        itemId: string;
        sortOrder: number;
        group: string | null;
      }>,
    ) =>
      [...list].sort((left, right) =>
        left.itemId.localeCompare(right.itemId),
      );

    const currentRows = byKey(current);
    const nextRows = byKey(items);

    const unchanged =
      currentRows.length === nextRows.length &&
      currentRows.every(
        (row, index) =>
          row.itemId === nextRows[index].itemId &&
          row.sortOrder === nextRows[index].sortOrder &&
          row.group === nextRows[index].group,
      );

    if (unchanged) return;

    await tx.menuItem.deleteMany({ where: { menuId } });

    await tx.menuItem.createMany({
      data: items.map((item) => ({
        menuId,
        itemId: item.itemId,
        sortOrder: item.sortOrder,
        group: item.group,
      })),
    });
  }

  /**
   * Nombre único para una copia: «Nombre (copia)», «Nombre (copia 2)», etc.
   *
   * Se consulta la base en cada intento para respetar la restricción
   * `@@unique([organizationId, name])` sin depender de un conteo previo.
   */
  private async duplicateName(organizationId: string | null, source: string) {
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const suffix = attempt === 1 ? ' (copia)' : ` (copia ${attempt})`;
      const base = source.slice(0, Math.max(1, 80 - suffix.length)).trimEnd();
      const candidate = `${base}${suffix}`;

      const existing = await this.prisma.menu.findFirst({
        where: { organizationId, name: candidate },
        select: { id: true },
      });

      if (!existing) return candidate;
    }

    // Inalcanzable en la práctica; evita devolver un nombre vacío.
    return `${source.slice(0, 68).trimEnd()} (copia ${Date.now()})`;
  }

  private rethrowUnique(error: unknown, message: string): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }

    throw error;
  }
}

function normalizeOptional(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sameDate(left: Date | null, right: Date | null) {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}
