import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateShiftDto } from './dto/attendance.dto';

const HOUR_MS = 60 * 60 * 1000;

/** Peso por rol cuando no se especifica otro. ADMIN no participa del reparto. */
const DEFAULT_WEIGHTS: Record<Role, number> = {
  ADMIN: 0,
  WAITER: 1,
  CASHIER: 1,
  KITCHEN: 0.6,
  INVENTORY_MANAGER: 0.6,
};

function parseDate(raw: string | undefined, endOfDay = false): Date | null {
  if (!raw) return null;

  // `YYYY-MM-DD` se interpreta como día local del negocio. Si se parsea como
  // UTC, `setHours(23:59)` cae en la fecha local anterior y el último día del
  // rango queda fuera.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const date = new Date(isDateOnly ? `${raw.trim()}T00:00:00` : raw);

  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

/** `WAITER:1,KITCHEN:0.5` → pesos por rol. */
function parseWeights(raw?: string): Partial<Record<Role, number>> {
  if (!raw) return {};

  const weights: Partial<Record<Role, number>> = {};

  for (const pair of raw.split(',')) {
    const [role, value] = pair.split(':');
    const key = role?.trim().toUpperCase() as Role;
    const weight = Number(value);

    if (key in DEFAULT_WEIGHTS && Number.isFinite(weight) && weight >= 0) {
      weights[key] = weight;
    }
  }

  return weights;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async current(organizationId: string | null, userId: string) {
    if (!organizationId) return null;

    return this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        note: true,
        branchId: true,
      },
    });
  }

  async clockIn(
    organizationId: string | null,
    userId: string,
    branchId: string | null,
    note?: string,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const open = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      select: { id: true },
    });

    if (open) {
      throw new ConflictException('Ya tienes un turno abierto');
    }

    return this.prisma.shift.create({
      data: {
        organizationId,
        userId,
        branchId,
        note: note?.trim() || null,
      },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        note: true,
        branchId: true,
      },
    });
  }

  async clockOut(organizationId: string | null, userId: string) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const open = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });

    if (!open) {
      throw new BadRequestException('No tienes un turno abierto');
    }

    return this.prisma.shift.update({
      where: { id: open.id },
      data: { endedAt: new Date() },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        note: true,
        branchId: true,
      },
    });
  }

  /**
   * Corrige un turno existente (entrada, salida o nota).
   *
   * Solo ADMIN. No permite que dos turnos del mismo usuario se crucen ni que
   * queden dos turnos abiertos a la vez: las horas de propinas deben ser
   * confiables.
   */
  async update(
    organizationId: string | null,
    actorUserId: string,
    shiftId: string,
    dto: UpdateShiftDto,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, organizationId },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        endedAt: true,
        note: true,
        branchId: true,
      },
    });

    if (!shift) {
      throw new NotFoundException('Turno no encontrado');
    }

    const startedAt =
      dto.startedAt !== undefined ? new Date(dto.startedAt) : shift.startedAt;

    if (Number.isNaN(startedAt.getTime())) {
      throw new BadRequestException('La entrada no es una fecha válida');
    }

    const endedAt =
      dto.endedAt === undefined
        ? shift.endedAt
        : dto.endedAt === null
          ? null
          : new Date(dto.endedAt);

    if (endedAt && Number.isNaN(endedAt.getTime())) {
      throw new BadRequestException('La salida no es una fecha válida');
    }

    if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
      throw new BadRequestException(
        'La salida debe ser posterior a la entrada',
      );
    }

    const effectiveEnd = endedAt ?? new Date();

    const overlap = await this.prisma.shift.findFirst({
      where: {
        organizationId,
        userId: shift.userId,
        id: { not: shift.id },
        startedAt: { lt: effectiveEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: startedAt } }],
      },
      select: { id: true },
    });

    if (overlap) {
      throw new ConflictException(
        'El turno se cruza con otro turno del mismo usuario',
      );
    }

    const data: {
      startedAt?: Date;
      endedAt?: Date | null;
      note?: string | null;
    } = {};

    if (startedAt.getTime() !== shift.startedAt.getTime()) {
      data.startedAt = startedAt;
    }

    const currentEnd = shift.endedAt?.getTime() ?? null;
    const nextEnd = endedAt?.getTime() ?? null;

    if (currentEnd !== nextEnd) {
      data.endedAt = endedAt;
    }

    if (dto.note !== undefined) {
      const note = dto.note?.trim() || null;

      if (note !== shift.note) {
        data.note = note;
      }
    }

    if (Object.keys(data).length === 0) {
      return shift;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.shift.update({
        where: { id: shift.id },
        data,
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          note: true,
          branchId: true,
          user: { select: { id: true, name: true, username: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.shift_updated',
          entity: 'Shift',
          entityId: shift.id,
          oldValues: {
            startedAt: shift.startedAt.toISOString(),
            endedAt: shift.endedAt?.toISOString() ?? null,
            note: shift.note,
          },
          newValues: {
            startedAt: result.startedAt.toISOString(),
            endedAt: result.endedAt?.toISOString() ?? null,
            note: result.note,
          },
        },
      });

      return result;
    });

    return updated;
  }

  async list(
    organizationId: string | null,
    branchId: string | null,
    from?: string,
    to?: string,
  ) {    if (!organizationId) return { shifts: [], hours: 0 };

    const start = parseDate(from);
    const end = parseDate(to, true);

    const shifts = await this.prisma.shift.findMany({
      where: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...(start || end
          ? {
              startedAt: {
                ...(start ? { gte: start } : {}),
                ...(end ? { lte: end } : {}),
              },
            }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        note: true,
        branchId: true,
        user: { select: { id: true, name: true, username: true } },
      },
    });

    const now = Date.now();
    const hours = shifts.reduce((sum, shift) => {
      const endMs = shift.endedAt ? shift.endedAt.getTime() : now;
      return sum + (endMs - shift.startedAt.getTime()) / HOUR_MS;
    }, 0);

    return { shifts, hours: Math.round(hours * 100) / 100 };
  }

  /**
   * Reparto de propinas del periodo.
   *
   * `share = pozo × (peso del rol × horas) / Σ(peso × horas)`. Las horas salen
   * del checador y se recortan al periodo. Si nadie checó, se reparte en partes
   * iguales entre quienes recibieron propina, para no dejar el pozo sin asignar.
   */
  async tipsDistribution(
    organizationId: string | null,
    branchId: string | null,
    from?: string,
    to?: string,
    weightsRaw?: string,
  ) {
    if (!organizationId) {
      return { pool: 0, participants: [], weights: DEFAULT_WEIGHTS };
    }

    const end = parseDate(to, true) ?? new Date();
    const start =
      parseDate(from) ??
      new Date(end.getFullYear(), end.getMonth(), 1, 0, 0, 0, 0);

    const weights = { ...DEFAULT_WEIGHTS, ...parseWeights(weightsRaw) };

    const [payments, shifts, memberships] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          status: PaymentStatus.CONFIRMED,
          confirmedAt: { gte: start, lte: end },
          tipAmount: { gt: 0 },
        },
        select: { tipAmount: true, tipRecipientId: true, userId: true },
      }),
      this.prisma.shift.findMany({
        where: {
          organizationId,
          ...(branchId ? { branchId } : {}),
          startedAt: { lte: end },
          OR: [{ endedAt: null }, { endedAt: { gte: start } }],
        },
        select: { userId: true, startedAt: true, endedAt: true },
      }),
      this.prisma.membership.findMany({
        where: { organizationId, isActive: true },
        select: { userId: true, roles: true, user: { select: { name: true } } },
      }),
    ]);

    const pool =
      Math.round(
        payments.reduce((sum, payment) => sum + Number(payment.tipAmount), 0) *
          100,
      ) / 100;

    const roleOf = new Map(
      memberships.map((membership) => [membership.userId, membership.roles[0]]),
    );
    const nameOf = new Map(
      memberships.map((membership) => [
        membership.userId,
        membership.user.name,
      ]),
    );

    const hoursOf = new Map<string, number>();
    const now = Date.now();

    for (const shift of shifts) {
      // Un turno abierto solo cuenta hasta ahora, no hasta el final del
      // periodo: si el periodo termina el día 30, no se le regalan días
      // futuros al reparto de propinas.
      const shiftEnd = shift.endedAt
        ? shift.endedAt
        : new Date(Math.min(now, end.getTime()));
      const overlap =
        Math.min(shiftEnd.getTime(), end.getTime()) -
        Math.max(shift.startedAt.getTime(), start.getTime());

      if (overlap <= 0) continue;

      hoursOf.set(
        shift.userId,
        (hoursOf.get(shift.userId) ?? 0) + overlap / HOUR_MS,
      );
    }

    // Sin checador en el periodo: reparto igual entre quienes recibieron propina.
    if (hoursOf.size === 0 && pool > 0) {
      const receivers = new Set<string>();

      for (const payment of payments) {
        const id = payment.tipRecipientId ?? payment.userId;
        if (id) receivers.add(id);
      }

      for (const id of receivers) hoursOf.set(id, 1);
    }

    const raw = [...hoursOf.entries()].map(([userId, hours]) => {
      const role = roleOf.get(userId) ?? Role.WAITER;
      const weight = (weights[role] ?? 0) * hours;

      return {
        userId,
        name: nameOf.get(userId) ?? null,
        role,
        hours: Math.round(hours * 100) / 100,
        weight: Math.round(weight * 100) / 100,
      };
    });

    const totalWeight = raw.reduce((sum, row) => sum + row.weight, 0);

    const participants = raw
      .map((row) => ({
        ...row,
        share:
          totalWeight > 0
            ? Math.round((pool * (row.weight / totalWeight)) * 100) / 100
            : 0,
      }))
      .sort((a, b) => b.share - a.share);

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      pool,
      totalWeight: Math.round(totalWeight * 100) / 100,
      weights,
      participants,
    };
  }
}
