import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementType,
  OptionEffectAction,
  OptionSelection,
  OrderRoundStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  PromotionType,
  UnitCode,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ANALYTICS_EVENTS } from '../analytics/analytics.events';
import { isNoPriceOptionGroup } from '../catalog/option-presets';
import {
  CancelOrderDto,
  CreateOrderDto,
  RoundItemDto,
  RoundItemOptionDto,
  SendRoundDto,
  TransitionRoundDto,
} from './dto/orders.dto';
import { OrdersEventsService } from './orders.events';

/** Estados a los que puede pasar cada estado de ronda (plan.md §6.6). */
const ALLOWED_TRANSITIONS: Record<OrderRoundStatus, OrderRoundStatus[]> = {
  [OrderRoundStatus.PENDING]: [
    OrderRoundStatus.PREPARING,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.PREPARING]: [
    OrderRoundStatus.READY,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.READY]: [
    OrderRoundStatus.DELIVERED,
    OrderRoundStatus.CANCELLED,
  ],
  [OrderRoundStatus.DELIVERED]: [],
  [OrderRoundStatus.CANCELLED]: [],
};

const OPEN_ROUND_STATUSES = [
  OrderRoundStatus.PENDING,
  OrderRoundStatus.PREPARING,
  OrderRoundStatus.READY,
];

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
  user: { select: { id: true, name: true, username: true } },
  payments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      method: true,
      amount: true,
      status: true,
      paidAt: true,
      confirmedAt: true,
      createdAt: true,
      user: { select: { id: true, name: true, username: true } },
      confirmedBy: { select: { id: true, name: true, username: true } },
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
      status: true,
      total: true,
      createdAt: true,
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

    const created = await this.prisma.order.create({
      data: {
        organizationId: organizationId ?? undefined,
        branchId: branchId ?? undefined,
        userId,
        tableNumber: dto.tableNumber?.trim() || null,
        isTakeaway: dto.isTakeaway ?? false,
        idempotencyKey,
      },
      include: orderInclude,
    });

    this.events.publish({ type: 'ORDER_CREATED', orderId: created.id });

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
          payments: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              method: true,
              amount: true,
              status: true,
              paidAt: true,
              confirmedAt: true,
              createdAt: true,
              user: { select: { id: true, name: true, username: true } },
              confirmedBy: { select: { id: true, name: true, username: true } },
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

    const { items, selections } = await this.buildItems(
      organizationId,
      dto.items,
      organization.taxRate,
    );

    const round = await this.prisma.$transaction(async (tx) => {
      const created = await tx.orderRound.create({
        data: {
          orderId,
          status: OrderRoundStatus.PENDING,
          sentAt: new Date(),
          idempotencyKey,
          items: { create: items },
        },
        include: roundInclude,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderRoundId: created.id,
          previousStatus: null,
          newStatus: OrderRoundStatus.PENDING,
          changedById: userId,
          reason: 'Ronda enviada a cocina',
        },
      });

      await this.recalculateTotals(tx, orderId);

      return created;
    });

    this.events.publish({
      type: 'ROUND_CREATED',
      orderId,
      roundId: round.id,
      status: round.status,
    });

    const orderLabel = order.tableNumber
      ? `Mesa ${order.tableNumber}`
      : order.isTakeaway
        ? 'Para llevar'
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
  async transitionRound(
    organizationId: string | null,
    userId: string,
    orderId: string,
    roundId: string,
    dto: TransitionRoundDto,
  ) {
    const order = await this.getOrderRow(organizationId, orderId);

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
    });

    this.events.publish({ type: 'ORDER_CANCELLED', orderId });

    return this.get(organizationId, orderId);
  }

  // --------------------------------------------------------------------------
  // Cocina
  // --------------------------------------------------------------------------

  kitchenRounds(organizationId: string | null, branchId: string | null = null) {
    return this.prisma.orderRound.findMany({
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
        isTakeaway: true,
        branchId: true,
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
        ? this.bestComboPromotion(item.promotions, unitPrice, quantity)
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
          valueId: string;
          priceDelta: Prisma.Decimal;
          isDefault: boolean;
          isActive: boolean;
          value: {
            id: string;
            name: string;
            kitchenLabel: string | null;
            isActive: boolean;
          };
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
        if (!value.isActive || !value.value.isActive) continue;

        available.set(value.id, {
          assignmentId: group.id,
          groupId: group.group.id,
          groupName: group.group.name,
          valueId: value.valueId,
          valueName: value.value.name,
          priceDelta: noPrice ? new Prisma.Decimal(0) : value.priceDelta,
          isDefault: value.isDefault,
          optionName: value.value.name,
          kitchenLabel: value.value.kitchenLabel ?? value.value.name,
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
        (value) => value.isActive && value.value.isActive,
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

  /** Mejor promoción aplicable a una línea de combo (descuento máximo). */
  private bestComboPromotion(
    promotions: Array<{
      name: string;
      type: PromotionType;
      value: Prisma.Decimal;
      startsAt: Date | null;
      endsAt: Date | null;
      daysOfWeek: number[];
      startTime: string | null;
      endTime: string | null;
      isActive: boolean;
    }>,
    unitPrice: Prisma.Decimal,
    quantity: number,
  ) {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes(),
    ).padStart(2, '0')}`;

    let best: { name: string; discount: Prisma.Decimal } | null = null;

    for (const promotion of promotions) {
      if (!promotion.isActive) continue;
      if (promotion.startsAt && promotion.startsAt > now) continue;
      if (promotion.endsAt && promotion.endsAt < now) continue;

      if (
        promotion.daysOfWeek.length > 0 &&
        !promotion.daysOfWeek.includes(now.getDay())
      ) {
        continue;
      }

      if (promotion.startTime && promotion.endTime) {
        const inWindow =
          promotion.startTime <= promotion.endTime
            ? hhmm >= promotion.startTime && hhmm <= promotion.endTime
            : hhmm >= promotion.startTime || hhmm <= promotion.endTime;

        if (!inWindow) continue;
      }

      const gross = unitPrice.times(quantity);
      let discount: Prisma.Decimal;

      if (promotion.type === PromotionType.PERCENT) {
        discount = gross.times(promotion.value).dividedBy(100);
      } else if (promotion.type === PromotionType.FIXED) {
        discount = promotion.value.times(quantity);
      } else {
        // 2x1: una unidad gratis por cada par.
        discount = unitPrice.times(Math.floor(quantity / 2));
      }

      if (discount.gt(gross)) discount = gross;
      discount = discount.toDecimalPlaces(2);

      if (discount.lte(0)) continue;

      if (!best || discount.gt(best.discount)) {
        best = { name: promotion.name, discount };
      }
    }

    return best;
  }

  /** Recalcula los totales de la cuenta ignorando las rondas canceladas. */
  private async recalculateTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const items = await tx.orderItem.findMany({
      where: {
        orderRound: {
          orderId,
          status: { not: OrderRoundStatus.CANCELLED },
        },
      },
      select: { subtotal: true, taxAmount: true },
    });

    const gross = items.reduce(
      (sum, item) => sum.plus(item.subtotal),
      new Prisma.Decimal(0),
    );
    const tax = items.reduce(
      (sum, item) => sum.plus(item.taxAmount),
      new Prisma.Decimal(0),
    );

    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: gross.minus(tax).toDecimalPlaces(2),
        taxTotal: tax.toDecimalPlaces(2),
        total: gross.toDecimalPlaces(2),
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
  ): Promise<ConsumptionWarning[]> {
    const items = await tx.orderItem.findMany({
      where: { orderRoundId: roundId },
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

      const dedupeKey = `round:${roundId}:${ingredientId}`;

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
function consumptionForItem(item: {
  itemVariantId: string | null;
  extras: Array<{ itemExtraId: string | null }>;
  exclusions: Array<{ ingredientId: string }>;
  ingredientChoices: Array<{
    recipeIngredientId: string;
    ingredientId: string;
  }>;
  options: Array<{
    itemOptionValue: {
      effects: Array<{
        action: OptionEffectAction;
        recipeIngredientId: string | null;
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

  for (const option of item.options) {
    for (const effect of option.itemOptionValue?.effects ?? []) {
      if (effect.action === OptionEffectAction.ADD && effect.ingredientId) {
        additions.push({
          ingredientId: effect.ingredientId,
          quantity: effect.quantity ?? new Prisma.Decimal(1),
        });
        continue;
      }

      if (
        effect.action === OptionEffectAction.REPLACE &&
        effect.recipeIngredientId &&
        effect.ingredientId
      ) {
        slotReplacements.set(effect.recipeIngredientId, {
          ingredientId: effect.ingredientId,
          quantity: effect.quantity,
        });
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

  const pushRecipe = (
    recipes: RecipeLike[],
    variantId: string | null,
    multiplier: Prisma.Decimal,
    variants: VariantLike[],
  ) => {
    const variantRecipe = recipes.find(
      (candidate) => candidate.variantId === variantId,
    );
    const recipe =
      variantRecipe ?? recipes.find((candidate) => candidate.variantId === null);

    if (!recipe) {
      return;
    }

    // La receta propia de la presentación ya tiene sus cantidades; la receta
    // base se escala con el factor de la presentación (Regular = 1).
    const factor = variantRecipe
      ? new Prisma.Decimal(1)
      : (variants.find((variant) => variant.id === variantId)?.recipeFactor ??
        new Prisma.Decimal(1));
    const totalMultiplier = multiplier.times(factor);

    for (const line of recipe.ingredients) {
      if (slotRemovals.has(line.id)) {
        continue;
      }

      const replacement = slotReplacements.get(line.id);
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

