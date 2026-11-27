import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, type PosDraft } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreatePosDraftDto } from './dto/pos-draft.dto';

/** El borrador caduca a los 15 minutos si nadie lo reanuda. */
export const POS_DRAFT_TTL_MS = 15 * 60 * 1000;

function itemCount(cart: Prisma.JsonValue) {
  if (!Array.isArray(cart)) return 0;

  return cart.reduce<number>((count, line) => {
    if (!line || typeof line !== 'object') return count;
    const quantity = (line as { quantity?: unknown }).quantity;

    return typeof quantity === 'number' && Number.isFinite(quantity)
      ? count + quantity
      : count;
  }, 0);
}

@Injectable()
export class PosDraftsService implements OnModuleInit, OnModuleDestroy {
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Limpieza periódica de vencidos.
   *
   * Listar ya excluye los vencidos por `expiresAt` y reanudar valida la
   * vigencia, pero este barrido garantiza que un borrador abandonado
   * desaparezca aunque nadie vuelva a abrir la bandeja.
   */
  onModuleInit() {
    this.purgeTimer = setInterval(() => {
      void this.prisma.posDraft
        .deleteMany({ where: { expiresAt: { lte: new Date() } } })
        .catch(() => undefined);
    }, 60_000);

    this.purgeTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /**
   * Guarda una captura sin abrir cuenta.
   *
   * La mesa queda libre: el borrador no crea `Order` ni `OrderTable`. Solo se
   * conserva el número para restaurar la selección al reanudar.
   */
  async create(
    organizationId: string | null,
    branchId: string | null,
    userId: string,
    dto: CreatePosDraftDto,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const actor = await this.prisma.membership.findFirst({
      where: { userId, organizationId },
      select: {
        username: true,
        user: { select: { name: true } },
      },
    });

    const createdByName =
      actor?.user.name?.trim() || actor?.username?.trim() || null;

    const draft = await this.prisma.posDraft.create({
      data: {
        organizationId,
        branchId,
        createdById: userId,
        createdByName,
        orderId: dto.orderId?.trim() || null,
        channel: dto.channel ?? 'DINE_IN',
        tableNumber: dto.tableNumber?.trim() || null,
        tableId: dto.tableId?.trim() || null,
        customerName: dto.customerName?.trim() || null,
        customerPhone: dto.customerPhone?.trim() || null,
        customerSex: dto.customerSex ?? null,
        customerAgeRange: dto.customerAgeRange ?? null,
        deliveryAddress: dto.deliveryAddress?.trim() || null,
        deliveryFee: new Prisma.Decimal(dto.deliveryFee ?? 0).toDecimalPlaces(
          2,
        ),
        partySize: dto.partySize ?? 1,
        cart: dto.cart as Prisma.InputJsonValue,
        guests: (dto.guests ?? []) as Prisma.InputJsonValue,
        total: new Prisma.Decimal(dto.total ?? 0).toDecimalPlaces(2),
        expiresAt: new Date(Date.now() + POS_DRAFT_TTL_MS),
      },
    });

    return this.toPayload(draft);
  }

  /**
   * Borradores vigentes de la sucursal.
   *
   * Los vencidos se excluyen por `expiresAt`; el barrido periódico se encarga
   * de borrarlos aunque nadie abra la bandeja.
   */
  async list(organizationId: string | null, branchId: string | null) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const drafts = await this.prisma.posDraft.findMany({
      where: {
        organizationId,
        branchId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    return drafts.map((draft) => this.toPayload(draft));
  }

  /**
   * Entrega un borrador y lo consume.
   *
   * Cualquier persona de la sucursal puede reanudarlo: el turno cambia y la
   * captura no debe quedarse atada a quien la escribió.
   */
  async resume(
    organizationId: string | null,
    branchId: string | null,
    id: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const draft = await this.prisma.posDraft.findFirst({
      where: { id, organizationId, branchId },
    });

    if (!draft) {
      throw new NotFoundException('El borrador ya no existe');
    }

    if (draft.expiresAt.getTime() <= Date.now()) {
      await this.prisma.posDraft.deleteMany({ where: { id } });
      throw new BadRequestException(
        'El borrador venció a los 15 minutos; vuelve a capturar la orden',
      );
    }

    const consumed = await this.prisma.posDraft.deleteMany({
      where: {
        id,
        organizationId,
        branchId,
        expiresAt: { gt: new Date() },
      },
    });

    if (consumed.count === 0) {
      throw new NotFoundException('Otro usuario ya reanudó este borrador');
    }

    return this.toPayload(draft);
  }

  async remove(
    organizationId: string | null,
    branchId: string | null,
    id: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const deleted = await this.prisma.posDraft.deleteMany({
      where: { id, organizationId, branchId },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('El borrador ya no existe');
    }

    return { id, deleted: true };
  }

  private toPayload(draft: PosDraft) {
    return {
      id: draft.id,
      orderId: draft.orderId,
      channel: draft.channel,
      tableNumber: draft.tableNumber,
      tableId: draft.tableId,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      customerSex: draft.customerSex,
      customerAgeRange: draft.customerAgeRange,
      deliveryAddress: draft.deliveryAddress,
      deliveryFee: draft.deliveryFee.toFixed(2),
      partySize: draft.partySize,
      cart: draft.cart,
      guests: draft.guests,
      total: draft.total.toFixed(2),
      itemCount: itemCount(draft.cart),
      expiresAt: draft.expiresAt.toISOString(),
      createdAt: draft.createdAt.toISOString(),
      createdByName: draft.createdByName,
    };
  }
}
