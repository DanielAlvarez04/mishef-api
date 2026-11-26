import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementType,
  KitchenItemStatus,
  KitchenMode,
  KitchenTicketStatus,
  OptionEffectAction,
  OptionSelection,
  OrderChannel,
  OrderRoundStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  PromotionType,
  Role,
  SplitStatus,
  UnitCode,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ANALYTICS_EVENTS } from '../analytics/analytics.events';
import { isNoPriceOptionGroup } from '../catalog/option-presets';
import {
  DEFAULT_PREP_MINUTES,
  estimatePrepMinutes,
  prepPriority,
  type PrepPriority,
} from '../common/prep';
import { KitchenService } from '../kitchen/kitchen.service';
import { KitchenTicketingService } from '../kitchen/kitchen-ticketing.service';
import {
  CancelOrderDto,
  CreateOrderDto,
  OrderGuestDto,
  RoundItemDto,
  RoundItemOptionDto,
  SendRoundDto,
  TransitionRoundDto,
} from './dto/orders.dto';
import { OrdersEventsService } from './orders.events';
import { OrderSplitsService } from './order-splits.service';
import { TicketSequenceService } from '../tickets/ticket-sequence.service';
import { TransitionKitchenTicketDto } from '../kitchen/dto/kitchen-ticket.dto';
import type { JwtUser } from '../auth/auth.service';

/** Estados a los que puede pasar cada estado de ronda (plan.md §6.6). */
const ALLOWED_TRANSITIONS: Record<OrderRoundStatus, OrderRoundStatus[]> = {
  [OrderRoundStatus.PENDING]: [
    OrderRoundStatus.FIRED,
    OrderRoundStatus.PREPARING,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.HELD]: [
    OrderRoundStatus.FIRED,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.FIRED]: [
    OrderRoundStatus.PREPARING,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.PREPARING]: [
    OrderRoundStatus.READY,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.READY]: [
    OrderRoundStatus.PICKED_UP,
    OrderRoundStatus.DELIVERED,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.PICKED_UP]: [
    OrderRoundStatus.DELIVERED,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.DELIVERED]: [],
  [OrderRoundStatus.CANCELLED]: [],
};

const OPEN_ROUND_STATUSES = [
  OrderRoundStatus.PENDING,
  OrderRoundStatus.HELD,
  OrderRoundStatus.FIRED,
  OrderRoundStatus.PREPARING,
  OrderRoundStatus.READY,
  OrderRoundStatus.PICKED_UP,
];

/** Transiciones de un ticket de estación. */
const TICKET_TRANSITIONS: Record<
  KitchenTicketStatus,
  KitchenTicketStatus[]
> = {
  [KitchenTicketStatus.PENDING]: [
    KitchenTicketStatus.PREPARING,
    KitchenTicketStatus.CANCELLED,
  ],
  [KitchenTicketStatus.PREPARING]: [
    KitchenTicketStatus.READY,
    KitchenTicketStatus.CANCELLED,
  ],
  [KitchenTicketStatus.READY]: [
    KitchenTicketStatus.PICKED_UP,
    KitchenTicketStatus.DELIVERED,
    KitchenTicketStatus.CANCELLED,
  ],
  [KitchenTicketStatus.PICKED_UP]: [
    KitchenTicketStatus.DELIVERED,
    KitchenTicketStatus.CANCELLED,
  ],
  [KitchenTicketStatus.DELIVERED]: [],
  [KitchenTicketStatus.CANCELLED]: [],
};

const kitchenTicketInclude: Prisma.KitchenTicketInclude = {
  station: { select: { id: true, name: true, code: true, color: true } },
  assignedMembership: {
    select: { id: true, user: { select: { name: true, username: true } } },
  },
  items: {
    include: {
      orderItem: {
        include: {
          extras: true,
          options: true,
          exclusions: {
            include: {
              ingredient: {
                select: {
                  id: true,
                  name: true,
                  baseUnit: true,
                  displayUnit: true,
                },
              },
            },
          },
        },
      },
    },
  },
  orderRound: {
    select: {
      id: true,
      sentAt: true,
      createdAt: true,
      orderId: true,
      order: {
        select: {
          id: true,
          tableNumber: true,
          channel: true,
          customerName: true,
          isTakeaway: true,
          branchId: true,
          status: true,
        },
      },
    },
  },
};

const roundInclude: Prisma.OrderRoundInclude = {
  items: {
    orderBy: { id: 'asc' },
    include: {
      extras: true,
      options: true,
      exclusions: {
        include: {
          ingredient: {
            select: {
              id: true,
              name: true,
              baseUnit: true,
              displayUnit: true,
            },
          },
        },
      },
    },
  },
  statusHistory: {
    orderBy: { changedAt: 'asc' },
    include: {
      changedBy: { select: { id: true, name: true, username: true } },
    },
  },
};

const orderInclude: Prisma.OrderInclude = {
  rounds: { orderBy: { createdAt: 'asc' }, include: roundInclude },
  guests: { orderBy: { sortOrder: 'asc' } },
  user: { select: { id: true, name: true, username: true } },
  payments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      method: true,
      amount: true,
      tipAmount: true,
      tipRecipientId: true,
      status: true,
      paidAt: true,
      confirmedAt: true,
      createdAt: true,
      user: { select: { id: true, name: true, username: true } },
      confirmedBy: { select: { id: true, name: true, username: true } },
      tipRecipient: { select: { id: true, name: true, username: true } },
    },
  },
};

const kitchenInclude: Prisma.OrderRoundInclude = {
  items: { include: { extras: true, options: true, exclusions: true } },
  order: {
    select: {
      id: true,
      tableNumber: true,
      isTakeaway: true,
      channel: true,
      customerName: true,
      customerPhone: true,
      deliveryAddress: true,
      status: true,
      total: true,
      createdAt: true,
      ticketNumber: true,
      branch: { select: { id: true, name: true } },
    },
  },
};

export interface OrderFilters {
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export interface ConsumptionWarning {
  ingredientId: string;
  name: string;
  stockAfter: string;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrdersEventsService,
    private readonly analytics: AnalyticsService,
    private readonly kitchen: KitchenService,
    private readonly kitchenTicketing: KitchenTicketingService,
    private readonly splits: OrderSplitsService,
    private readonly tickets: TicketSequenceService,
  ) {}

  // --------------------------------------------------------------------------
  // Cuentas (pedidos)
  // --------------------------------------------------------------------------

