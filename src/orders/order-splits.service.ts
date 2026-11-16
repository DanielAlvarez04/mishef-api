import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  SplitMode,
  SplitStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ANALYTICS_EVENTS } from '../analytics/analytics.events';
import { CreateOrderSplitDto } from './dto/order-splits.dto';

/** Convierte un importe a centavos enteros para repartir sin perder centavos. */
function toCents(value: Prisma.Decimal | number | string): number {
  return Math.round(Number(value) * 100);
}

function fromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100).toDecimalPlaces(2);
}

@Injectable()
export class OrderSplitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Partes de una cuenta con lo pagado y lo pendiente por parte. */
  async list(organizationId: string | null, orderId: string) {
    await this.assertOrder(organizationId, orderId);

    const splits = await this.prisma.orderSplit.findMany({
      where: { orderId, status: { not: SplitStatus.CANCELLED } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        guest: { select: { id: true, name: true } },
        payments: {
          select: { id: true, amount: true, status: true, method: true },
        },
      },
    });

    return splits.map((split) => {
      const confirmed = split.payments
        .filter((payment) => payment.status === PaymentStatus.CONFIRMED)
        .reduce((sum, payment) => sum + Number(payment.amount), 0);
      const pending = split.payments
        .filter((payment) => payment.status === PaymentStatus.PENDING)
        .reduce((sum, payment) => sum + Number(payment.amount), 0);
      const expected = Number(split.expectedAmount);

      return {
        id: split.id,
        label: split.label,
        mode: split.mode,
        status:
          confirmed + 0.004 >= expected ? SplitStatus.PAID : split.status,
        guestId: split.guestId,
        guestName: split.guest?.name ?? null,
        expectedAmount: expected,
        paidAmount: Math.round(confirmed * 100) / 100,
        pendingAmount: Math.round(pending * 100) / 100,
        remainingAmount: Math.max(0, Math.round((expected - confirmed) * 100) / 100),
        sortOrder: split.sortOrder,
        payments: split.payments,
      };
    });
  }

  /**
   * Crea la división de una cuenta.
   *
   * - BY_GUEST: cada cliente paga lo suyo; generales y envío se reparten
   *   **igual entre todos** (decisión del negocio).
   * - EQUAL: partes iguales; el centavo sobrante va a la primera parte.
   * - CUSTOM: importes definidos por el cajero.
   */
  async create(
    organizationId: string | null,
    orderId: string,
    dto: CreateOrderSplitDto,
    replace = false,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      include: {
        guests: { orderBy: { sortOrder: 'asc' } },
        rounds: {
          include: { items: { select: { guestId: true, subtotal: true } } },
        },
      },
    });

    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (order.status !== OrderStatus.OPEN) {
      throw new BadRequestException('La cuenta ya no está abierta');
    }

    const active = await this.prisma.orderSplit.findMany({
      where: { orderId, status: { not: SplitStatus.CANCELLED } },
      select: {
        id: true,
        payments: {
          where: {
            status: {
              in: [PaymentStatus.PENDING, PaymentStatus.CONFIRMED],
            },
          },
          select: { id: true },
        },
      },
    });

    if (active.length > 0 && !replace) {
      throw new BadRequestException('La cuenta ya tiene una división activa');
    }

    if (replace && active.some((split) => split.payments.length > 0)) {
      throw new BadRequestException(
        'Ya hay pagos en esta división. No se puede cambiar el tipo de reparto.',
      );
    }

    const totalCents = toCents(order.total);

    if (totalCents <= 0) {
      throw new BadRequestException('La cuenta no tiene importe para dividir');
    }

    const parts = this.buildParts(order, dto, totalCents);

    if (parts.length === 0) {
      throw new BadRequestException('No hay partes para dividir la cuenta');
    }

    const sum = parts.reduce((acc, part) => acc + toCents(part.amount), 0);

    if (sum !== totalCents) {
      throw new BadRequestException(
        `Las partes deben sumar ${order.total.toFixed(2)}; suman ${fromCents(sum).toFixed(2)}`,
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      if (replace && active.length > 0) {
        await tx.orderSplit.updateMany({
          where: { orderId, status: { not: SplitStatus.CANCELLED } },
          data: { status: SplitStatus.CANCELLED },
        });
      }

      await tx.orderSplit.createMany({
        data: parts.map((part, index) => ({
          orderId,
          guestId: part.guestId ?? null,
          label: part.label,
          mode: dto.mode,
          expectedAmount: part.amount,
          sortOrder: index,
        })),
      });

      return tx.orderSplit.findMany({
        where: { orderId, status: { not: SplitStatus.CANCELLED } },
        orderBy: { sortOrder: 'asc' },
      });
    });

    await this.analytics.recordMany([
      {
        name: ANALYTICS_EVENTS.paymentSplitCreated,
        organizationId,
        branchId: order.branchId,
        orderId,
        subjectType: 'order',
        subjectId: orderId,
        amount: Number(order.total),
        metadata: {
          mode: dto.mode,
          parts: created.length,
          requestedParts: dto.parts ?? null,
          replaced: replace,
        },
      },
    ]);

    // Se devuelven las partes con importes calculados para que el cliente no
    // tenga que hacer una petición extra después de crear o reemplazar.
    return this.list(organizationId, orderId);
  }

  /** Reemplaza la división activa en una sola transacción. */
  async replace(
    organizationId: string | null,
    orderId: string,
    dto: CreateOrderSplitDto,
  ) {
    return this.create(organizationId, orderId, dto, true);
  }

  /** Cancela la división activa; los pagos ya registrados se conservan. */
  async cancel(organizationId: string | null, orderId: string) {
    await this.assertOrder(organizationId, orderId);

    await this.prisma.$transaction(async (tx) => {
      const active = await tx.orderSplit.findMany({
        where: { orderId, status: { not: SplitStatus.CANCELLED } },
        select: { id: true },
      });
      const ids = active.map((split) => split.id);

      if (ids.length > 0) {
        // Los pagos pendientes de una parte cancelada no deben bloquear el
        // saldo de la cuenta: se anulan; los confirmados se conservan.
        await tx.payment.updateMany({
          where: {
            splitId: { in: ids },
            status: PaymentStatus.PENDING,
          },
          data: { status: PaymentStatus.CANCELLED, splitId: null },
        });
      }

      await tx.orderSplit.updateMany({
        where: { orderId, status: { not: SplitStatus.CANCELLED } },
        data: { status: SplitStatus.CANCELLED },
      });
    });

    return { ok: true };
  }

  /**
   * Agrega una parte por una ronda nueva enviada después de dividir.
   *
   * La división original se congela y lo nuevo se cobra aparte, para no
   * recalcular importes que el cliente ya pagó.
   */
  async addRoundShare(
    tx: Prisma.TransactionClient,
    orderId: string,
    roundId: string,
    label: string,
    amount: Prisma.Decimal,
  ) {
    const active = await tx.orderSplit.count({
      where: { orderId, status: { not: SplitStatus.CANCELLED } },
    });

    if (active === 0) return null;

    const last = await tx.orderSplit.findFirst({
      where: { orderId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    return tx.orderSplit.create({
      data: {
        orderId,
        label,
        mode: SplitMode.CUSTOM,
        expectedAmount: amount.toDecimalPlaces(2),
        sortOrder: (last?.sortOrder ?? -1) + 1,
        // El id de la ronda queda en la etiqueta para trazabilidad.
        guestId: null,
        status: SplitStatus.OPEN,
      },
    });
  }

  /** Recalcula el estado de una parte a partir de sus pagos confirmados. */
  async recomputeStatus(splitId: string | null) {
    if (!splitId) return;

    const split = await this.prisma.orderSplit.findUnique({
      where: { id: splitId },
      include: {
        payments: {
          where: { status: PaymentStatus.CONFIRMED },
          select: { amount: true },
        },
      },
    });

    if (!split || split.status === SplitStatus.CANCELLED) return;

    const paid = split.payments.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0,
    );
    const expected = Number(split.expectedAmount);
    const status =
      paid + 0.004 >= expected ? SplitStatus.PAID : SplitStatus.OPEN;

    if (status !== split.status) {
      await this.prisma.orderSplit.update({
        where: { id: splitId },
        data: { status },
      });
    }
  }

  /** Valida que un pago no exceda lo que falta de su parte. */
  async assertPaymentFits(
    orderId: string,
    splitId: string,
    amount: Prisma.Decimal,
  ) {
    const split = await this.prisma.orderSplit.findFirst({
      where: { id: splitId, orderId, status: { not: SplitStatus.CANCELLED } },
      include: {
        payments: {
          where: {
            status: {
              in: [PaymentStatus.PENDING, PaymentStatus.CONFIRMED],
            },
          },
          select: { amount: true },
        },
      },
    });

    if (!split) {
      throw new BadRequestException('La parte indicada no pertenece a la cuenta');
    }

    const used = split.payments.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0,
    );
    const remaining = Number(split.expectedAmount) - used;

    if (Number(amount) > remaining + 0.004) {
      throw new BadRequestException(
        `La parte «${split.label ?? 'sin nombre'}» solo debe ${Math.max(0, remaining).toFixed(2)}`,
      );
    }
  }

  private async assertOrder(organizationId: string | null, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
      select: { id: true, status: true },
    });

    if (!order) throw new NotFoundException('Pedido no encontrado');

    return order;
  }

  private buildParts(
    order: {
      total: Prisma.Decimal;
      guests: Array<{ id: string; name: string }>;
      rounds: Array<{
        items: Array<{ guestId: string | null; subtotal: Prisma.Decimal }>;
      }>;
    },
    dto: CreateOrderSplitDto,
    totalCents: number,
  ): Array<{ label: string; guestId?: string; amount: Prisma.Decimal }> {
    if (dto.mode === SplitMode.EQUAL) {
      const parts = dto.parts ?? 0;

      if (parts < 2 || parts > 20) {
        throw new BadRequestException('Indica entre 2 y 20 partes');
      }

      const base = Math.floor(totalCents / parts);
      const remainder = totalCents - base * parts;

      return Array.from({ length: parts }, (_, index) => ({
        label: `Parte ${index + 1} de ${parts}`,
        amount: fromCents(base + (index === 0 ? remainder : 0)),
      }));
    }

    if (dto.mode === SplitMode.BY_GUEST) {
      if (order.guests.length === 0) {
        throw new BadRequestException(
          'La cuenta no tiene clientes para dividir por persona',
        );
      }

      const centsByGuest = new Map<string, number>();
      let generalCents = totalCents;

      for (const round of order.rounds) {
        for (const item of round.items) {
          if (!item.guestId) continue;

          const cents = toCents(item.subtotal);
          centsByGuest.set(
            item.guestId,
            (centsByGuest.get(item.guestId) ?? 0) + cents,
          );
          generalCents -= cents;
        }
      }

      // Los artículos generales y el envío se reparten igual entre clientes.
      const guests = order.guests;

      if (generalCents < 0) {
        throw new BadRequestException(
          'Los artículos asignados a clientes superan el total de la cuenta',
        );
      }

      const base = Math.floor(generalCents / guests.length);
      const remainder = generalCents - base * guests.length;

      return guests.map((guest, index) => ({
        label: guest.name.trim() || `Cliente ${index + 1}`,
        guestId: guest.id,
        amount: fromCents(
          (centsByGuest.get(guest.id) ?? 0) +
            base +
            (index === 0 ? remainder : 0),
        ),
      }));
    }

    // CUSTOM: importes definidos por el cajero.
    const amounts = dto.amounts ?? [];

    if (amounts.length === 0) {
      throw new BadRequestException('Agrega al menos una parte');
    }

    return amounts.map((part, index) => ({
      label: part.label?.trim() || `Parte ${index + 1}`,
      guestId: part.guestId,
      amount: new Prisma.Decimal(part.amount).toDecimalPlaces(2),
    }));
  }
}
