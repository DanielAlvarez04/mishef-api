import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ClientAnalyticsEventDto } from './dto/analytics.dto'
import {
  ANALYTICS_EVENTS,
  isClientAnalyticsEvent,
  type AnalyticsEventName,
} from './analytics.events'

export interface AnalyticsEventInput {
  name: AnalyticsEventName
  organizationId: string | null
  branchId?: string | null
  userId?: string | null
  subjectType?: string | null
  subjectId?: string | null
  subjectName?: string | null
  itemId?: string | null
  orderId?: string | null
  menuId?: string | null
  quantity?: number | Prisma.Decimal | null
  amount?: number | Prisma.Decimal | null
  metadata?: Prisma.InputJsonValue | null
  occurredAt?: Date
}

export interface TopUsageParams {
  organizationId: string | null
  branchId?: string | null
  from: Date
  to: Date
  limit?: number
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra eventos sin romper el flujo que los origina.
   *
   * Se llama después de confirmar la operación de negocio: si la analítica
   * falla, la venta ya está guardada y solo se deja un aviso en el log.
   */
  async recordMany(inputs: AnalyticsEventInput[]): Promise<void> {
    if (inputs.length === 0) return

    try {
      await this.prisma.analyticsEvent.createMany({
        data: inputs.map((input) => ({
          organizationId: input.organizationId,
          branchId: input.branchId ?? null,
          userId: input.userId ?? null,
          name: input.name,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          subjectName: input.subjectName ?? null,
          itemId: input.itemId ?? null,
          orderId: input.orderId ?? null,
          menuId: input.menuId ?? null,
          quantity: toDecimal(input.quantity),
          amount: toDecimal(input.amount),
          ...(input.metadata === undefined || input.metadata === null
            ? {}
            : { metadata: input.metadata }),
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        })),
      })
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar la analítica: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /** Grupos de opciones más elegidos en pedidos del periodo. */
  topOptionGroups(params: TopUsageParams) {
    return this.prisma.analyticsEvent.groupBy({
      by: ['subjectId', 'subjectName'],
      where: this.usageWhere(
        ANALYTICS_EVENTS.optionGroupSelected,
        params,
      ),
      _count: { _all: true },
      _sum: { quantity: true },
      orderBy: { _count: { subjectId: 'desc' } },
      take: clampLimit(params.limit),
    })
  }

  /** Valores de opción más elegidos en pedidos del periodo. */
  topOptionValues(params: TopUsageParams) {
    return this.prisma.analyticsEvent.groupBy({
      by: ['subjectId', 'subjectName'],
      where: this.usageWhere(
        ANALYTICS_EVENTS.optionValueSelected,
        params,
      ),
      _count: { _all: true },
      _sum: { quantity: true },
      orderBy: { _count: { subjectId: 'desc' } },
      take: clampLimit(params.limit),
    })
  }

  /** Eventos crudos, para depurar o alimentar procesos externos. */
  listEvents(params: {
    organizationId: string | null
    branchId?: string | null
    name?: string
    from: Date
    to: Date
    limit?: number
  }) {
    return this.prisma.analyticsEvent.findMany({
      where: {
        organizationId: params.organizationId,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        ...(params.name ? { name: params.name } : {}),
        occurredAt: { gte: params.from, lte: params.to },
      },
      orderBy: { occurredAt: 'desc' },
      take: clampLimit(params.limit, 200),
    })
  }

  /**
   * Acepta eventos del POS. Solo se permiten nombres de la lista blanca y se
   * valida que el artículo/menú pertenezcan a la organización de la sesión.
   */
  async trackClientEvents(params: {
    organizationId: string | null
    branchId: string | null
    userId: string
    events: ClientAnalyticsEventDto[]
  }) {
    const invalid = params.events.find(
      (event) => !isClientAnalyticsEvent(event.name),
    )

    if (invalid) {
      throw new BadRequestException(
        `Evento de analítica no permitido: ${invalid.name}`,
      )
    }

    const itemIds = uniqueIds(params.events.map((event) => event.itemId))
    const menuIds = uniqueIds(params.events.map((event) => event.menuId))

    const [items, menus] = await Promise.all([
      itemIds.length > 0
        ? this.prisma.item.findMany({
            where: { id: { in: itemIds }, organizationId: params.organizationId },
            select: { id: true, name: true },
          })
        : [],
      menuIds.length > 0
        ? this.prisma.menu.findMany({
            where: {
              id: { in: menuIds },
              organizationId: params.organizationId,
            },
            select: { id: true, name: true },
          })
        : [],
    ])

    const itemsById = new Map(items.map((item) => [item.id, item]))
    const menusById = new Map(menus.map((menu) => [menu.id, menu]))

    const rows: AnalyticsEventInput[] = []

    for (const event of params.events) {
      const item = event.itemId ? itemsById.get(event.itemId) : undefined
      const menu = event.menuId ? menusById.get(event.menuId) : undefined

      // Un id que no pertenece a la organización se ignora en vez de tumbar
      // el lote completo.
      if (event.itemId && !item) continue
      if (event.menuId && !menu) continue

      const base = {
        organizationId: params.organizationId,
        branchId: params.branchId,
        userId: params.userId,
        itemId: item?.id ?? null,
        menuId: menu?.id ?? null,
        quantity: event.quantity ?? null,
        amount: event.amount ?? null,
        metadata: (event.metadata ?? null) as Prisma.InputJsonValue | null,
      }

      if (event.name === ANALYTICS_EVENTS.itemAddedToCart) {
        if (!item) continue

        rows.push({
          ...base,
          name: ANALYTICS_EVENTS.itemAddedToCart,
          subjectType: 'item',
          subjectId: item.id,
          subjectName: item.name,
          quantity: event.quantity ?? 1,
        })
        continue
      }

      if (event.name === ANALYTICS_EVENTS.menuFiltered) {
        if (!menu) continue

        rows.push({
          ...base,
          name: ANALYTICS_EVENTS.menuFiltered,
          subjectType: 'menu',
          subjectId: menu.id,
          subjectName: menu.name,
        })
        continue
      }

      rows.push({
        ...base,
        name: ANALYTICS_EVENTS.optionGroupOpened,
        subjectType: 'optionGroup',
        subjectId: event.subjectId ?? null,
        subjectName: event.subjectName ?? null,
      })
    }

    await this.recordMany(rows)

    return { accepted: rows.length, received: params.events.length }
  }

  private usageWhere(
    name: AnalyticsEventName,
    params: TopUsageParams,
  ): Prisma.AnalyticsEventWhereInput {
    return {
      organizationId: params.organizationId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      name,
      occurredAt: { gte: params.from, lte: params.to },
    }
  }
}

function toDecimal(
  value: number | Prisma.Decimal | null | undefined,
): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0)
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value)
}

function uniqueIds(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function clampLimit(value: number | undefined, fallback = 20): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return fallback
  }

  return Math.min(value, 100)
}