  async create(
    organizationId: string | null,
    userId: string,
    dto: CreateOrderDto,
    branchId: string | null = null,
  ) {
    const idempotencyKey = dto.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where: { idempotencyKey },
        include: orderInclude,
      });

      if (existing) {
        if (existing.organizationId !== organizationId) {
          throw new ConflictException('La clave de idempotencia ya está en uso');
        }

        return { ...existing, duplicated: true };
      }
    }

    // La sucursal es obligatoria para abrir una cuenta: de ella dependen el
    // consecutivo diario, la caja y los reportes. Si la petición no trae
    // sucursal, se resuelve la única activa del negocio.
    const scopedBranchId =
      branchId ?? (await this.resolveSingleBranch(organizationId));

    if (!scopedBranchId) {
      throw new BadRequestException(
        'Selecciona una sucursal para abrir la cuenta.',
      );
    }

    // Reconciliación offline: dos dispositivos pueden haber abierto una cuenta
    // para la misma mesa sin red. Al sincronizar, la ronda se une a la cuenta
    // que ya está abierta en el servidor en lugar de abrir una segunda.
    const requestedChannel =
      dto.channel ??
      (dto.isTakeaway ? OrderChannel.COUNTER : OrderChannel.DINE_IN);

    const requestedTable = dto.tableNumber?.trim();

    if (
      dto.reuseOpenTable &&
      requestedChannel === OrderChannel.DINE_IN &&
      requestedTable
    ) {
      const openOrder = await this.prisma.order.findFirst({
        where: {
          organizationId,
          branchId: scopedBranchId,
          status: OrderStatus.OPEN,
          channel: OrderChannel.DINE_IN,
          tableNumber: requestedTable,
        },
        include: orderInclude,
        orderBy: { createdAt: 'asc' },
      });

      if (openOrder) {
        return { ...openOrder, reconciled: true };
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const actor = await tx.membership.findFirst({
        where: {
          userId,
          ...(organizationId ? { organizationId } : {}),
        },
        select: {
          username: true,
          user: { select: { name: true } },
        },
      });
      const servedByName =
        actor?.user.name?.trim() || actor?.username?.trim() || null;

      const channel =
        dto.channel ??
        (dto.isTakeaway ? OrderChannel.COUNTER : OrderChannel.DINE_IN);

      if (channel === OrderChannel.DELIVERY && !dto.deliveryAddress?.trim()) {
        throw new BadRequestException(
          'La dirección es obligatoria para un pedido a domicilio',
        );
      }

      if (
        (channel === OrderChannel.DELIVERY ||
          channel === OrderChannel.PHONE) &&
        !dto.customerPhone?.trim()
      ) {
        throw new BadRequestException(
          'El teléfono del cliente es obligatorio para teléfono o domicilio',
        );
      }

      const ticket = await this.tickets.next(scopedBranchId, new Date(), tx);
      const deliveryFee = new Prisma.Decimal(dto.deliveryFee ?? 0).toDecimalPlaces(
        2,
      );
      const guestInputs = (dto.guests ?? []).map((raw) => ({
        name: raw.name?.trim() ?? '',
        title: raw.title ?? null,
        sex: raw.sex ?? null,
        ageRange: raw.ageRange ?? null,
      }));
      const guestNames: string[] = [];

      for (const guest of guestInputs) {
        if (!guest.name) continue;

        if (
          guestNames.some(
            (entry) => entry.toLowerCase() === guest.name.toLowerCase(),
          )
        ) {
          throw new BadRequestException(
            `El cliente "${guest.name}" está repetido en la cuenta`,
          );
        }

        guestNames.push(guest.name);
      }

      const partySize = Math.min(
        20,
        Math.max(1, dto.partySize ?? guestInputs.length, guestInputs.length),
      );

      const order = await tx.order.create({
        data: {
          organizationId: organizationId ?? undefined,
          branchId: scopedBranchId,
          userId,
          channel,
          partySize,
          tableNumber:
            channel === OrderChannel.DINE_IN
              ? dto.tableNumber?.trim() || null
              : null,
          isTakeaway:
            dto.isTakeaway ??
            (channel === OrderChannel.COUNTER ||
              channel === OrderChannel.PHONE ||
              channel === OrderChannel.DELIVERY),
          customerName: dto.customerName?.trim() || null,
          customerPhone: dto.customerPhone?.trim() || null,
          deliveryAddress: dto.deliveryAddress?.trim() || null,
          deliveryFee,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
          ticketNumber: ticket.number,
          ticketUid: ticket.uid,
          servedByName,
          total: deliveryFee,
          subtotal: deliveryFee,
          idempotencyKey,
          ...(guestInputs.length > 0
            ? {
                guests: {
                  create: guestInputs.map((guest, index) => ({
                    name: guest.name,
                    title: guest.title,
                    sex: guest.sex,
                    ageRange: guest.ageRange,
                    sortOrder: index,
                  })),
                },
              }
            : {}),
        },
        include: orderInclude,
      });

      return order;
    });

    this.events.publish({
      type: 'ORDER_CREATED',
      organizationId,
      branchId: created.branchId,
      orderId: created.id,
    });

    return created;
  }

  list(
    organizationId: string | null,
    filters: OrderFilters = {},
    branchId: string | null = null,
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    return this.prisma.order
      .findMany({
        where: {
          organizationId: organizationId ?? undefined,
          ...(branchId ? { branchId } : {}),
          ...(filters.status ? { status: filters.status } : {}),
        },
        include: {
          branch: { select: { id: true, name: true } },
          user: { select: { id: true, name: true, username: true } },
          guests: { orderBy: { sortOrder: 'asc' } },
          payments: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              method: true,
              amount: true,
              tipAmount: true,
              tipRecipientId: true,
              status: true,
              paidAt: true,
              confirmedAt: true,
              createdAt: true,
              user: { select: { id: true, name: true, username: true } },
              confirmedBy: { select: { id: true, name: true, username: true } },
              tipRecipient: { select: { id: true, name: true, username: true } },
            },
          },
          rounds: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              status: true,
              sentAt: true,
              createdAt: true,
              _count: { select: { items: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      })
      .then((orders) => orders.map((order) => this.withBalance(order)));
  }

  async get(organizationId: string | null, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: orderInclude,
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return this.withBalance(order);
  }

  /**
   * Resumen mínimo para el diálogo de cobro.
   *
   * Evita el detalle completo (historial, extras, opciones, exclusiones y
   * usuarios de pago): el repaso solo necesita nombres, cantidades e importes.
   */
  async chargeSummary(organizationId: string | null, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        id: true,
        tableNumber: true,
        partySize: true,
        channel: true,
        customerName: true,
        total: true,
        subtotal: true,
        taxTotal: true,
        deliveryFee: true,
        guests: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            title: true,
            sex: true,
            ageRange: true,
            sortOrder: true,
          },
        },
        rounds: {
          where: { status: { not: OrderRoundStatus.CANCELLED } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            items: {
              select: {
                id: true,
                itemName: true,
                variantName: true,
                quantity: true,
                subtotal: true,
                guestId: true,
                guestName: true,
                notes: true,
              },
            },
          },
        },
        payments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            amount: true,
            tipAmount: true,
            status: true,
            method: true,
            splitId: true,
            provider: true,
            createdAt: true,
            confirmedAt: true,
          },
        },
        splits: {
          where: { status: { not: SplitStatus.CANCELLED } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            label: true,
            mode: true,
            status: true,
            guestId: true,
            expectedAmount: true,
            sortOrder: true,
            guest: { select: { name: true } },
            payments: {
              where: {
                status: {
                  in: [PaymentStatus.PENDING, PaymentStatus.CONFIRMED],
                },
              },
              select: { amount: true, status: true },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    const paid = order.payments
      .filter((payment) => payment.status === PaymentStatus.CONFIRMED)
      .reduce(
        (sum, payment) => sum.plus(payment.amount),
        new Prisma.Decimal(0),
      );

    return {
      id: order.id,
      tableNumber: order.tableNumber,
      partySize: order.partySize,
      channel: order.channel,
      customerName: order.customerName,
      total: order.total.toFixed(2),
      subtotal: order.subtotal.toFixed(2),
      taxTotal: order.taxTotal.toFixed(2),
      deliveryFee: order.deliveryFee.toFixed(2),
      paidTotal: paid.toFixed(2),
      balance: order.total.minus(paid).toFixed(2),
      payments: order.payments.map((payment) => ({
        id: payment.id,
        method: payment.method,
        amount: payment.amount.toFixed(2),
        tipAmount: payment.tipAmount.toFixed(2),
        status: payment.status,
        splitId: payment.splitId,
        provider: payment.provider,
        createdAt: payment.createdAt.toISOString(),
        confirmedAt: payment.confirmedAt?.toISOString() ?? null,
      })),
      guests: order.guests,
      rounds: order.rounds,
      splits: order.splits.map((split) => {
        const splitPaid = split.payments
          .filter((payment) => payment.status === PaymentStatus.CONFIRMED)
          .reduce(
            (sum, payment) => sum + Number(payment.amount),
            0,
          );
        const splitPending = split.payments
          .filter((payment) => payment.status === PaymentStatus.PENDING)
          .reduce(
            (sum, payment) => sum + Number(payment.amount),
            0,
          );
        const expected = Number(split.expectedAmount);

        return {
          id: split.id,
          label: split.label,
          mode: split.mode,
          status:
            splitPaid + 0.004 >= expected
              ? SplitStatus.PAID
              : split.status,
          guestId: split.guestId,
          guestName: split.guest?.name ?? null,
          expectedAmount: expected,
          paidAmount: Math.round(splitPaid * 100) / 100,
          pendingAmount: Math.round(splitPending * 100) / 100,
          remainingAmount:
            Math.max(0, Math.round((expected - splitPaid) * 100) / 100),
          sortOrder: split.sortOrder,
        };
      }),
    };
  }

  // --------------------------------------------------------------------------
  // Rondas (comandas)
  // --------------------------------------------------------------------------

  async sendRound(
    organizationId: string | null,
    userId: string,
    orderId: string,
    dto: SendRoundDto,
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('El pedido ya no está abierto');
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = await this.prisma.orderRound.findUnique({
        where: { idempotencyKey },
        include: roundInclude,
      });

      if (existing) {
        if (existing.orderId !== orderId) {
          throw new ConflictException('La clave de idempotencia ya está en uso');
        }

        return { ...existing, duplicated: true };
      }
    }

    // La tasa del negocio es la que se aplica salvo que el artículo tenga una
    // propia (importaciones antiguas). Se lee una vez por ronda.
    const organization = organizationId ? await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { taxRate: true },
    }) : { taxRate: new Prisma.Decimal(0) };

    const branch = order.branchId
      ? await this.prisma.branch.findUnique({
          where: { id: order.branchId },
          select: { id: true, kitchenMode: true },
        })
      : null;
    const advanced = branch?.kitchenMode === KitchenMode.ADVANCED;
    const hold = advanced && dto.hold === true;

    let courseId: string | null = null;

    if (dto.courseId) {
      if (!advanced) {
        throw new BadRequestException(
          'Los cursos solo están disponibles en cocina Avanzada',
        );
      }

      if (!organizationId) {
        throw new BadRequestException('La sesión no tiene un negocio activo');
      }

      const course = await this.prisma.kitchenCourse.findFirst({
        where: {
          id: dto.courseId,
          organizationId,
          isActive: true,
        },
        select: { id: true },
      });

      if (!course) throw new NotFoundException('Curso no encontrado');
      courseId = course.id;
    }

    const initialStatus = hold
      ? OrderRoundStatus.HELD
      : advanced
        ? OrderRoundStatus.FIRED
        : OrderRoundStatus.PENDING;

    const { items, selections } = await this.buildItems(
      organizationId,
      dto.items,
      organization.taxRate,
    );

    const guestRows = dto.items.some((line) => line.guestId)
      ? await this.prisma.orderGuest.findMany({
          where: { orderId },
          select: { id: true, name: true },
        })
      : [];
    const guestById = new Map(guestRows.map((guest) => [guest.id, guest.name]));

    for (const line of dto.items) {
      if (line.guestId && !guestById.has(line.guestId)) {
        throw new BadRequestException(
          'El cliente indicado no pertenece a esta cuenta',
        );
      }
    }

    const itemsWithGuest = items.map((row) => ({
      ...row,
      guestName: row.guestId ? guestById.get(row.guestId) ?? null : null,
    }));

    // Snapshot del estimado: si mañana cambian los tiempos del catálogo, el
    // histórico de esta ronda no se reescribe.
    const estimatedMinutes = await this.estimateForLines(
      organizationId,
      order.branchId,
      dto.items,
    );

    const round = await this.prisma.$transaction(async (tx) => {
      const created = await tx.orderRound.create({
        data: {
          orderId,
          status: initialStatus,
          courseId,
          heldAt: hold ? new Date() : null,
          firedAt: advanced && !hold ? new Date() : null,
          sentAt: new Date(),
          idempotencyKey,
          estimatedMinutes,
          items: { create: itemsWithGuest },
        },
        include: roundInclude,
      });

      if (!hold) {
        await this.kitchenTicketing.createForRound(tx, {
          organizationId,
          branchId: order.branchId,
          roundId: created.id,
          items: created.items.map((item) => ({
            id: item.id,
            itemId: item.itemId,
          })),
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderRoundId: created.id,
          previousStatus: null,
          newStatus: initialStatus,
          changedById: userId,
          reason: hold ? 'Ronda retenida para un curso' : 'Ronda enviada a cocina',
        },
      });

      await this.recalculateTotals(tx, orderId);

      // Si la cuenta ya estaba dividida, lo nuevo se cobra en una parte
      // adicional para no recalcular importes que el cliente ya pagó.
      const roundAmount = itemsWithGuest.reduce(
        (sum, item) => sum.plus(item.subtotal),
        new Prisma.Decimal(0),
      );
      await this.splits.addRoundShare(
        tx,
        orderId,
        created.id,
        `Adicional · Ronda ${created.id.slice(-4)}`,
        roundAmount,
      );

      return created;
    });

    this.events.publish({
      type: 'ROUND_CREATED',
      organizationId,
      branchId: order.branchId,
      orderId,
      roundId: round.id,
      status: round.status,
    });

    const orderLabel =
      order.channel === OrderChannel.DELIVERY
        ? 'Domicilio'
        : order.channel === OrderChannel.PHONE
          ? 'Teléfono'
          : order.channel === OrderChannel.COUNTER
            ? 'Mostrador'
            : order.tableNumber
              ? `Mesa ${order.tableNumber}`
              : 'Pedido';

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.orderRoundSent,
        organizationId,
        branchId: order.branchId,
        userId,
        subjectType: 'order',
        subjectId: orderId,
        subjectName: orderLabel,
        orderId,
        amount: items.reduce(
          (sum, item) => sum.plus(item.subtotal),
          new Prisma.Decimal(0),
        ),
        metadata: {
          roundId: round.id,
          lines: items.length,
        } as Prisma.InputJsonValue,
      },
      ...items.map((item) => ({
        name: ANALYTICS_EVENTS.itemSold,
        organizationId,
        branchId: order.branchId,
        userId,
        subjectType: 'item',
        subjectId: item.itemId,
        subjectName: item.itemName,
        itemId: item.itemId,
        orderId,
        quantity: item.quantity,
        amount: item.subtotal,
        metadata: {
          roundId: round.id,
          variantName: item.variantName,
        } as Prisma.InputJsonValue,
      })),
      ...selections.map((selection) => ({
        name: ANALYTICS_EVENTS.optionGroupSelected,
        organizationId,
        branchId: order.branchId,
        userId,
        subjectType: 'optionGroup',
        subjectId: selection.groupId,
        subjectName: selection.groupName,
        itemId: selection.itemId,
        orderId,
        quantity: selection.quantity,
        metadata: {
          roundId: round.id,
          valueId: selection.valueId,
          valueName: selection.valueName,
          isDefault: selection.isDefault,
        } as Prisma.InputJsonValue,
      })),
      ...selections.map((selection) => ({
        name: ANALYTICS_EVENTS.optionValueSelected,
        organizationId,
        branchId: order.branchId,
        userId,
        subjectType: 'optionValue',
        subjectId: selection.valueId,
        subjectName: selection.valueName,
        itemId: selection.itemId,
        orderId,
        quantity: selection.quantity,
        metadata: {
          roundId: round.id,
          groupId: selection.groupId,
          groupName: selection.groupName,
          isDefault: selection.isDefault,
        } as Prisma.InputJsonValue,
      })),
    ]);

    return round;
  }

  /**
   * Cambia el estado de una ronda.
   *
   * - `PENDING → PREPARING` descuenta inventario de forma atómica e idempotente.
   * - Cancelar después de empezar la preparación **no** devuelve stock
   *   automáticamente (`plan.md` §6.6): se corrige con un ajuste auditado.
   */
  /**
   * Dispara una ronda retenida (HELD) en modo Avanzado.
   *
   * Crea los tickets por estación y deja la ronda en FIRED. Lo puede hacer el
   * mesero o el chef; la estación se resuelve con el ruteo configurado.
   */
  async fireRound(user: JwtUser, roundId: string) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const round = await this.prisma.orderRound.findFirst({
      where: {
        id: roundId,
        order: { organizationId: user.organizationId },
      },
      include: {
        order: {
          select: {
            id: true,
            branchId: true,
            tableNumber: true,
            isTakeaway: true,
            status: true,
          },
        },
        items: { select: { id: true, itemId: true } },
      },
    });

    if (!round) throw new NotFoundException('Ronda no encontrada');

    if (round.status !== OrderRoundStatus.HELD) {
      throw new BadRequestException('La ronda no está retenida');
    }

    if (!round.order.branchId) {
      throw new BadRequestException('La ronda no tiene sucursal');
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: round.order.branchId },
      select: { kitchenMode: true },
    });

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) {
      throw new BadRequestException('La sucursal no usa cocina Avanzada');
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.orderRound.updateMany({
        where: { id: roundId, status: OrderRoundStatus.HELD },
        data: {
          status: OrderRoundStatus.FIRED,
          firedAt: now,
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException('La ronda ya cambió de estado');
      }

      await this.kitchenTicketing.createForRound(tx, {
        organizationId: user.organizationId,
        branchId: round.order.branchId,
        roundId,
        items: round.items.map((item) => ({
          id: item.id,
          itemId: item.itemId,
        })),
      });

      await tx.orderStatusHistory.create({
        data: {
          orderRoundId: roundId,
          previousStatus: OrderRoundStatus.HELD,
          newStatus: OrderRoundStatus.FIRED,
          changedById: user.sub,
          reason: 'Curso disparado',
        },
      });

      return tx.orderRound.findUniqueOrThrow({
        where: { id: roundId },
        include: roundInclude,
      });
    });

    this.events.publish({
      type: 'ROUND_UPDATED',
      organizationId: user.organizationId,
      branchId: round.order.branchId,
      orderId: round.order.id,
      roundId,
      status: OrderRoundStatus.FIRED,
    });

    return updated;
  }

  async transitionRound(
    organizationId: string | null,
    userId: string,
    orderId: string,
    roundId: string,
    dto: TransitionRoundDto,
  ) {    const order = await this.getOrderRow(organizationId, orderId);

    if (order.branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: order.branchId },
        select: { kitchenMode: true },
      });

      if (branch?.kitchenMode === KitchenMode.ADVANCED) {
        throw new BadRequestException(
          'El modo Avanzado se opera por estación. Usa el tablero de tickets.',
        );
      }
    }

    const round = await this.prisma.orderRound.findFirst({
      where: { id: roundId, orderId },
      select: { id: true, status: true },
    });

    if (!round) {
      throw new NotFoundException('Ronda no encontrada');
    }

    if (!ALLOWED_TRANSITIONS[round.status].includes(dto.status)) {
      throw new BadRequestException(
        `No se puede pasar de ${round.status} a ${dto.status}`,
      );
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // Guarda contra dobles clics / reintentos: solo una petición gana.
      const claimed = await tx.orderRound.updateMany({
        where: { id: roundId, orderId, status: round.status },
        data: {
          status: dto.status,
          ...(dto.status === OrderRoundStatus.PREPARING
            ? { startedAt: now }
            : {}),
          ...(dto.status === OrderRoundStatus.READY ? { readyAt: now } : {}),
          ...(dto.status === OrderRoundStatus.DELIVERED
            ? { deliveredAt: now }
            : {}),
          ...(dto.status === OrderRoundStatus.CANCELLED
            ? { cancelledAt: now }
            : {}),
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException(
          'La ronda ya cambió de estado; recarga el tablero',
        );
      }

      const warnings =
        dto.status === OrderRoundStatus.PREPARING
          ? await this.consumeRound(tx, organizationId, userId, order, roundId)
          : [];

      await tx.orderStatusHistory.create({
        data: {
          orderRoundId: roundId,
          previousStatus: round.status,
          newStatus: dto.status,
          changedById: userId,
          reason: dto.reason?.trim() || null,
        },
      });

      await this.recalculateTotals(tx, orderId);

      const updated = await tx.orderRound.findUniqueOrThrow({
        where: { id: roundId },
        include: roundInclude,
      });

      return { updated, warnings };
    });

    this.events.publish({
      type: 'ROUND_UPDATED',
      organizationId,
      branchId: order.branchId,
      orderId,
      roundId,
      status: dto.status,
    });

    return { ...result.updated, warnings: result.warnings };
  }

  async cancelOrder(
    organizationId: string | null,
    userId: string,
    orderId: string,
    dto: CancelOrderDto = {},
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('Solo se puede cancelar un pedido abierto');
    }

    // Una cuenta con dinero confirmado no se cancela: primero se reembolsa el
    // pago (acción auditada) y después se cancela la cuenta.
    const confirmedPayments = await this.prisma.payment.count({
      where: { orderId, status: PaymentStatus.CONFIRMED },
    });

    if (confirmedPayments > 0) {
      throw new BadRequestException(
        'La cuenta tiene pagos confirmados; reembólsalos antes de cancelarla',
      );
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const rounds = await tx.orderRound.findMany({
        where: { orderId, status: { in: OPEN_ROUND_STATUSES } },
        select: { id: true, status: true },
      });

      if (rounds.length > 0 && !dto.reason?.trim()) {
        throw new BadRequestException(
          'Explica el motivo de la cancelación: la cuenta ya tiene comandas enviadas',
        );
      }

      for (const round of rounds) {
        await tx.orderRound.update({
          where: { id: round.id },
          data: { status: OrderRoundStatus.CANCELLED, cancelledAt: now },
        });

        await tx.orderStatusHistory.create({
          data: {
            orderRoundId: round.id,
            previousStatus: round.status,
            newStatus: OrderRoundStatus.CANCELLED,
            changedById: userId,
            reason: dto.reason?.trim() || 'Pedido cancelado',
          },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED },
      });

      // Los pagos pendientes de una cuenta cancelada no pueden confirmarse
      // después: se anulan en la misma transacción para que la caja no quede
      // con cobros "fantasma".
      await tx.payment.updateMany({
        where: { orderId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELLED },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'order.cancelled',
          entity: 'Order',
          entityId: orderId,
          newValues: {
            reason: dto.reason?.trim() || null,
            rounds: rounds.length,
            total: order.total.toFixed(2),
          },
        },
      });
    });

    this.events.publish({
      type: 'ORDER_CANCELLED',
      organizationId,
      branchId: order.branchId,
      orderId,
    });

    return this.get(organizationId, orderId);
  }

  /** Añade una persona a la cuenta para pedir por comensal. */
  async addGuest(
    organizationId: string | null,
    orderId: string,
    dto: OrderGuestDto,
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    const name = dto.name?.trim() ?? '';
    const guests = await this.prisma.orderGuest.findMany({
      where: { orderId },
      select: { name: true, sortOrder: true },
    });

    if (
      name &&
      guests.some((guest) => guest.name.toLowerCase() === name.toLowerCase())
    ) {
      throw new BadRequestException(`Ya existe un cliente llamado "${name}"`);
    }

    const sortOrder =
      guests.reduce((max, guest) => Math.max(max, guest.sortOrder), -1) + 1;

    return this.prisma.$transaction(async (tx) => {
      const guest = await tx.orderGuest.create({
        data: {
          orderId,
          name,
          title: dto.title ?? null,
          sex: dto.sex ?? null,
          ageRange: dto.ageRange ?? null,
          sortOrder,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          partySize: Math.min(
            20,
            Math.max(order.partySize, guests.length) + 1,
          ),
        },
      });

      return guest;
    });
  }

  /** Edita el nombre y/o el tratamiento de una persona. */
  async renameGuest(
    organizationId: string | null,
    orderId: string,
    guestId: string,
    dto: OrderGuestDto,
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    const guest = await this.prisma.orderGuest.findFirst({
      where: { id: guestId, orderId },
    });

    if (!guest) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const name = dto.name === undefined ? guest.name : dto.name.trim();
    const title = dto.title === undefined ? guest.title : dto.title;
    const sex = dto.sex === undefined ? guest.sex : dto.sex;
    const ageRange =
      dto.ageRange === undefined ? guest.ageRange : dto.ageRange;

    if (name) {
      const others = await this.prisma.orderGuest.findMany({
        where: { orderId, NOT: { id: guestId } },
        select: { name: true },
      });

      if (
        others.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
      ) {
        throw new BadRequestException(
          `Ya existe un cliente llamado "${name}"`,
        );
      }
    }

    if (
      name === guest.name &&
      title === guest.title &&
      sex === guest.sex &&
      ageRange === guest.ageRange
    ) {
      return guest;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.orderGuest.update({
        where: { id: guestId },
        data: {
          ...(name === guest.name ? {} : { name }),
          ...(title === guest.title ? {} : { title }),
          ...(sex === guest.sex ? {} : { sex }),
          ...(ageRange === guest.ageRange ? {} : { ageRange }),
        },
      });

      if (name !== guest.name) {
        await tx.orderItem.updateMany({
          where: { guestId },
          data: { guestName: name },
        });
      }

      return updated;
    });
  }

  /** Quita una persona; sus líneas conservan el nombre como snapshot. */
  async removeGuest(
    organizationId: string | null,
    orderId: string,
    guestId: string,
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    if (order.partySize <= 1) {
      throw new BadRequestException(
        'La mesa debe tener al menos un cliente',
      );
    }

    const guest = await this.prisma.orderGuest.findFirst({
      where: { id: guestId, orderId },
    });

    if (!guest) {
      throw new NotFoundException('Cliente no encontrado');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderGuest.delete({ where: { id: guestId } });
      await tx.order.update({
        where: { id: orderId },
        data: { partySize: Math.max(1, order.partySize - 1) },
      });
    });

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Cocina
  // --------------------------------------------------------------------------

  kitchenRounds(organizationId: string | null, branchId: string | null = null) {
    return this.enrichedKitchenRounds(organizationId, branchId);
  }

  /** Modo efectivo de la sucursal (para POS y cocina). */
  async kitchenMode(user: JwtUser, branchId: string | null) {
    if (!user.organizationId) return { mode: KitchenMode.GENERAL };

    const effectiveBranchId = branchId ?? user.branchId ?? null;

    if (!effectiveBranchId) return { mode: KitchenMode.GENERAL };

    const branch = await this.prisma.branch.findFirst({
      where: { id: effectiveBranchId, organizationId: user.organizationId },
      select: { kitchenMode: true },
    });

    return { mode: branch?.kitchenMode ?? KitchenMode.GENERAL };
  }

  /** Cursos activos de la sucursal (modo Avanzado). */
  async kitchenCourses(user: JwtUser, branchId: string | null) {
    if (!user.organizationId) return [];

    const effectiveBranchId = branchId ?? user.branchId ?? null;

    if (!effectiveBranchId) return [];

    const branch = await this.prisma.branch.findFirst({
      where: { id: effectiveBranchId, organizationId: user.organizationId },
      select: { kitchenMode: true },
    });

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) return [];

    return this.prisma.kitchenCourse.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, sortOrder: true },
    });
  }

  /** Estaciones activas para configurar el ruteo de un artículo. */
  async kitchenStations(user: JwtUser, branchId: string | null) {
    if (!user.organizationId) return [];

    const effectiveBranchId = branchId ?? user.branchId ?? null;

    if (!effectiveBranchId) return [];

    return this.prisma.kitchenStation.findMany({
      where: {
        organizationId: user.organizationId,
        branchId: effectiveBranchId,
        isActive: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, type: true, color: true },
    });
  }

  /**
   * Tablero de tickets por estación (modo Avanzado).
   *
   * El alcance se resuelve en el servidor: ADMIN y meseros ven todo; un
   * `KITCHEN` con posición ve `kitchen.view.all` o solo sus estaciones.
   */
  async kitchenTickets(user: JwtUser, branchId: string | null) {
    const organizationId = user.organizationId;

    if (!organizationId) {
      return { mode: KitchenMode.GENERAL, stations: [], tickets: [], heldRounds: [] };
    }

    const effectiveBranchId = branchId ?? user.branchId ?? null;

    if (!effectiveBranchId) {
      return { mode: KitchenMode.GENERAL, stations: [], tickets: [], heldRounds: [] };
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: effectiveBranchId, organizationId },
      select: { id: true, kitchenMode: true },
    });

    if (!branch || branch.kitchenMode !== KitchenMode.ADVANCED) {
      return {
        mode: branch?.kitchenMode ?? KitchenMode.GENERAL,
        stations: [],
        tickets: [],
      };
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: user.sub, organizationId },
      },
      select: {
        id: true,
        kitchenPositionId: true,
        kitchenPosition: { select: { permissions: true } },
        kitchenAssignments: { select: { stationId: true } },
      },
    });

    const positionPermissions = membership?.kitchenPosition?.permissions ?? [];
    const isAdmin = user.roles.includes(Role.ADMIN);
    const isWaiter = user.roles.includes(Role.WAITER);
    const canViewAll =
      isAdmin || isWaiter || positionPermissions.includes('kitchen.view.all');

    if (!canViewAll && !membership?.kitchenPositionId) {
      return { mode: KitchenMode.ADVANCED, stations: [], tickets: [], heldRounds: [] };
    }

    const stationIds = canViewAll
      ? undefined
      : membership?.kitchenAssignments.map((assignment) => assignment.stationId) ??
        [];

    if (stationIds && stationIds.length === 0) {
      return { mode: KitchenMode.ADVANCED, stations: [], tickets: [], heldRounds: [] };
    }

    const [stations, tickets, heldRounds] = await Promise.all([
      this.prisma.kitchenStation.findMany({
        where: {
          organizationId,
          branchId: branch.id,
          isActive: true,
          ...(stationIds ? { id: { in: stationIds } } : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          code: true,
          color: true,
          type: true,
          sortOrder: true,
        },
      }),
      this.prisma.kitchenTicket.findMany({
        where: {
          organizationId,
          branchId: branch.id,
          status: {
            in: [
              KitchenTicketStatus.PENDING,
              KitchenTicketStatus.PREPARING,
              KitchenTicketStatus.READY,
              KitchenTicketStatus.PICKED_UP,
            ],
          },
          ...(stationIds ? { stationId: { in: stationIds } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }],
        include: kitchenTicketInclude,
      }),
      this.prisma.orderRound.findMany({
        where: {
          status: OrderRoundStatus.HELD,
          order: {
            organizationId,
            branchId: branch.id,
            status: OrderStatus.OPEN,
          },
        },
        orderBy: [{ createdAt: 'asc' }],
        select: {
          id: true,
          createdAt: true,
          sentAt: true,
          course: { select: { id: true, name: true } },
          order: {
            select: {
              id: true,
              tableNumber: true,
              channel: true,
              customerName: true,
            },
          },
          items: {
            select: {
              id: true,
              itemName: true,
              variantName: true,
              quantity: true,
              notes: true,
            },
          },
        },
      }),
    ]);

    return { mode: KitchenMode.ADVANCED, stations, tickets, heldRounds };
  }

  /**
   * Cambia el estado de un ticket de estación.
   *
   * - Cocina (KITCHEN) inicia y marca listo en sus estaciones.
   * - El mesero (WAITER) recoge en el pase y entrega en la mesa.
   * - El agregado de la ronda se recalcula después de cada cambio.
   */
  async transitionKitchenTicket(
    user: JwtUser,
    ticketId: string,
    dto: TransitionKitchenTicketDto,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id: ticketId, organizationId: user.organizationId },
      include: {
        station: { select: { id: true, name: true } },
        items: { select: { orderItemId: true } },
        orderRound: {
          select: {
            id: true,
            orderId: true,
            order: {
              select: {
                tableNumber: true,
                isTakeaway: true,
                branchId: true,
              },
            },
          },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const branch = ticket.branchId
      ? await this.prisma.branch.findFirst({
          where: { id: ticket.branchId, organizationId: user.organizationId },
          select: { kitchenMode: true },
        })
      : null;

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) {
      throw new BadRequestException(
        'El ticket pertenece a una sucursal en modo General',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: user.sub,
          organizationId: user.organizationId,
        },
      },
      select: {
        id: true,
        kitchenPositionId: true,
        kitchenPosition: { select: { permissions: true } },
        kitchenAssignments: { select: { stationId: true } },
      },
    });

    const positionPermissions = membership?.kitchenPosition?.permissions ?? [];
    const isAdmin = user.roles.includes(Role.ADMIN);
    const isWaiter = user.roles.includes(Role.WAITER);
    const isPickup =
      dto.status === KitchenTicketStatus.PICKED_UP ||
      dto.status === KitchenTicketStatus.DELIVERED;

    if (isPickup) {
      const allowed =
        isAdmin ||
        isWaiter ||
        (dto.status === KitchenTicketStatus.PICKED_UP
          ? positionPermissions.includes('kitchen.pickup')
          : positionPermissions.includes('kitchen.deliver'));

      if (!allowed) {
        throw new ForbiddenException(
          'Solo el mesero puede recoger o entregar un ticket',
        );
      }
    } else {
      const allowed =
        isAdmin ||
        (dto.status === KitchenTicketStatus.PREPARING &&
          positionPermissions.includes('kitchen.transition.start')) ||
        (dto.status === KitchenTicketStatus.READY &&
          (positionPermissions.includes('kitchen.transition.ready') ||
            positionPermissions.includes('kitchen.expo'))) ||
        (dto.status === KitchenTicketStatus.CANCELLED &&
          positionPermissions.includes('kitchen.void'));

      if (!allowed) {
        throw new ForbiddenException(
          'No tienes permiso para operar este ticket',
        );
      }

      if (
        !isAdmin &&
        !positionPermissions.includes('kitchen.view.all')
      ) {
        if (!membership?.kitchenPositionId) {
          throw new ForbiddenException(
            'Configura tu puesto de cocina para operar estaciones',
          );
        }

        const assigned = membership.kitchenAssignments.some(
          (assignment) => assignment.stationId === ticket.stationId,
        );

        if (!assigned) {
          throw new ForbiddenException(
            'Este ticket pertenece a otra estación',
          );
        }
      }
    }

    if (!TICKET_TRANSITIONS[ticket.status].includes(dto.status)) {
      throw new BadRequestException(
        `No se puede pasar de ${ticket.status} a ${dto.status}`,
      );
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.kitchenTicket.updateMany({
        where: { id: ticketId, status: ticket.status },
        data: {
          status: dto.status,
          ...(dto.status === KitchenTicketStatus.PREPARING
            ? { startedAt: now }
            : {}),
          ...(dto.status === KitchenTicketStatus.READY
            ? { readyAt: now }
            : {}),
          ...(dto.status === KitchenTicketStatus.PICKED_UP
            ? { pickedUpAt: now }
            : {}),
          ...(dto.status === KitchenTicketStatus.DELIVERED
            ? { deliveredAt: now }
            : {}),
          ...(dto.status === KitchenTicketStatus.CANCELLED
            ? { cancelledAt: now, cancelReason: dto.reason?.trim() || null }
            : {}),
          ...(dto.status === KitchenTicketStatus.PREPARING &&
          !ticket.assignedMembershipId &&
          membership?.id
            ? { assignedMembershipId: membership.id }
            : {}),
        },
      });

      if (claimed.count === 0) {
        throw new ConflictException(
          'El ticket ya cambió de estado; recarga el tablero',
        );
      }

      const itemStatus =
        dto.status === KitchenTicketStatus.CANCELLED
          ? KitchenItemStatus.VOID
          : (dto.status as unknown as KitchenItemStatus);

      await tx.kitchenTicketItem.updateMany({
        where: { ticketId },
        data: {
          status: itemStatus,
          ...(dto.status === KitchenTicketStatus.CANCELLED
            ? { voidReason: dto.reason?.trim() || null }
            : {}),
        },
      });

      await tx.kitchenTicketHistory.create({
        data: {
          ticketId,
          previousStatus: ticket.status,
          newStatus: dto.status,
          changedById: user.sub,
          changedByName: user.email ?? user.sub,
          reason: dto.reason?.trim() || null,
        },
      });

      let warnings: ConsumptionWarning[] = [];

      if (
        dto.status === KitchenTicketStatus.PREPARING &&
        !ticket.startedAt
      ) {
        warnings = await this.consumeRound(
          tx,
          user.organizationId,
          user.sub,
          {
            tableNumber: ticket.orderRound.order.tableNumber,
            isTakeaway: ticket.orderRound.order.isTakeaway,
            branchId: ticket.orderRound.order.branchId,
          },
          ticket.orderRoundId,
          {
            orderItemIds: ticket.items.map((item) => item.orderItemId),
            dedupeScope: `ticket:${ticketId}`,
          },
        );
      }

      const roundStatus = await this.syncRoundFromTickets(
        tx,
        ticket.orderRoundId,
        user.sub,
      );

      const updated = await tx.kitchenTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: kitchenTicketInclude,
      });

      return { updated, warnings, roundStatus };
    });

    this.events.publish({
      type: 'ROUND_UPDATED',
      organizationId: user.organizationId,
      branchId: ticket.branchId,
      orderId: ticket.orderRound.orderId,
      roundId: ticket.orderRoundId,
      status: result.roundStatus ?? undefined,
    });

    return {
      ...result.updated,
      warnings: result.warnings,
      roundStatus: result.roundStatus,
    };
  }

  /**
   * Valida un ticket en el pase/expo. No cambia el estado de preparación:
   * agrega la marca de calidad y el responsable para el handoff.
   */
  async expoValidateTicket(user: JwtUser, ticketId: string) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id: ticketId, organizationId: user.organizationId },
      include: {
        station: { select: { id: true, name: true } },
        orderRound: {
          select: { id: true, orderId: true, order: { select: { branchId: true } } },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const branch = ticket.branchId
      ? await this.prisma.branch.findFirst({
          where: { id: ticket.branchId, organizationId: user.organizationId },
          select: { kitchenMode: true },
        })
      : null;

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) {
      throw new BadRequestException('La sucursal no usa cocina Avanzada');
    }

    if (ticket.expoAt) {
      return this.prisma.kitchenTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: kitchenTicketInclude,
      });
    }

    if (
      ticket.status !== KitchenTicketStatus.READY &&
      ticket.status !== KitchenTicketStatus.PICKED_UP
    ) {
      throw new BadRequestException(
        'El ticket todavía no está listo en la estación',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: user.sub,
          organizationId: user.organizationId,
        },
      },
      select: {
        id: true,
        kitchenPositionId: true,
        kitchenPosition: { select: { permissions: true } },
        kitchenAssignments: { select: { stationId: true } },
      },
    });

    const permissions = membership?.kitchenPosition?.permissions ?? [];
    const isAdmin = user.roles.includes(Role.ADMIN);
    const canExpo = isAdmin || permissions.includes('kitchen.expo');

    if (!canExpo) {
      throw new ForbiddenException(
        'No tienes permiso para validar tickets en el pase',
      );
    }

    if (
      !isAdmin &&
      !permissions.includes('kitchen.view.all') &&
      !membership?.kitchenAssignments.some(
        (assignment) => assignment.stationId === ticket.stationId,
      )
    ) {
      throw new ForbiddenException('Este ticket pertenece a otra estación');
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.kitchenTicket.update({
        where: { id: ticketId },
        data: {
          expoAt: now,
          expoValidatedById: user.sub,
          expoValidatedByName: user.email ?? user.sub,
        },
      });

      await tx.kitchenTicketHistory.create({
        data: {
          ticketId,
          previousStatus: ticket.status,
          newStatus: ticket.status,
          changedById: user.sub,
          changedByName: user.email ?? user.sub,
          reason: 'Validado en pase',
        },
      });

      return tx.kitchenTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: kitchenTicketInclude,
      });
    });

    return updated;
  }

  /** Historial detallado de un ticket (auditoría). */
  async ticketHistory(user: JwtUser, ticketId: string) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id: ticketId, organizationId: user.organizationId },
      select: { id: true, stationId: true },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    if (!user.roles.includes(Role.ADMIN) && !user.roles.includes(Role.WAITER)) {
      const membership = await this.prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: user.sub,
            organizationId: user.organizationId,
          },
        },
        select: {
          kitchenPositionId: true,
          kitchenPosition: { select: { permissions: true } },
          kitchenAssignments: { select: { stationId: true } },
        },
      });

      const permissions = membership?.kitchenPosition?.permissions ?? [];

      if (
        !membership?.kitchenPositionId ||
        (!permissions.includes('kitchen.view.all') &&
          !membership.kitchenAssignments.some(
            (assignment) => assignment.stationId === ticket.stationId,
          ))
      ) {
        throw new ForbiddenException(
          'No tienes permiso para ver el historial de este ticket',
        );
      }
    }

    return this.prisma.kitchenTicketHistory.findMany({
      where: { ticketId },
      orderBy: { changedAt: 'asc' },
    });
  }

  /**
   * Rehace un ticket de estación: crea uno nuevo con los mismos ítems en la
   * misma estación y lo deja pendiente. La ronda se recalcula sola.
   */
  async refireKitchenTicket(user: JwtUser, ticketId: string) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id: ticketId, organizationId: user.organizationId },
      include: {
        items: { select: { id: true, orderItemId: true } },
        orderRound: {
          select: {
            id: true,
            orderId: true,
            order: { select: { branchId: true } },
          },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    const branch = ticket.branchId
      ? await this.prisma.branch.findFirst({
          where: { id: ticket.branchId, organizationId: user.organizationId },
          select: { kitchenMode: true },
        })
      : null;

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) {
      throw new BadRequestException('La sucursal no usa cocina Avanzada');
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: user.sub,
          organizationId: user.organizationId,
        },
      },
      select: {
        id: true,
        kitchenPositionId: true,
        kitchenPosition: { select: { permissions: true } },
        kitchenAssignments: { select: { stationId: true } },
      },
    });

    const permissions = membership?.kitchenPosition?.permissions ?? [];
    const isAdmin = user.roles.includes(Role.ADMIN);
    const canRefire = isAdmin || permissions.includes('kitchen.refire');

    if (!canRefire) {
      throw new ForbiddenException('No tienes permiso para rehacer tickets');
    }

    if (
      !isAdmin &&
      !permissions.includes('kitchen.view.all') &&
      !membership?.kitchenAssignments.some(
        (assignment) => assignment.stationId === ticket.stationId,
      )
    ) {
      throw new ForbiddenException('Este ticket pertenece a otra estación');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const replica = await tx.kitchenTicket.create({
        data: {
          organizationId: user.organizationId!,
          branchId: ticket.branchId,
          orderRoundId: ticket.orderRoundId,
          stationId: ticket.stationId,
          status: KitchenTicketStatus.PENDING,
          items: {
            create: ticket.items.map((item) => ({
              orderItemId: item.orderItemId,
              refiredFromId: item.id,
            })),
          },
        },
        include: kitchenTicketInclude,
      });

      await tx.kitchenTicketHistory.create({
        data: {
          ticketId: replica.id,
          previousStatus: null,
          newStatus: KitchenTicketStatus.PENDING,
          changedById: user.sub,
          changedByName: user.email ?? user.sub,
          reason: 'Refire',
        },
      });

      await this.syncRoundFromTickets(tx, ticket.orderRoundId, user.sub);

      return replica;
    });

    this.events.publish({
      type: 'ROUND_UPDATED',
      organizationId: user.organizationId,
      branchId: ticket.branchId,
      orderId: ticket.orderRound.orderId,
      roundId: ticket.orderRoundId,
      status: OrderRoundStatus.PENDING,
    });

    return created;
  }

  /** Recalcula el estado agregado de la ronda a partir de sus tickets. */  private async syncRoundFromTickets(
    tx: Prisma.TransactionClient,
    roundId: string,
    userId: string,
  ) {
    const tickets = await tx.kitchenTicket.findMany({
      where: { orderRoundId: roundId },
      select: { status: true },
    });

    if (tickets.length === 0) return null;

    const statuses = tickets.map((ticket) => ticket.status);
    let next: OrderRoundStatus;

    if (
      statuses.every(
        (status) =>
          status === KitchenTicketStatus.DELIVERED ||
          status === KitchenTicketStatus.CANCELLED,
      )
    ) {
      next = statuses.every(
        (status) => status === KitchenTicketStatus.CANCELLED,
      )
        ? OrderRoundStatus.CANCELLED
        : OrderRoundStatus.DELIVERED;
    } else if (
      statuses.every((status) =>
        (
          [
            KitchenTicketStatus.READY,
            KitchenTicketStatus.PICKED_UP,
            KitchenTicketStatus.DELIVERED,
            KitchenTicketStatus.CANCELLED,
          ] as KitchenTicketStatus[]
        ).includes(status),
      )
    ) {
      next = OrderRoundStatus.READY;
    } else if (
      statuses.some((status) =>
        (
          [
            KitchenTicketStatus.PREPARING,
            KitchenTicketStatus.READY,
            KitchenTicketStatus.PICKED_UP,
            KitchenTicketStatus.DELIVERED,
          ] as KitchenTicketStatus[]
        ).includes(status),
      )
    ) {
      next = OrderRoundStatus.PREPARING;
    } else {
      next = OrderRoundStatus.PENDING;
    }

    const round = await tx.orderRound.findUnique({
      where: { id: roundId },
      select: { status: true },
    });

    if (!round || round.status === next) return next;

    const now = new Date();

    await tx.orderRound.update({
      where: { id: roundId },
      data: {
        status: next,
        ...(next === OrderRoundStatus.PREPARING
          ? { startedAt: now }
          : next === OrderRoundStatus.READY
            ? { readyAt: now }
            : next === OrderRoundStatus.DELIVERED
              ? { deliveredAt: now }
              : next === OrderRoundStatus.CANCELLED
                ? { cancelledAt: now }
                : {}),
      },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderRoundId: roundId,
        previousStatus: round.status,
        newStatus: next,
        changedById: userId,
        reason: 'Actualización por ticket de estación',
      },
    });

    return next;
  }

  /**
   * Rondas activas enriquecidas con el estimado y la prioridad sugerida.
   *
   * La prioridad se calcula en el servidor para que el tablero no tenga que
   * repetir las reglas; el cliente solo vuelve a pedirlas por SSE o sondeo.
   */
  private async enrichedKitchenRounds(
    organizationId: string | null,
    branchId: string | null = null,
  ) {
    const [rounds, settings] = await Promise.all([
      this.prisma.orderRound.findMany({
        where: {
          order: {
            organizationId: organizationId,
            status: OrderStatus.OPEN,
            ...(branchId ? { branchId } : {}),
          },
          status: { in: OPEN_ROUND_STATUSES },
        },
        include: kitchenInclude,
        orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.kitchen.settings(organizationId, branchId),
    ]);

    const now = Date.now();
    const enriched = rounds.map((round) => {
      const estimateMinutes =
        round.estimatedMinutes ?? settings.effectiveMinutes;
      const sentAt = round.sentAt ?? round.createdAt;
      const stageStartedAt =
        round.status === OrderRoundStatus.READY
          ? round.readyAt ?? round.startedAt ?? sentAt
          : round.status === OrderRoundStatus.PREPARING
            ? round.startedAt ?? sentAt
            : sentAt;

      const stageMinutes = Math.max(
        0,
        Math.floor((now - stageStartedAt.getTime()) / 60_000),
      );
      const waitMinutes = Math.max(
        0,
        Math.floor((now - sentAt.getTime()) / 60_000),
      );
      const items = round.items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      const actionable =
        round.status === OrderRoundStatus.PENDING ||
        round.status === OrderRoundStatus.PREPARING;
      const urgency = actionable
        ? estimateMinutes > 0
          ? stageMinutes / estimateMinutes
          : 0
        : 0;
      const priority: PrepPriority = actionable
        ? prepPriority(urgency)
        : 'on_time';
      const score = actionable
        ? Math.round(
            urgency * 100 + waitMinutes * 0.4 + items * 0.3,
          )
        : 0;
      const reasons: string[] = [];

      if (priority === 'late') {
        reasons.push(
          `Lleva ${stageMinutes} min de ${estimateMinutes} estimados`,
        );
      } else if (priority === 'at_risk') {
        reasons.push(
          `Cerca del estimado (${stageMinutes}/${estimateMinutes} min)`,
        );
      }

      if (waitMinutes >= estimateMinutes && waitMinutes > 0) {
        reasons.push(`Espera ${waitMinutes} min desde el envío`);
      }

      if (items >= 6) reasons.push(`${items} artículos`);

      return {
        ...round,
        estimateMinutes,
        estimateFromSnapshot: round.estimatedMinutes !== null,
        stageMinutes,
        waitMinutes,
        itemCount: items,
        urgency: Math.round(urgency * 100) / 100,
        priority,
        score,
        reasons,
        estimatedReadyAt: new Date(
          (round.startedAt ?? sentAt).getTime() + estimateMinutes * 60_000,
        ).toISOString(),
      };
    });

    const ranked = enriched
      .filter(
        (round) =>
          round.status === OrderRoundStatus.PENDING ||
          round.status === OrderRoundStatus.PREPARING,
      )
      .sort((left, right) => right.score - left.score);
    const rankById = new Map(
      ranked.map((round, index) => [round.id, index + 1]),
    );

    return enriched.map((round) => ({
      ...round,
      suggestedRank: rankById.get(round.id) ?? null,
    }));
  }

  /**
   * Minutos estimados de una ronda a partir de sus líneas.
   *
   * Los combos toman el máximo de sus componentes; los artículos sin tiempo
   * propio heredan el del negocio (manual o histórico ya calibrado).
   */
  private async estimateForLines(
    organizationId: string | null,
    branchId: string | null,
    lines: Array<{ itemId: string }>,
  ): Promise<number> {
    if (lines.length === 0) return DEFAULT_PREP_MINUTES;

    const fallback = await this.kitchen.fallbackMinutes(
      organizationId,
      branchId,
    );
    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, prepMinutes: true, isCombo: true },
    });
    const comboIds = items
      .filter((item) => item.isCombo)
      .map((item) => item.id);
    const components =
      comboIds.length > 0
        ? await this.prisma.comboComponent.findMany({
            where: { comboId: { in: comboIds } },
            select: {
              comboId: true,
              componentItem: { select: { prepMinutes: true } },
            },
          })
        : [];
    const comboMinutes = new Map<string, number>();

    for (const component of components) {
      const minutes = component.componentItem.prepMinutes ?? fallback;
      comboMinutes.set(
        component.comboId,
        Math.max(comboMinutes.get(component.comboId) ?? 0, minutes),
      );
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const lineMinutes = lines.map((line) => {
      const item = byId.get(line.itemId);

      if (!item) return fallback;
      if (item.prepMinutes !== null) return item.prepMinutes;
      if (item.isCombo) return comboMinutes.get(item.id) ?? fallback;

      return fallback;
    });

    return estimatePrepMinutes({
      lineMinutes,
      distinctLines: itemIds.length,
    });
  }

  // --------------------------------------------------------------------------
  // Interno
  // --------------------------------------------------------------------------

  /**
   * Añade el importe cobrado y el saldo a una cuenta.
   *
   * Solo cuentan los pagos CONFIRMADOS: un pago pendiente no reduce el saldo
   * (`plan.md` §6.8).
   */
  private withBalance<
    T extends {
      total: Prisma.Decimal;
      payments: Array<{ amount: Prisma.Decimal; status: PaymentStatus }>;
    },
  >(order: T) {
    const paid = order.payments
      .filter((payment) => payment.status === PaymentStatus.CONFIRMED)
      .reduce(
        (sum, payment) => sum.plus(payment.amount),
        new Prisma.Decimal(0),
      );

    return {
      ...order,
      paidTotal: paid.toFixed(2),
      balance: order.total.minus(paid).toFixed(2),
    };
  }

  private async getOrderRow(organizationId: string | null, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: {
        id: true,
        status: true,
        tableNumber: true,
        partySize: true,
        isTakeaway: true,
        channel: true,
        branchId: true,
        total: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return order;
  }

  /**
   * Valida líneas contra el catálogo y calcula precios e IVA.
   *
   * El precio del catálogo es final (IVA incluido), así que el importe de la
   * línea es el bruto y el IVA se extrae de él.
   */
  private async buildItems(
    organizationId: string | null,
    items: RoundItemDto[],
    defaultTaxRate: Prisma.Decimal,
  ) {
    const itemIds = [...new Set(items.map((line) => line.itemId))];

    const catalogItems = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, organizationId },
      include: {
        variants: true,
        extras: true,
        ingredientExclusions: true,
        optionGroups: {
          orderBy: { sortOrder: 'asc' },
          include: {
            group: { select: { id: true, name: true, isActive: true } },
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
              },
            },
          },
        },
        promotions: { where: { isActive: true } },
        comboComponents: {
          include: {
            componentItem: { select: { id: true, name: true, price: true } },
            variant: { select: { id: true, name: true, priceAdjust: true } },
          },
        },
      },
    });

    const byId = new Map(catalogItems.map((item) => [item.id, item]));

    const selections: Array<{
      itemId: string;
      itemName: string;
      groupId: string;
      groupName: string;
      valueId: string;
      valueName: string;
      quantity: number;
      isDefault: boolean;
    }> = [];

    const rows = items.map((line) => {
      const item = byId.get(line.itemId);

      if (!item) {
        throw new BadRequestException(
          'Uno de los artículos del pedido no existe en el catálogo',
        );
      }

      if (!item.isActive) {
        throw new BadRequestException(`${item.name} está desactivado`);
      }

      const variant = line.variantId
        ? item.variants.find((candidate) => candidate.id === line.variantId)
        : undefined;

      if (line.variantId && !variant) {
        throw new BadRequestException(
          `La variante no pertenece a ${item.name}`,
        );
      }

      if (variant && !variant.isActive) {
        throw new BadRequestException(
          `La variante ${variant.name} está desactivada`,
        );
      }

      const extras = (line.extras ?? []).map((selection) => {
        const extra = item.extras.find(
          (candidate) => candidate.id === selection.extraId,
        );

        if (!extra) {
          throw new BadRequestException(
            `El extra no pertenece a ${item.name}`,
          );
        }

        if (!extra.isActive) {
          throw new BadRequestException(
            `El extra ${extra.name} está desactivado`,
          );
        }

        return extra;
      });

      const exclusions = (line.excludedIngredientIds ?? []).map(
        (ingredientId) => {
          const allowed = item.ingredientExclusions.some(
            (exclusion) => exclusion.ingredientId === ingredientId,
          );

          if (!allowed) {
            throw new BadRequestException(
              `Ese ingrediente no se puede quitar de ${item.name}`,
            );
          }

          return { ingredientId };
        },
      );

      const quantity = line.quantity ?? 1;
      const options = this.resolveItemOptions(item, line.options ?? []);

      for (const option of options) {
        selections.push({
          itemId: item.id,
          itemName: item.name,
          groupId: option.groupId,
          groupName: option.groupName,
          valueId: option.valueId,
          valueName: option.valueName,
          quantity,
          isDefault: option.isDefault,
        });
      }

      const unitPrice = options.reduce(
        (sum, option) => sum.plus(option.priceDelta),
        extras.reduce(
          (sum, extra) => sum.plus(extra.price),
          item.price.plus(variant?.priceAdjust ?? 0),
        ),
      );

      const gross = unitPrice.times(quantity).toDecimalPlaces(2);
      const promotion = item.isCombo
        ? this.resolveComboPromotion(
            item.promotions,
            item.comboComponents,
            unitPrice,
            quantity,
          )
        : null;
      const discountAmount = promotion?.discount ?? new Prisma.Decimal(0);
      const subtotal = gross.minus(discountAmount).toDecimalPlaces(2);
      const taxRate = item.taxRate ?? defaultTaxRate;
      const taxAmount = taxRate.gt(0)
        ? subtotal.minus(subtotal.dividedBy(taxRate.plus(1))).toDecimalPlaces(2)
        : new Prisma.Decimal(0);

      return {
        itemId: item.id,
        itemVariantId: variant?.id ?? null,
        itemName: item.name,
        variantName: variant?.name ?? null,
        itemPrice: unitPrice.toDecimalPlaces(2),
        taxRate,
        taxAmount,
        quantity,
        notes: line.notes?.trim() || null,
        subtotal,
        discountAmount,
        promotionId: promotion?.id ?? null,
        promotionName: promotion?.name ?? null,
        promotionType: promotion?.type ?? null,
        guestId: line.guestId?.trim() || null,
        extras: {
          create: extras.map((extra) => ({
            itemExtraId: extra.id,
            extraName: extra.name,
            extraPrice: extra.price,
          })),
        },
        options: {
          create: options.map((option) => ({
            itemOptionValueId: option.itemOptionValueId,
            groupName: option.groupName,
            optionName: option.optionName,
            kitchenLabel: option.kitchenLabel,
            priceDelta: option.priceDelta,
          })),
        },
        exclusions: { create: exclusions },
      };
    });

    return { items: rows, selections };
  }

  /**
   * Resuelve la selección de opciones de una línea.
   *
   * Si el cliente no manda nada para un grupo se aplican las opciones por
   * defecto (lo que el POS muestra preseleccionado). Valida obligatoriedad,
   * mínimos/máximos, selección única y que cada opción pertenezca al artículo.
   */
  private resolveItemOptions(
    item: {
      name: string;
      optionGroups: Array<{
        id: string;
        isRequired: boolean;
        selection: OptionSelection;
        minSelect: number;
        maxSelect: number | null;
        group: { id: string; name: string; isActive: boolean };
        values: Array<{
          id: string;
          valueId: string | null;
          customName: string | null;
          priceDelta: Prisma.Decimal;
          isDefault: boolean;
          isActive: boolean;
          value: {
            id: string;
            name: string;
            kitchenLabel: string | null;
            isActive: boolean;
          } | null;
        }>;
      }>;
    },
    selections: RoundItemOptionDto[],
  ) {
    const available = new Map<
      string,
      {
        /** Id de la asignación grupo-artículo (para agrupar la selección). */
        assignmentId: string;
        /** Id del grupo de la biblioteca (para analítica). */
        groupId: string;
        groupName: string;
        valueId: string;
        valueName: string;
        priceDelta: Prisma.Decimal;
        isDefault: boolean;
        optionName: string;
        kitchenLabel: string | null;
      }
    >();

    for (const group of item.optionGroups) {
      if (!group.group.isActive) continue;

      // Los grupos "Sin ..." nunca suman al precio, aunque el dato histórico
      // tenga un cargo guardado.
      const noPrice = isNoPriceOptionGroup(group.group.name);

      for (const value of group.values) {
        if (!value.isActive || (value.value && !value.value.isActive)) continue;

        const valueName = value.customName ?? value.value?.name ?? 'Opción';

        available.set(value.id, {
          assignmentId: group.id,
          groupId: group.group.id,
          groupName: group.group.name,
          valueId: value.valueId ?? value.id,
          valueName,
          priceDelta: noPrice ? new Prisma.Decimal(0) : value.priceDelta,
          isDefault: value.isDefault,
          optionName: valueName,
          kitchenLabel: value.value?.kitchenLabel ?? valueName,
        });
      }
    }

    const chosenByGroup = new Map<string, string[]>();
    const seen = new Set<string>();

    for (const selection of selections) {
      if (seen.has(selection.itemOptionValueId)) {
        throw new BadRequestException(
          'Una opción no puede repetirse en la misma línea',
        );
      }
      seen.add(selection.itemOptionValueId);

      const option = available.get(selection.itemOptionValueId);

      if (!option) {
        throw new BadRequestException(
          `La opción elegida no pertenece a ${item.name}`,
        );
      }

      const current = chosenByGroup.get(option.assignmentId) ?? [];
      current.push(selection.itemOptionValueId);
      chosenByGroup.set(option.assignmentId, current);
    }

    const result: Array<{
      itemOptionValueId: string;
      groupId: string;
      groupName: string;
      valueId: string;
      valueName: string;
      optionName: string;
      kitchenLabel: string | null;
      priceDelta: Prisma.Decimal;
      isDefault: boolean;
    }> = [];

    for (const group of item.optionGroups) {
      if (!group.group.isActive) continue;

      const activeValues = group.values.filter(
        (value) => value.isActive && (!value.value || value.value.isActive),
      );
      let chosen = chosenByGroup.get(group.id) ?? [];

      if (chosen.length === 0) {
        chosen = activeValues
          .filter((value) => value.isDefault)
          .map((value) => value.id);
      }

      const maxSelect =
        group.maxSelect ??
        (group.selection === OptionSelection.SINGLE
          ? 1
          : activeValues.length);

      if (chosen.length === 0 && group.isRequired) {
        throw new BadRequestException(
          `Elige ${group.group.name} para ${item.name}`,
        );
      }

      if (group.selection === OptionSelection.SINGLE && chosen.length > 1) {
        throw new BadRequestException(
          `${group.group.name} solo admite una opción`,
        );
      }

      if (chosen.length > maxSelect) {
        throw new BadRequestException(
          `Elige como máximo ${maxSelect} opciones de ${group.group.name}`,
        );
      }

      if (chosen.length > 0 && chosen.length < group.minSelect) {
        throw new BadRequestException(
          `Elige al menos ${group.minSelect} opciones de ${group.group.name}`,
        );
      }

      for (const id of chosen) {
        const option = available.get(id);

        if (!option) {
          throw new BadRequestException(
            `La opción elegida no pertenece a ${item.name}`,
          );
        }

        result.push({
          itemOptionValueId: id,
          groupId: option.groupId,
          groupName: option.groupName,
          valueId: option.valueId,
          valueName: option.valueName,
          optionName: option.optionName,
          kitchenLabel: option.kitchenLabel,
          priceDelta: option.priceDelta,
          isDefault: option.isDefault,
        });
      }
    }

    return result;
  }

  /** Resuelve la promoción activa de un combo y calcula su descuento. */
  private resolveComboPromotion(
    promotions: Array<{
      id: string;
      name: string;
      type: PromotionType;
      value: Prisma.Decimal;
      payQuantity: number | null;
      getQuantity: number | null;
      specialPrice: Prisma.Decimal | null;
      freeItemId: string | null;
      freeVariantId: string | null;
      discountedItemId: string | null;
      discountedVariantId: string | null;
      isActive: boolean;
    }>,
    components: Array<{
      componentItemId: string;
      componentVariantId: string | null;
      componentItem: { price: Prisma.Decimal };
      variant: { priceAdjust: Prisma.Decimal } | null;
    }>,
    unitPrice: Prisma.Decimal,
    quantity: number,
  ) {
    // Solo existe una promoción por combo; la consulta ya filtra las activas.
    const promotion = promotions[0];
    if (!promotion?.isActive) return null;

    const gross = unitPrice.times(quantity);
    let discount = new Prisma.Decimal(0);

    const componentPrice = (itemId: string | null, variantId: string | null) => {
      if (!itemId) return null;

      const component = components.find(
        (candidate) =>
          candidate.componentItemId === itemId &&
          (candidate.componentVariantId ?? null) === (variantId ?? null),
      );

      if (!component) return null;

      return component.componentItem.price.plus(
        component.variant?.priceAdjust ?? 0,
      );
    };

    switch (promotion.type) {
      case PromotionType.PERCENT:
        discount = gross.times(promotion.value).dividedBy(100);
        break;

      case PromotionType.FIXED:
        discount = promotion.value.times(quantity);
        break;

      case PromotionType.BOGO:
      case PromotionType.PAY_X_GET_Y: {
        const pay =
          promotion.type === PromotionType.BOGO
            ? 1
            : (promotion.payQuantity ?? 1);
        const receive =
          promotion.type === PromotionType.BOGO
            ? 2
            : (promotion.getQuantity ?? 2);
        const groups = Math.floor(quantity / receive);
        const freeUnits = groups * (receive - pay);
        discount = unitPrice.times(Math.max(0, freeUnits));
        break;
      }

      case PromotionType.SPECIAL_PRICE: {
        if (promotion.specialPrice) {
          const difference = unitPrice.minus(promotion.specialPrice);
          if (difference.gt(0)) {
            discount = difference.times(quantity);
          }
        }
        break;
      }

      case PromotionType.FREE_ITEM: {
        const price = componentPrice(
          promotion.freeItemId,
          promotion.freeVariantId,
        );
        if (price) discount = price.times(quantity);
        break;
      }

      case PromotionType.SECOND_HALF_PRICE: {
        const price = componentPrice(
          promotion.discountedItemId,
          promotion.discountedVariantId,
        );
        if (price) discount = price.times(quantity).dividedBy(2);
        break;
      }
    }

    if (discount.gt(gross)) discount = gross;
    discount = discount.toDecimalPlaces(2);

    if (discount.lte(0)) return null;

    return {
      id: promotion.id,
      name: promotion.name,
      type: promotion.type,
      discount,
    };
  }

  /**
   * Sucursal única activa del negocio.
   *
   * Es el respaldo para sesiones que aún no eligieron sucursal (por ejemplo,
   * el dueño con una sola sucursal). Con varias sucursales se exige elegir
   * una para no abrir cuentas huérfanas.
   */
  private async resolveSingleBranch(organizationId: string | null) {
    if (!organizationId) return null;

    const branches = await this.prisma.branch.findMany({
      where: { organizationId, isActive: true },
      select: { id: true },
      take: 2,
    });

    return branches.length === 1 ? branches[0].id : null;
  }

  /** Recalcula los totales de la cuenta ignorando las rondas canceladas. */
  private async recalculateTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const [items, order] = await (async () => {
      const rows = await tx.orderItem.findMany({
        where: {
          orderRound: {
            orderId,
            status: { not: OrderRoundStatus.CANCELLED },
          },
        },
        select: { subtotal: true, taxAmount: true },
      });
      const row = await tx.order.findUnique({
        where: { id: orderId },
        select: { deliveryFee: true },
      });

      return [rows, row] as const;
    })();

    const gross = items.reduce(
      (sum, item) => sum.plus(item.subtotal),
      new Prisma.Decimal(0),
    );
    const tax = items.reduce(
      (sum, item) => sum.plus(item.taxAmount),
      new Prisma.Decimal(0),
    );
    const fee = order?.deliveryFee ?? new Prisma.Decimal(0);
    const total = gross.plus(fee).toDecimalPlaces(2);

    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: total.minus(tax).toDecimalPlaces(2),
        taxTotal: tax.toDecimalPlaces(2),
        total,
      },
    });
  }

  /**
   * Descuenta inventario de una ronda al empezar la preparación.
   *
   * Idempotente por `dedupeKey = round:{roundId}:{ingredientId}`. El stock
   * puede quedar negativo: la venta ya ocurrió y el plan pide advertencia, no
   * bloqueo (`plan.md` §13).
   */
  private async consumeRound(
    tx: Prisma.TransactionClient,
    organizationId: string | null,
    userId: string,
    order: {
      tableNumber: string | null;
      isTakeaway: boolean;
      branchId: string | null;
    },
    roundId: string,
    options?: {
      orderItemIds?: string[];
      dedupeScope?: string;
    },
  ): Promise<ConsumptionWarning[]> {
    const items = await tx.orderItem.findMany({
      where: {
        orderRoundId: roundId,
        ...(options?.orderItemIds?.length
          ? { id: { in: options.orderItemIds } }
          : {}),
      },
      include: {
        extras: true,
        exclusions: true,
        ingredientChoices: true,
        options: {
          include: {
            itemOptionValue: { include: { effects: true } },
          },
        },
        item: {
          include: {
            variants: { select: { id: true, recipeFactor: true } },
            recipes: {
              where: { isActive: true },
              include: { ingredients: { include: { options: true } } },
            },
            extras: { include: { ingredients: true } },
            comboComponents: {
              include: {
                variant: { select: { id: true, recipeFactor: true } },
                componentItem: {
                  include: {
                    recipes: {
                      where: { isActive: true },
                      include: { ingredients: { include: { options: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const totals = new Map<string, Prisma.Decimal>();

    for (const item of items) {
      const lineQuantity = new Prisma.Decimal(item.quantity);

      for (const consumption of consumptionForItem(item)) {
        const current =
          totals.get(consumption.ingredientId) ?? new Prisma.Decimal(0);
        totals.set(
          consumption.ingredientId,
          current.plus(consumption.quantity.times(lineQuantity)),
        );
      }
    }

    const warnings: ConsumptionWarning[] = [];
    const reason = order.tableNumber
      ? `Consumo pedido · mesa ${order.tableNumber}`
      : 'Consumo pedido · para llevar';

    for (const [ingredientId, quantity] of totals) {
      if (quantity.lte(0)) {
        continue;
      }

      const dedupeKey = `${options?.dedupeScope ?? `round:${roundId}`}:${ingredientId}`;

      const already = await tx.inventoryMovement.findUnique({
        where: { dedupeKey },
        select: { id: true },
      });

      if (already) {
        continue;
      }

      if (!organizationId) {
        continue; // Skip if no organization (should not happen for orders)
      }

      let stockAfter: Prisma.Decimal;
      let ingredientName: string;
      let displayUnit: UnitCode;

      if (order.branchId) {
        const amount = quantity.toString();

        await tx.$executeRaw`
          INSERT INTO "BranchStock" ("id", "branchId", "ingredientId", "quantity", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${order.branchId}, ${ingredientId}, 0, NOW(), NOW())
          ON CONFLICT ("branchId", "ingredientId") DO NOTHING
        `;

        const branchRows = await tx.$queryRaw<
          Array<{ quantity: Prisma.Decimal }>
        >`
          UPDATE "BranchStock"
          SET "quantity" = "quantity" - CAST(${amount} AS numeric),
              "updatedAt" = NOW()
          WHERE "branchId" = ${order.branchId}
            AND "ingredientId" = ${ingredientId}
          RETURNING "quantity"
        `;

        if (branchRows.length === 0) {
          continue;
        }

        const totals = await tx.$queryRaw<
          Array<{
            currentStock: Prisma.Decimal;
            name: string;
            displayUnit: UnitCode;
          }>
        >`
          UPDATE "Ingredient"
          SET "currentStock" = "currentStock" - CAST(${amount} AS numeric),
              "updatedAt" = NOW()
          WHERE "id" = ${ingredientId}
            AND "organizationId" = ${organizationId}
          RETURNING "currentStock", "name", "displayUnit"
        `;

        if (totals.length === 0) {
          continue;
        }

        stockAfter = new Prisma.Decimal(branchRows[0].quantity);
        ingredientName = totals[0].name;
        displayUnit = totals[0].displayUnit;
      } else {
        const rows = await tx.$queryRaw<
          Array<{
            currentStock: Prisma.Decimal;
            name: string;
            displayUnit: UnitCode;
          }>
        >`
          UPDATE "Ingredient"
          SET "currentStock" = "currentStock" - CAST(${quantity.toString()} AS numeric),
              "updatedAt" = NOW()
          WHERE "id" = ${ingredientId}
            AND "organizationId" = ${organizationId}
          RETURNING "currentStock", "name", "displayUnit"
        `;

        if (rows.length === 0) {
          continue;
        }

        stockAfter = new Prisma.Decimal(rows[0].currentStock);
        ingredientName = rows[0].name;
        displayUnit = rows[0].displayUnit;
      }

      await tx.inventoryMovement.create({
        data: {
          organizationId,
          branchId: order.branchId,
          ingredientId,
          ingredientName,
          displayUnit,
          userId,
          type: InventoryMovementType.CONSUMPTION,
          quantity: quantity.negated(),
          stockAfter,
          reason,
          referenceType: 'ORDER_ROUND',
          referenceId: roundId,
          dedupeKey,
        },
      });

      if (stockAfter.lt(0)) {
        warnings.push({
          ingredientId,
          name: ingredientName,
          stockAfter: stockAfter.toFixed(4),
        });
      }
    }

    return warnings;
  }
}

interface ConsumptionLine {
  ingredientId: string;
  quantity: Prisma.Decimal;
}

interface RecipeLineLike {
  id: string;
  ingredientId: string;
  variantId: string | null;
  quantity: Prisma.Decimal;
  options: Array<{ ingredientId: string; quantity: Prisma.Decimal }>;
}

interface RecipeLike {
  variantId: string | null;
  ingredients: RecipeLineLike[];
}

interface VariantLike {
  id: string;
  recipeFactor: Prisma.Decimal;
}

/**
 * Consumo de inventario de una línea (por unidad pedida).
 *
 * - Artículo normal: receta de la variante o, si no existe, la base escalada
 *   por `recipeFactor` de la presentación (Regular = 1).
 * - Combo: recetas de sus componentes (no hay combos anidados).
 * - Alternativas: se usa la opción elegida en el pedido o el insumo default.
 * - Extras: consumo declarado en el catálogo del extra.
 * - Exclusiones: el ingrediente que el cliente quitó no se descuenta.
 */
export function consumptionForItem(item: {
  itemVariantId: string | null;
  extras: Array<{ itemExtraId: string | null }>;
  exclusions: Array<{ ingredientId: string }>;
  ingredientChoices: Array<{
    recipeIngredientId: string;
    ingredientId: string;
  }>;
  options: Array<{
    itemOptionValue: {
      scaleFactor: Prisma.Decimal;
      effects: Array<{
        action: OptionEffectAction;
        recipeIngredientId: string | null;
        replacesIngredientId: string | null;
        ingredientId: string | null;
        quantity: Prisma.Decimal | null;
      }>;
    } | null;
  }>;
  item: {
    isCombo: boolean;
    variants: VariantLike[];
    recipes: RecipeLike[];
    extras: Array<{
      id: string;
      ingredients: Array<{
        ingredientId: string;
        quantity: Prisma.Decimal;
      }>;
    }>;
    comboComponents: Array<{
      componentVariantId: string | null;
      quantity: number;
      variant: VariantLike | null;
      componentItem: {
        recipes: RecipeLike[];
      };
    }>;
  };
}): ConsumptionLine[] {
  const excluded = new Set(
    item.exclusions.map((exclusion) => exclusion.ingredientId),
  );
  const choices = new Map(
    item.ingredientChoices.map((choice) => [
      choice.recipeIngredientId,
      choice.ingredientId,
    ]),
  );
  const lines: ConsumptionLine[] = [];

  // Efectos de las opciones elegidas sobre la receta: reemplazar un slot,
  // quitar un insumo/slot o añadir consumo extra.
  const slotReplacements = new Map<
    string,
    { ingredientId: string; quantity: Prisma.Decimal | null }
  >();
  const slotRemovals = new Set<string>();
  const ingredientRemovals = new Set<string>();
  const additions: Array<{
    ingredientId: string;
    quantity: Prisma.Decimal;
  }> = [];

  const ingredientReplacements = new Map<
    string,
    { ingredientId: string; quantity: Prisma.Decimal | null }
  >();

  for (const option of item.options) {
    for (const effect of option.itemOptionValue?.effects ?? []) {
      if (effect.action === OptionEffectAction.ADD && effect.ingredientId) {
        additions.push({
          ingredientId: effect.ingredientId,
          quantity: effect.quantity ?? new Prisma.Decimal(1),
        });
        continue;
      }

      if (effect.action === OptionEffectAction.REPLACE && effect.ingredientId) {
        if (effect.recipeIngredientId) {
          slotReplacements.set(effect.recipeIngredientId, {
            ingredientId: effect.ingredientId,
            quantity: effect.quantity,
          });
        } else if (effect.replacesIngredientId) {
          ingredientReplacements.set(effect.replacesIngredientId, {
            ingredientId: effect.ingredientId,
            quantity: effect.quantity,
          });
        }
        continue;
      }

      if (effect.action === OptionEffectAction.REMOVE) {
        if (effect.recipeIngredientId) {
          slotRemovals.add(effect.recipeIngredientId);
        }
        if (effect.ingredientId) {
          ingredientRemovals.add(effect.ingredientId);
        }
      }
    }
  }

  // Las opciones de tamaño multiplican el consumo de toda la receta.
  const optionFactor = item.options.reduce((factor, option) => {
    const scale = option.itemOptionValue?.scaleFactor;
    return scale ? factor.times(scale) : factor;
  }, new Prisma.Decimal(1));

  // Insumos efectivos de una presentación: comunes + propios, con el propio
  // reemplazando al común si repiten insumo.
  const effectiveRecipeLines = (
    lines: RecipeLineLike[],
    variantId: string | null,
  ) => {
    const variantLines = variantId
      ? lines.filter((line) => line.variantId === variantId)
      : [];
    const overridden = new Set(variantLines.map((line) => line.ingredientId));

    return [
      ...lines.filter(
        (line) =>
          line.variantId === null && !overridden.has(line.ingredientId),
      ),
      ...variantLines,
    ];
  };

  const pushRecipe = (
    recipes: RecipeLike[],
    variantId: string | null,
    multiplier: Prisma.Decimal,
    variants: VariantLike[],
  ) => {
    const base = recipes.find((candidate) => candidate.variantId === null);
    const legacy = recipes.find(
      (candidate) => candidate.variantId === variantId,
    );
    const recipe = base ?? legacy;

    if (!recipe) {
      return;
    }

    const sourceLines = base
      ? effectiveRecipeLines(base.ingredients, variantId)
      : recipe.ingredients;

    // La receta base se escala con el factor de la presentación (Regular = 1).
    // Una receta antigua por variante ya trae sus cantidades.
    const factor = base
      ? (variants.find((variant) => variant.id === variantId)?.recipeFactor ??
        new Prisma.Decimal(1))
      : new Prisma.Decimal(1);
    const totalMultiplier = multiplier.times(factor).times(optionFactor);

    for (const line of sourceLines) {
      if (slotRemovals.has(line.id)) {
        continue;
      }

      const replacement =
        slotReplacements.get(line.id) ??
        ingredientReplacements.get(line.ingredientId);
      const chosenIngredientId = choices.get(line.id);
      const option = chosenIngredientId
        ? line.options.find(
            (candidate) => candidate.ingredientId === chosenIngredientId,
          )
        : undefined;
      const ingredientId =
        replacement?.ingredientId ?? option?.ingredientId ?? line.ingredientId;
      const quantity =
        replacement?.quantity ?? option?.quantity ?? line.quantity;

      if (excluded.has(ingredientId) || ingredientRemovals.has(ingredientId)) {
        continue;
      }

      lines.push({
        ingredientId,
        quantity: quantity.times(totalMultiplier),
      });
    }
  };

  if (item.item.isCombo) {
    for (const component of item.item.comboComponents) {
      pushRecipe(
        component.componentItem.recipes,
        component.componentVariantId,
        new Prisma.Decimal(component.quantity),
        component.variant ? [component.variant] : [],
      );
    }
  } else {
    pushRecipe(
      item.item.recipes,
      item.itemVariantId,
      new Prisma.Decimal(1),
      item.item.variants,
    );
  }

  for (const extra of item.extras) {
    const catalogExtra = item.item.extras.find(
      (candidate) => candidate.id === extra.itemExtraId,
    );

    if (!catalogExtra) {
      continue;
    }

    for (const line of catalogExtra.ingredients) {
      lines.push({
        ingredientId: line.ingredientId,
        quantity: line.quantity,
      });
    }
  }

  for (const addition of additions) {
    if (
      excluded.has(addition.ingredientId) ||
      ingredientRemovals.has(addition.ingredientId)
    ) {
      continue;
    }

    lines.push(addition);
  }

  return lines;
}
