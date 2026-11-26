import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDiningTableDto,
  UpdateDiningTableDto,
} from './dto/dining-table.dto';
import { isEmptyPatch } from '../common/patch';

const tableInclude = {
  orders: {
    where: { order: { status: OrderStatus.OPEN } },
    orderBy: { createdAt: 'asc' as const },
    select: {
      isPrimary: true,
      order: {
        select: {
          id: true,
          status: true,
          channel: true,
          tableNumber: true,
          customerName: true,
          partySize: true,
          total: true,
          createdAt: true,
        },
      },
    },
  },
};

@Injectable()
export class DiningTablesService {
  constructor(private readonly prisma: PrismaService) {}

  private requireBranch(branchId: string | null) {
    if (!branchId) {
      throw new BadRequestException('Selecciona una sucursal');
    }

    return branchId;
  }

  async list(organizationId: string | null, branchId: string | null) {
    if (!organizationId || !branchId) return [];

    const tables = await this.prisma.diningTable.findMany({
      where: { organizationId, branchId },
      orderBy: [
        { zone: 'asc' },
        { sortOrder: 'asc' },
        { number: 'asc' },
      ],
      include: tableInclude,
    });

    return tables.map((table) => ({
      ...table,
      activeOrders: table.orders.map((row) => row.order),
      orders: undefined,
    }));
  }

  async create(
    organizationId: string | null,
    branchId: string | null,
    dto: CreateDiningTableDto,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const scopedBranchId = this.requireBranch(branchId);
    const number = dto.number.trim();

    const duplicate = await this.prisma.diningTable.findFirst({
      where: { organizationId, branchId: scopedBranchId, number },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException('Ya existe una mesa con ese número');
    }

    return this.prisma.diningTable.create({
      data: {
        organizationId,
        branchId: scopedBranchId,
        number,
        zone: dto.zone?.trim() || null,
        seats: dto.seats ?? 4,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: tableInclude,
    });
  }

  async update(
    organizationId: string | null,
    branchId: string | null,
    id: string,
    dto: UpdateDiningTableDto,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const scopedBranchId = this.requireBranch(branchId);
    const table = await this.prisma.diningTable.findFirst({
      where: { id, organizationId, branchId: scopedBranchId },
    });

    if (!table) throw new NotFoundException('Mesa no encontrada');

    const data: Record<string, unknown> = {};
    const number = dto.number?.trim();

    if (number !== undefined && number !== table.number) {
      const duplicate = await this.prisma.diningTable.findFirst({
        where: {
          organizationId,
          branchId: scopedBranchId,
          number,
          NOT: { id },
        },
        select: { id: true },
      });

      if (duplicate) {
        throw new ConflictException('Ya existe una mesa con ese número');
      }

      data.number = number;
    }

    if (dto.zone !== undefined) {
      const zone = dto.zone?.trim() || null;
      if (zone !== table.zone) data.zone = zone;
    }
    if (dto.seats !== undefined && dto.seats !== table.seats) {
      data.seats = dto.seats;
    }
    if (
      dto.sortOrder !== undefined &&
      dto.sortOrder !== table.sortOrder
    ) {
      data.sortOrder = dto.sortOrder;
    }
    if (dto.isActive !== undefined && dto.isActive !== table.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) {
      return this.prisma.diningTable.findUniqueOrThrow({
        where: { id },
        include: tableInclude,
      });
    }

    return this.prisma.diningTable.update({
      where: { id },
      data,
      include: tableInclude,
    });
  }

  async remove(
    organizationId: string | null,
    branchId: string | null,
    id: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const scopedBranchId = this.requireBranch(branchId);
    const table = await this.prisma.diningTable.findFirst({
      where: { id, organizationId, branchId: scopedBranchId },
      include: { _count: { select: { orders: true } } },
    });

    if (!table) throw new NotFoundException('Mesa no encontrada');

    if (table._count.orders > 0) {
      throw new ConflictException(
        'La mesa tiene cuentas asociadas; desactívala en lugar de eliminarla',
      );
    }

    await this.prisma.diningTable.delete({ where: { id } });

    return { ok: true };
  }
}
