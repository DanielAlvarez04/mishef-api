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

/** Días de datos necesarios para activar el reporte automáticamente. */
const OPERATIONS_AUTO_DAYS = 14

/** Retención de eventos crudos de analítica (12 meses). */
const ANALYTICS_RETENTION_DAYS = 365

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
   * Reporte de operación del POS: tiempos de captura, fricción del catálogo y
   * consumo por cliente o por mesa.
   *
   * Los tiempos salen del evento resumen `pos.order_capture_finished` (una
   * fila por ronda), no de cada clic. El consumo por cliente se calcula de
   * `OrderItem.guestId` de cuentas de mesa no canceladas, así que no requiere
   * instrumentación adicional.
   */
  async posOperationsReport(params: {
    organizationId: string | null
    branchId?: string | null
    from: Date
    to: Date
  }) {
    const scope = params.branchId ? { branchId: params.branchId } : {}
    const baseWhere: Prisma.AnalyticsEventWhereInput = {
      organizationId: params.organizationId,
      ...scope,
      occurredAt: { gte: params.from, lte: params.to },
    }

    const [captures, frictionCounts, topEmptyGroups, firstCapture, guestRows] =
      await Promise.all([
        this.prisma.analyticsEvent.findMany({
          where: {
            ...baseWhere,
            name: ANALYTICS_EVENTS.posOrderCaptureFinished,
          },
          select: {
            occurredAt: true,
            quantity: true,
            amount: true,
            metadata: true,
          },
          orderBy: { occurredAt: 'asc' },
          take: 20_000,
        }),
        this.prisma.analyticsEvent.groupBy({
          by: ['name'],
          where: {
            ...baseWhere,
            name: {
              in: [
                ANALYTICS_EVENTS.itemAddedToCart,
                ANALYTICS_EVENTS.posItemOpened,
                ANALYTICS_EVENTS.posItemDialogCancelled,
                ANALYTICS_EVENTS.posSearchNoResults,
                ANALYTICS_EVENTS.posValidationError,
              ],
            },
          },
          _count: { _all: true },
        }),
        this.prisma.analyticsEvent.groupBy({
          by: ['subjectName'],
          where: {
            ...baseWhere,
            name: ANALYTICS_EVENTS.posSearchNoResults,
          },
          _count: { _all: true },
        }),
        this.prisma.analyticsEvent.findFirst({
          where: {
            organizationId: params.organizationId,
            ...scope,
            name: ANALYTICS_EVENTS.posOrderCaptureFinished,
          },
          orderBy: { occurredAt: 'asc' },
          select: { occurredAt: true },
        }),
        this.guestConsumption(params),
      ])

    const sent = captures.filter(
      (event) => readMetaString(event.metadata, 'outcome') === 'sent',
    )
    const countOutcome = (outcome: string) =>
      captures.filter(
        (event) => readMetaString(event.metadata, 'outcome') === outcome,
      ).length

    const activeValues = numbersOf(sent, 'activeMs')
    const wallValues = numbersOf(sent, 'wallMs')
    const browseValues = numbersOf(sent, 'browseMs')
    const assemblyValues = numbersOf(sent, 'assemblyMs')
    const interactionValues = numbersOf(sent, 'interactions')
    const guestValues = numbersOf(sent, 'guests')
    const lineValues = numbersOf(sent, 'lines')
    const itemValues = sent.map((event) => Number(event.quantity) || 0)

    const totalItems = sum(itemValues)
    const totalActiveMs = sum(activeValues)
    const totalSearches = sum(numbersOf(captures, 'searches'))
    const totalEmptySearches = sum(numbersOf(captures, 'emptySearches'))
    const totalDialogs = sum(numbersOf(captures, 'itemDialogs'))
    const totalValidationErrors = sum(numbersOf(captures, 'validationErrors'))

    const friction = (name: string) =>
      frictionCounts.find((row) => row.name === name)?._count._all ?? 0
    const opened = friction(ANALYTICS_EVENTS.posItemOpened)
    const cancelled = friction(ANALYTICS_EVENTS.posItemDialogCancelled)

    const topEmptySearches = topEmptyGroups
      .filter((row) => Boolean(row.subjectName))
      .map((row) => ({
        query: row.subjectName ?? '',
        count: row._count._all,
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10)

    const dayGroups = new Map<string, number[]>()

    for (const event of sent) {
      const activeMs = readMetaNumber(event.metadata, 'activeMs')

      if (activeMs === null) continue

      const key = localDayKey(event.occurredAt)
      const values = dayGroups.get(key) ?? []
      values.push(activeMs)
      dayGroups.set(key, values)
    }

    const byDay = [...dayGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, values]) => ({
        date,
        samples: values.length,
        activeMedianMs: median(values),
      }))

    const dataDays = firstCapture
      ? Math.floor(
          (Date.now() - firstCapture.occurredAt.getTime()) / 86_400_000,
        ) + 1
      : 0

    const guestReport = guestRows[0] ?? emptyGuestAggregate()

    return {
      from: params.from.toISOString(),
      to: params.to.toISOString(),
      capture: {
        samples: captures.length,
        sent: sent.length,
        abandoned: countOutcome('abandoned'),
        switched: countOutcome('switched'),
        activeMedianMs: median(activeValues),
        activeP90Ms: percentile(activeValues, 90),
        wallMedianMs: median(wallValues),
        wallP90Ms: percentile(wallValues, 90),
        browseMedianMs: median(browseValues),
        assemblyMedianMs: median(assemblyValues),
        averageItems: average(itemValues),
        averageLines: average(lineValues),
        averageInteractions: average(interactionValues),
        averageGuests: average(guestValues),
        itemsPerMinute:
          totalActiveMs > 0
            ? round(totalItems / (totalActiveMs / 60_000), 1)
            : null,
        searches: totalSearches,
        emptySearches: totalEmptySearches,
        emptySearchRate:
          totalSearches > 0
            ? round(totalEmptySearches / totalSearches, 3)
            : null,
        itemDialogs: totalDialogs,
        validationErrors: totalValidationErrors,
        byDay,
      },
      friction: {
        opened,
        added: friction(ANALYTICS_EVENTS.itemAddedToCart),
        cancelled,
        cancelRate: opened > 0 ? round(cancelled / opened, 3) : null,
        validationErrors: friction(ANALYTICS_EVENTS.posValidationError),
        emptySearches: friction(ANALYTICS_EVENTS.posSearchNoResults),
        topEmptySearches,
      },
      guests: {
        orders: guestReport.orders,
        ordersWithGuests: guestReport.ordersWithGuests,
        seats: guestReport.seats,
        guestsWithItems: guestReport.guestsWithItems,
        lines: guestReport.lines,
        guestLines: guestReport.guestLines,
        assignedLineShare:
          guestReport.lines > 0
            ? round(guestReport.guestLines / guestReport.lines, 3)
            : null,
        assignedAmountShare:
          guestReport.totalNet > 0
            ? round(guestReport.guestNet / guestReport.totalNet, 3)
            : null,
        averageGrossPerGuest:
          guestReport.guestsWithItems > 0
            ? round(
                guestReport.guestGross / guestReport.guestsWithItems,
                2,
              )
            : null,
        averageNetPerGuest:
          guestReport.guestsWithItems > 0
            ? round(guestReport.guestNet / guestReport.guestsWithItems, 2)
            : null,
        averageGrossPerSeat:
          guestReport.seats > 0
            ? round(guestReport.totalGross / guestReport.seats, 2)
            : null,
        averageNetPerSeat:
          guestReport.seats > 0
            ? round(guestReport.totalNet / guestReport.seats, 2)
            : null,
        totalGross: guestReport.totalGross,
        totalNet: guestReport.totalNet,
        guestGross: guestReport.guestGross,
        guestNet: guestReport.guestNet,
        generalGross: guestReport.generalGross,
        generalNet: guestReport.generalNet,
      },
      data: {
        firstCaptureAt: firstCapture?.occurredAt.toISOString() ?? null,
        days: dataDays,
        autoAfterDays: OPERATIONS_AUTO_DAYS,
        autoEnabled: dataDays >= OPERATIONS_AUTO_DAYS,
        samples: captures.length,
      },
    }
  }

  /**
   * Purga eventos de analítica vencidos para cumplir la retención mínima.
   *
   * Se expone por organización: un ADMIN solo borra los eventos de la suya.
   */
  async purgeOlderThan(
    organizationId: string | null,
    days = ANALYTICS_RETENTION_DAYS,
  ) {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const result = await this.prisma.analyticsEvent.deleteMany({
      where: {
        organizationId,
        occurredAt: { lt: cutoff },
      },
    })

    return {
      deleted: result.count,
      cutoff: cutoff.toISOString(),
      days,
    }
  }

  /**
   * Consumo por cliente y por asiento de cuentas de mesa.
   *
   * Se agrega en SQL para no traer cada línea al proceso Node.
   * `OrderItem.subtotal` es el precio con IVA; el neto se obtiene restando
   * `taxAmount`. Así ambos totales salen de la misma fuente y no se duplica
   * el impuesto.
   */
  private async guestConsumption(params: {
    organizationId: string | null
    branchId?: string | null
    from: Date
    to: Date
  }): Promise<GuestAggregate[]> {
    const branchFilter = params.branchId
      ? Prisma.sql`AND o."branchId" = ${params.branchId}`
      : Prisma.empty

    return this.prisma.$queryRaw<GuestAggregate[]>(Prisma.sql`
      WITH per_order AS (
        SELECT
          o.id,
          o."partySize" AS party_size,
          COUNT(*)::int AS lines,
          COUNT(*) FILTER (WHERE oi."guestId" IS NOT NULL)::int AS guest_lines,
          COUNT(DISTINCT oi."guestId")
            FILTER (WHERE oi."guestId" IS NOT NULL)::int AS guests_with_items,
          COALESCE(
            SUM(oi.subtotal - oi."taxAmount"),
            0
          )::float8 AS order_net,
          COALESCE(SUM(oi.subtotal), 0)::float8 AS order_gross,
          COALESCE(
            SUM(oi.subtotal - oi."taxAmount")
              FILTER (WHERE oi."guestId" IS NOT NULL),
            0
          )::float8 AS guest_net,
          COALESCE(
            SUM(oi.subtotal) FILTER (WHERE oi."guestId" IS NOT NULL),
            0
          )::float8 AS guest_gross,
          COALESCE(
            SUM(oi.subtotal - oi."taxAmount")
              FILTER (WHERE oi."guestId" IS NULL),
            0
          )::float8 AS general_net,
          COALESCE(
            SUM(oi.subtotal) FILTER (WHERE oi."guestId" IS NULL),
            0
          )::float8 AS general_gross
        FROM "Order" o
        JOIN "OrderRound" r ON r."orderId" = o.id
        JOIN "OrderItem" oi ON oi."orderRoundId" = r.id
        WHERE o."organizationId" = ${params.organizationId}
          AND o."createdAt" BETWEEN ${params.from} AND ${params.to}
          AND o.status <> 'CANCELLED'
          AND o.channel = 'DINE_IN'
          ${branchFilter}
        GROUP BY o.id, o."partySize"
      )
      SELECT
        COUNT(*)::int AS orders,
        COUNT(*) FILTER (WHERE guests_with_items > 0)::int AS "ordersWithGuests",
        COALESCE(SUM(party_size), 0)::int AS seats,
        COALESCE(SUM(guests_with_items), 0)::int AS "guestsWithItems",
        COALESCE(SUM(lines), 0)::int AS lines,
        COALESCE(SUM(guest_lines), 0)::int AS "guestLines",
        COALESCE(SUM(order_net), 0)::float8 AS "totalNet",
        COALESCE(SUM(order_gross), 0)::float8 AS "totalGross",
        COALESCE(SUM(guest_net), 0)::float8 AS "guestNet",
        COALESCE(SUM(guest_gross), 0)::float8 AS "guestGross",
        COALESCE(SUM(general_net), 0)::float8 AS "generalNet",
        COALESCE(SUM(general_gross), 0)::float8 AS "generalGross"
      FROM per_order
    `)
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
    const orderIds = uniqueIds(params.events.map((event) => event.orderId))

    const [items, menus, orders] = await Promise.all([
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
      orderIds.length > 0
        ? this.prisma.order.findMany({
            where: {
              id: { in: orderIds },
              organizationId: params.organizationId,
            },
            select: { id: true },
          })
        : [],
    ])

    const itemsById = new Map(items.map((item) => [item.id, item]))
    const menusById = new Map(menus.map((menu) => [menu.id, menu]))
    const orderIdsSet = new Set(orders.map((order) => order.id))

    const rows: AnalyticsEventInput[] = []

    for (const event of params.events) {
      const item = event.itemId ? itemsById.get(event.itemId) : undefined
      const menu = event.menuId ? menusById.get(event.menuId) : undefined
      // Un id de otra organización se ignora: no se filtra información de
      // pedidos ajenos ni se rompe el lote completo.
      const orderId =
        event.orderId && orderIdsSet.has(event.orderId) ? event.orderId : null

      // Un id que no pertenece a la organización se ignora en vez de tumbar
      // el lote completo.
      if (event.itemId && !item) continue
      if (event.menuId && !menu) continue

      const metadata = sanitizeMetadata(event.metadata)
      const base = {
        organizationId: params.organizationId,
        branchId: params.branchId,
        userId: params.userId,
        itemId: item?.id ?? null,
        menuId: menu?.id ?? null,
        orderId,
        quantity: event.quantity ?? null,
        amount: event.amount ?? null,
        metadata,
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

      if (event.name === ANALYTICS_EVENTS.posOrderCaptureFinished) {
        rows.push({
          ...base,
          name: event.name,
          subjectType: 'posCapture',
        })
        continue
      }

      if (
        event.name === ANALYTICS_EVENTS.posItemOpened ||
        event.name === ANALYTICS_EVENTS.posItemDialogCancelled
      ) {
        if (!item) continue

        rows.push({
          ...base,
          name: event.name,
          subjectType: 'item',
          subjectId: item.id,
          subjectName: item.name,
        })
        continue
      }

      if (event.name === ANALYTICS_EVENTS.posSearchNoResults) {
        const query = (event.subjectName ?? '').trim()

        if (!query) continue

        rows.push({
          ...base,
          name: event.name,
          subjectType: 'search',
          subjectName: query.slice(0, 120),
        })
        continue
      }

      if (event.name === ANALYTICS_EVENTS.posValidationError) {
        rows.push({
          ...base,
          name: event.name,
          subjectType: 'validation',
          subjectName: event.subjectName?.slice(0, 120) ?? null,
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

interface GuestAggregate {
  orders: number
  ordersWithGuests: number
  seats: number
  guestsWithItems: number
  lines: number
  guestLines: number
  totalNet: number
  totalGross: number
  guestNet: number
  guestGross: number
  generalNet: number
  generalGross: number
}

function emptyGuestAggregate(): GuestAggregate {
  return {
    orders: 0,
    ordersWithGuests: 0,
    seats: 0,
    guestsWithItems: 0,
    lines: 0,
    guestLines: 0,
    totalNet: 0,
    totalGross: 0,
    guestNet: 0,
    guestGross: 0,
    generalNet: 0,
    generalGross: 0,
  }
}

/**
 * Reduce los metadatos a primitivos planos y acota su longitud.
 *
 * Es la barrera de privacidad de la analítica: aunque un cliente manipulado
 * envíe objetos anidados, no se guardan nombres, teléfonos, direcciones ni
 * textos libres largos.
 */
function sanitizeMetadata(
  value: Record<string, unknown> | undefined | null,
): Prisma.InputJsonValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const output: Record<string, string | number | boolean | null> = {}

  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 30)) {
    const key = rawKey.slice(0, 60)

    if (!key) continue

    if (typeof rawValue === 'string') {
      output[key] = rawValue.slice(0, 120)
    } else if (
      typeof rawValue === 'number' &&
      Number.isFinite(rawValue)
    ) {
      output[key] = rawValue
    } else if (typeof rawValue === 'boolean' || rawValue === null) {
      output[key] = rawValue
    }
  }

  return Object.keys(output).length > 0 ? output : null
}

function readMetaNumber(
  metadata: Prisma.JsonValue | null,
  key: string,
): number | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  const value = (metadata as Record<string, Prisma.JsonValue>)[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readMetaString(
  metadata: Prisma.JsonValue | null,
  key: string,
): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  const value = (metadata as Record<string, Prisma.JsonValue>)[key]

  return typeof value === 'string' ? value : null
}

function numbersOf(
  events: Array<{ metadata: Prisma.JsonValue | null }>,
  key: string,
): number[] {
  return events
    .map((event) => readMetaNumber(event.metadata, key))
    .filter((value): value is number => value !== null)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(sum(values) / values.length, 1) : null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function percentile(values: number[], target: number): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((target / 100) * sorted.length) - 1),
  )

  return sorted[index]
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits

  return Math.round(value * factor) / factor
}

function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')

  return `${year}-${month}-${day}`
}
