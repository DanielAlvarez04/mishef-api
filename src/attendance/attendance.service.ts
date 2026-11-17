import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceEventType,
  AttendanceSource,
  PaymentStatus,
  Prisma,
  Role,
  ScheduleStatus,
  ShiftBreakType,
} from '@prisma/client';
import { verify } from 'argon2';

import { PrismaService } from '../prisma/prisma.service';
import { distanceKm } from '../common/benchmark';
import {
  AttendanceRules,
  addDays,
  dateKey,
  effectiveBreakMinutes,
  effectiveEnd,
  effectiveStart,
  minutesBetween,
  scheduledRange,
  startOfDay,
  startOfWeek,
} from './attendance-rules';
import {
  AttendanceAdjustmentDto,
  CopyScheduleDto,
  KioskPunchDto,
  PunchAction,
  ReviewShiftDto,
  SaveScheduleDto,
  ScheduleTemplateDto,
  ScheduleWeekDto,
  SetKioskOperatorsDto,
  UpdateAttendanceSettingsDto,
} from './dto/attendance.dto';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

const DEFAULT_WEIGHTS: Record<Role, number> = {
  ADMIN: 0,
  WAITER: 1,
  CASHIER: 1,
  KITCHEN: 0.6,
  INVENTORY_MANAGER: 0.6,
};

const shiftInclude = {
  user: { select: { id: true, name: true, username: true } },
  breaks: { orderBy: { startedAt: 'asc' as const } },
  adjustments: { orderBy: { createdAt: 'asc' as const } },
  scheduleEntry: true,
} satisfies Prisma.ShiftInclude;

interface ScheduleCandidate {
  branchId: string | null;
  status: ScheduleStatus;
}

/**
 * Elige el horario de la semana.
 *
 * Se prefiere el de la sucursal (publicado y, si no, borrador) y después el de
 * la organización. El respaldo de borrador permite que el checador funcione
 * aunque el administrador todavía no haya pulsado "Publicar".
 */
function pickSchedule<T extends ScheduleCandidate>(
  schedules: T[],
  branchId: string | null,
): T | null {
  const published = schedules.filter(
    (row) => row.status === ScheduleStatus.PUBLISHED,
  );
  const drafts = schedules.filter(
    (row) => row.status !== ScheduleStatus.PUBLISHED,
  );

  return (
    published.find((row) => row.branchId === branchId) ??
    drafts.find((row) => row.branchId === branchId) ??
    published.find((row) => row.branchId === null) ??
    drafts.find((row) => row.branchId === null) ??
    null
  );
}

type ShiftWithDetails = Prisma.ShiftGetPayload<{
  include: typeof shiftInclude;
}>;

interface PunchOptions {
  recordedById?: string | null;
  source?: AttendanceSource;
  note?: string;
  latitude?: number;
  longitude?: number;
  idempotencyKey?: string;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Configuración y reglas
  // --------------------------------------------------------------------------

  async getSettings(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        attendanceApplyTolerance: true,
        attendanceLateGraceMinutes: true,
        attendanceLunchGraceMinutes: true,
        attendanceEarlyLeaveGraceMinutes: true,
        attendanceDefaultBreakMinutes: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    return organization;
  }

  async updateSettings(
    organizationId: string | null,
    actorUserId: string,
    dto: UpdateAttendanceSettingsDto,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const current = await this.getSettings(organizationId);
    const data: Prisma.OrganizationUpdateInput = {};

    if (
      dto.applyTolerance !== undefined &&
      dto.applyTolerance !== current.attendanceApplyTolerance
    ) {
      data.attendanceApplyTolerance = dto.applyTolerance;
    }

    const numbers = [
      ['lateGraceMinutes', 'attendanceLateGraceMinutes'],
      ['lunchGraceMinutes', 'attendanceLunchGraceMinutes'],
      ['earlyLeaveGraceMinutes', 'attendanceEarlyLeaveGraceMinutes'],
      ['defaultBreakMinutes', 'attendanceDefaultBreakMinutes'],
    ] as const;

    for (const [key, field] of numbers) {
      const value = dto[key];
      if (value !== undefined && value !== current[field]) {
        data[field] = value;
      }
    }

    if (Object.keys(data).length === 0) {
      return current;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data,
        select: {
          attendanceApplyTolerance: true,
          attendanceLateGraceMinutes: true,
          attendanceLunchGraceMinutes: true,
          attendanceEarlyLeaveGraceMinutes: true,
          attendanceDefaultBreakMinutes: true,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.settings_updated',
          entity: 'Organization',
          entityId: organizationId,
          oldValues: current,
          newValues: organization,
        },
      });

      return organization;
    });

    return updated;
  }

  private rulesFromOrganization(organization: {
    attendanceApplyTolerance: boolean;
    attendanceLateGraceMinutes: number;
    attendanceLunchGraceMinutes: number;
    attendanceEarlyLeaveGraceMinutes: number;
    attendanceDefaultBreakMinutes: number;
  }): AttendanceRules {
    return {
      applyTolerance: organization.attendanceApplyTolerance,
      lateGraceMinutes: organization.attendanceLateGraceMinutes,
      lunchGraceMinutes: organization.attendanceLunchGraceMinutes,
      earlyLeaveGraceMinutes: organization.attendanceEarlyLeaveGraceMinutes,
      defaultBreakMinutes: organization.attendanceDefaultBreakMinutes,
    };
  }

  private async rules(organizationId: string): Promise<AttendanceRules> {
    return this.rulesFromOrganization(await this.getSettings(organizationId));
  }

  // --------------------------------------------------------------------------
  // Horario
  // --------------------------------------------------------------------------

  private async scheduleEntryFor(
    organizationId: string,
    branchId: string | null,
    userId: string,
    date: Date,
  ) {
    const weekStart = startOfWeek(date);
    const schedules = await this.prisma.schedule.findMany({
      where: {
        organizationId,
        weekStart,
        ...(branchId
          ? { OR: [{ branchId }, { branchId: null }] }
          : { branchId: null }),
      },
      include: {
        entries: {
          where: { userId, date: startOfDay(date) },
        },
      },
    });

    const schedule = pickSchedule(schedules, branchId);

    return schedule?.entries[0] ?? null;
  }

  private entryRange(entry: {
    date: Date;
    startTime: string;
    endTime: string;
  }) {
    return scheduledRange(new Date(entry.date), entry.startTime, entry.endTime);
  }

  // --------------------------------------------------------------------------
  // Checadas
  // --------------------------------------------------------------------------

  private shiftWorkedMinutes(
    shift: {
      effectiveStartedAt: Date | null;
      startedAt: Date;
      effectiveEndedAt: Date | null;
      endedAt: Date | null;
      breaks?: Array<{
        startedAt: Date;
        endedAt: Date | null;
        effectiveMinutes: number | null;
      }>;
      adjustments?: Array<{ minutes: number }>;
    },
    now = new Date(),
  ): number {
    const start = shift.effectiveStartedAt ?? shift.startedAt;
    const end =
      shift.effectiveEndedAt ?? shift.endedAt ?? now;
    const breakMinutes = (shift.breaks ?? []).reduce((sum, row) => {
      if (row.effectiveMinutes !== null) return sum + row.effectiveMinutes;
      const endBreak = row.endedAt ?? now;
      return sum + minutesBetween(row.startedAt, endBreak);
    }, 0);
    const adjustments = (shift.adjustments ?? []).reduce(
      (sum, row) => sum + row.minutes,
      0,
    );

    return Math.max(0, minutesBetween(start, end) - breakMinutes + adjustments);
  }

  private toShiftView(shift: ShiftWithDetails) {
    return {
      ...shift,
      workedMinutes: this.shiftWorkedMinutes(shift),
    };
  }

  async current(organizationId: string | null, userId: string) {
    if (!organizationId) return null;

    const shift = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: shiftInclude,
    });

    return shift ? this.toShiftView(shift) : null;
  }

  async clockIn(
    organizationId: string | null,
    userId: string,
    branchId: string | null,
    note?: string,
    options: PunchOptions = {},
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const existing = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ya tienes un turno abierto');
    }

    const now = new Date();
    const dayStart = startOfDay(now);
    const alreadyToday = await this.prisma.shift.findFirst({
      where: {
        organizationId,
        userId,
        startedAt: { gte: dayStart, lt: addDays(dayStart, 1) },
      },
      select: { id: true },
    });

    if (alreadyToday) {
      throw new ConflictException('Ya existe un turno registrado hoy');
    }

    const rules = await this.rules(organizationId);
    const entry = await this.scheduleEntryFor(
      organizationId,
      branchId,
      userId,
      now,
    );
    const range = entry ? this.entryRange(entry) : null;
    const effective = range
      ? effectiveStart(now, range.start, rules)
      : now;
    const geofence = await this.geofenceStatus(organizationId, branchId, options);

    const shift = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shift.create({
        data: {
          organizationId,
          branchId,
          userId,
          startedAt: now,
          effectiveStartedAt: effective,
          scheduleEntryId: entry?.id ?? null,
          scheduledStartedAt: range?.start ?? null,
          scheduledEndedAt: range?.end ?? null,
          note: note?.trim() || null,
          recordedById: options.recordedById ?? null,
          source: options.source ?? AttendanceSource.WEB,
          withinGeofence: geofence,
          needsReview: geofence === false,
        },
        include: shiftInclude,
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId,
          shiftId: created.id,
          userId,
          type: AttendanceEventType.CLOCK_IN,
          occurredAt: now,
          recordedById: options.recordedById ?? null,
          source: options.source ?? AttendanceSource.WEB,
          withinGeofence: geofence,
          latitude: options.latitude ?? null,
          longitude: options.longitude ?? null,
          note: note?.trim() || null,
          idempotencyKey: options.idempotencyKey?.trim() || null,
          metadata: {
            effectiveStartedAt: effective.toISOString(),
            scheduledStartedAt: range?.start.toISOString() ?? null,
            scheduleEntryId: entry?.id ?? null,
          },
        },
      });

      return created;
    });

    return this.toShiftView(shift);
  }

  async startBreak(
    organizationId: string | null,
    userId: string,
    type: ShiftBreakType,
    note?: string,
    options: PunchOptions = {},
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const shift = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: shiftInclude,
    });

    if (!shift) {
      throw new BadRequestException('No tienes un turno abierto');
    }

    const openBreak = shift.breaks.find((row) => !row.endedAt);

    if (openBreak) {
      throw new ConflictException('Ya hay una comida o descanso abierto');
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.shiftBreak.create({
        data: {
          shiftId: shift.id,
          type,
          startedAt: now,
          note: note?.trim() || null,
        },
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId,
          type:
            type === ShiftBreakType.LUNCH
              ? AttendanceEventType.LUNCH_START
              : AttendanceEventType.BREAK_START,
          occurredAt: now,
          recordedById: options.recordedById ?? null,
          source: options.source ?? AttendanceSource.WEB,
          latitude: options.latitude ?? null,
          longitude: options.longitude ?? null,
          note: note?.trim() || null,
          idempotencyKey: options.idempotencyKey?.trim() || null,
        },
      });
    });

    return this.getShiftView(organizationId, shift.id);
  }

  async endBreak(
    organizationId: string | null,
    userId: string,
    note?: string,
    options: PunchOptions = {},
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const shift = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: shiftInclude,
    });

    if (!shift) {
      throw new BadRequestException('No tienes un turno abierto');
    }

    const openBreak = shift.breaks.find((row) => !row.endedAt);

    if (!openBreak) {
      throw new BadRequestException('No hay una comida o descanso abierto');
    }

    const now = new Date();
    const rules = await this.rules(organizationId);
    const plannedMinutes =
      shift.scheduleEntry?.breakMinutes ?? rules.defaultBreakMinutes;
    const rawMinutes = minutesBetween(openBreak.startedAt, now);
    const effectiveMinutes = effectiveBreakMinutes(
      rawMinutes,
      plannedMinutes,
      rules,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.shiftBreak.update({
        where: { id: openBreak.id },
        data: {
          endedAt: now,
          effectiveMinutes,
          note: note?.trim() || openBreak.note,
        },
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId,
          type:
            openBreak.type === ShiftBreakType.LUNCH
              ? AttendanceEventType.LUNCH_END
              : AttendanceEventType.BREAK_END,
          occurredAt: now,
          recordedById: options.recordedById ?? null,
          source: options.source ?? AttendanceSource.WEB,
          latitude: options.latitude ?? null,
          longitude: options.longitude ?? null,
          note: note?.trim() || null,
          idempotencyKey: options.idempotencyKey?.trim() || null,
          metadata: {
            rawMinutes,
            effectiveMinutes,
            plannedMinutes,
          },
        },
      });
    });

    return this.getShiftView(organizationId, shift.id);
  }

  async clockOut(
    organizationId: string | null,
    userId: string,
    note?: string,
    options: PunchOptions = {},
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    let shift = await this.prisma.shift.findFirst({
      where: { organizationId, userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: shiftInclude,
    });

    if (!shift) {
      throw new BadRequestException('No tienes un turno abierto');
    }

    // Si olvidó cerrar la comida, se cierra con la salida.
    if (shift.breaks.some((row) => !row.endedAt)) {
      await this.endBreak(organizationId, userId, undefined, options);
      shift = await this.prisma.shift.findFirstOrThrow({
        where: { id: shift.id },
        include: shiftInclude,
      });
    }

    const now = new Date();
    const rules = await this.rules(organizationId);
    const scheduledEnd = shift.scheduledEndedAt;
    const effective = scheduledEnd
      ? effectiveEnd(now, scheduledEnd, rules)
      : now;
    const geofence = await this.geofenceStatus(organizationId, shift.branchId, options);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.shift.update({
        where: { id: shift.id },
        data: {
          endedAt: now,
          effectiveEndedAt: effective,
          note: note?.trim() || shift.note,
          withinGeofence:
            geofence === null ? shift.withinGeofence : geofence,
          needsReview:
            geofence === false ? true : shift.needsReview,
        },
        include: shiftInclude,
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId,
          type: AttendanceEventType.CLOCK_OUT,
          occurredAt: now,
          recordedById: options.recordedById ?? null,
          source: options.source ?? AttendanceSource.WEB,
          withinGeofence: geofence,
          latitude: options.latitude ?? null,
          longitude: options.longitude ?? null,
          note: note?.trim() || null,
          idempotencyKey: options.idempotencyKey?.trim() || null,
          metadata: {
            effectiveEndedAt: effective.toISOString(),
            scheduledEndedAt: scheduledEnd?.toISOString() ?? null,
          },
        },
      });

      return result;
    });

    return this.toShiftView(updated);
  }

  private async getShiftView(organizationId: string, shiftId: string) {
    const shift = await this.prisma.shift.findFirstOrThrow({
      where: { id: shiftId, organizationId },
      include: shiftInclude,
    });

    return this.toShiftView(shift);
  }

  private async geofenceStatus(
    organizationId: string,
    branchId: string | null,
    options: Pick<PunchOptions, 'latitude' | 'longitude'>,
  ): Promise<boolean | null> {
    if (options.latitude === undefined || options.longitude === undefined) {
      return null;
    }

    const [organization, branch] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { latitude: true, longitude: true },
      }),
      branchId
        ? this.prisma.branch.findFirst({
            where: { id: branchId, organizationId },
            select: {
              latitude: true,
              longitude: true,
              geofenceRadiusMeters: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const latitude = branch?.latitude ?? organization?.latitude;
    const longitude = branch?.longitude ?? organization?.longitude;

    if (latitude === null || longitude === null) return null;

    const radius = branch?.geofenceRadiusMeters ?? 150;
    const distance = distanceKm(
      { latitude: Number(latitude), longitude: Number(longitude) },
      { latitude: options.latitude, longitude: options.longitude },
    );

    return distance * 1000 <= radius;
  }

  // --------------------------------------------------------------------------
  // Kiosko
  // --------------------------------------------------------------------------

  private async requireKioskOperator(
    organizationId: string | null,
    operatorId: string,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId: operatorId, organizationId, isActive: true },
      select: { id: true, attendanceKioskEnabled: true },
    });

    if (!membership?.attendanceKioskEnabled) {
      throw new ForbiddenException('Esta cuenta no está habilitada como checador');
    }

    return membership;
  }

  async kiosk(
    organizationId: string | null,
    branchId: string | null,
    operatorId: string,
  ) {
    await this.requireKioskOperator(organizationId, operatorId);
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const weekStart = startOfWeek(today);

    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        isActive: true,
        user: { isActive: true },
      },
      select: {
        userId: true,
        roles: true,
        pinHash: true,
        pinLockedUntil: true,
        user: { select: { id: true, name: true, username: true } },
      },
      orderBy: { user: { name: 'asc' } },
    });

    const userIds = memberships.map((membership) => membership.userId);

    const [schedules, shifts] = await Promise.all([
      this.prisma.schedule.findMany({
        where: {
          organizationId,
          weekStart,
          ...(branchId
            ? { OR: [{ branchId }, { branchId: null }] }
            : { branchId: null }),
        },
        include: {
          entries: { where: { date: today } },
        },
      }),
      userIds.length
        ? this.prisma.shift.findMany({
            where: {
              organizationId,
              userId: { in: userIds },
              OR: [
                { startedAt: { gte: today, lt: tomorrow } },
                { endedAt: null },
              ],
            },
            include: { breaks: true },
          })
        : [],
    ]);

    const schedule = pickSchedule(schedules, branchId);
    const entryByUser = new Map(
      (schedule?.entries ?? []).map((entry) => [entry.userId, entry]),
    );

    const shiftByUser = new Map(shifts.map((shift) => [shift.userId, shift]));

    // Si quedó un turno abierto de otro día, debe poder cerrarse desde el
    // checador; tiene prioridad sobre el turno ya cerrado de hoy.
    for (const shift of shifts) {
      const current = shiftByUser.get(shift.userId);
      if (!shift.endedAt && current?.endedAt) {
        shiftByUser.set(shift.userId, shift);
      }
    }

    const now = new Date();

    const employees = memberships.map((membership) => {
      const entry = entryByUser.get(membership.userId);
      const shift = shiftByUser.get(membership.userId);
      const openBreak = shift?.breaks.find((row) => !row.endedAt);

      return {
        id: membership.userId,
        name: membership.user.name,
        username: membership.user.username,
        roles: membership.roles,
        scheduledStart: entry?.startTime ?? null,
        scheduledEnd: entry?.endTime ?? null,
        breakMinutes: entry?.breakMinutes ?? null,
        hasPin: Boolean(membership.pinHash),
        pinLocked: Boolean(
          membership.pinLockedUntil && membership.pinLockedUntil > now,
        ),
        status: shift
          ? openBreak
            ? 'ON_BREAK'
            : shift.endedAt
              ? 'DONE'
              : 'WORKING'
          : 'OFF',
        shiftId: shift?.id ?? null,
      };
    });

    // Primero quienes tienen horario hoy; después el resto por nombre.
    employees.sort((a, b) => {
      const bySchedule = Number(!a.scheduledStart) - Number(!b.scheduledStart);

      if (bySchedule !== 0) return bySchedule;

      return (a.name ?? a.username ?? '').localeCompare(
        b.name ?? b.username ?? '',
        'es',
      );
    });

    return {
      date: dateKey(today),
      branchId,
      settings: await this.getSettings(organizationId),
      employees,
    };
  }

  async kioskPunch(
    organizationId: string | null,
    branchId: string | null,
    operatorId: string,
    dto: KioskPunchDto,
  ) {
    await this.requireKioskOperator(organizationId, operatorId);
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: dto.userId,
        organizationId,
        isActive: true,
        user: { isActive: true },
      },
      select: {
        id: true,
        pinHash: true,
        pinAttempts: true,
        pinLockedUntil: true,
        user: { select: { id: true, name: true, username: true } },
      },
    });

    if (!membership) {
      throw new BadRequestException(
        'No encontramos una cuenta activa para ese empleado',
      );
    }

    if (!membership.pinHash) {
      throw new BadRequestException(
        'Esta cuenta no tiene PIN configurado. Configúralo desde Usuarios o en Ajustes.',
      );
    }

    if (membership.pinLockedUntil && membership.pinLockedUntil > new Date()) {
      throw new ForbiddenException(
        'PIN bloqueado por intentos fallidos. Intenta en unos minutos.',
      );
    }

    const valid = await verify(membership.pinHash, dto.pin).catch(() => false);

    if (!valid) {
      const attempts = membership.pinAttempts + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;

      await this.prisma.membership.update({
        where: { id: membership.id },
        data: {
          pinAttempts: locked ? 0 : attempts,
          ...(locked
            ? { pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) }
            : {}),
        },
      });

      throw new BadRequestException(
        locked
          ? 'PIN bloqueado por intentos fallidos. Intenta en unos minutos.'
          : 'PIN incorrecto',
      );
    }

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { pinAttempts: 0, pinLockedUntil: null },
    });

    const options: PunchOptions = {
      recordedById: operatorId,
      source: AttendanceSource.KIOSK,
      note: dto.note,
      latitude: dto.latitude,
      longitude: dto.longitude,
      idempotencyKey: dto.idempotencyKey,
    };

    if (dto.action === PunchAction.CLOCK_IN) {
      await this.clockIn(organizationId, dto.userId, branchId, dto.note, options);
    } else if (dto.action === PunchAction.LUNCH_START) {
      await this.startBreak(
        organizationId,
        dto.userId,
        ShiftBreakType.LUNCH,
        dto.note,
        options,
      );
    } else if (dto.action === PunchAction.LUNCH_END) {
      await this.endBreak(organizationId, dto.userId, dto.note, options);
    } else {
      await this.clockOut(organizationId, dto.userId, dto.note, options);
    }

    return {
      ok: true,
      action: dto.action,
      employee: membership.user,
    };
  }

  // --------------------------------------------------------------------------
  // Ajustes y revisión
  // --------------------------------------------------------------------------

  async adjust(
    organizationId: string | null,
    actorUserId: string,
    shiftId: string,
    dto: AttendanceAdjustmentDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, organizationId },
      select: { id: true, userId: true, branchId: true },
    });

    if (!shift) throw new NotFoundException('Turno no encontrado');

    if (dto.minutes <= 0) {
      throw new BadRequestException(
        'El ajuste solo puede agregar minutos, nunca restarlos',
      );
    }

    const adjustment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.attendanceAdjustment.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId: shift.userId,
          minutes: dto.minutes,
          reason: dto.reason.trim(),
          createdById: actorUserId,
        },
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId: shift.userId,
          type: AttendanceEventType.ADJUSTMENT,
          occurredAt: new Date(),
          recordedById: actorUserId,
          source: AttendanceSource.ADMIN,
          note: dto.reason.trim(),
          metadata: {
            adjustmentId: created.id,
            minutes: dto.minutes,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.adjustment',
          entity: 'Shift',
          entityId: shift.id,
          newValues: { minutes: dto.minutes, reason: dto.reason.trim() },
        },
      });

      return created;
    });

    return adjustment;
  }

  async square(
    organizationId: string | null,
    actorUserId: string,
    shiftId: string,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, organizationId },
      include: shiftInclude,
    });

    if (!shift) throw new NotFoundException('Turno no encontrado');

    if (!shift.scheduledStartedAt || !shift.scheduledEndedAt) {
      throw new BadRequestException(
        'El turno no tiene un horario asignado para cuadrar',
      );
    }

    const plannedBreak = shift.scheduleEntry?.breakMinutes ?? 0;
    const targetMinutes = Math.max(
      0,
      minutesBetween(shift.scheduledStartedAt, shift.scheduledEndedAt) -
        plannedBreak,
    );
    const currentMinutes = this.shiftWorkedMinutes(shift);
    const missing = targetMinutes - currentMinutes;

    if (missing <= 0) {
      throw new BadRequestException(
        'El turno ya cumple o supera las horas programadas',
      );
    }

    return this.adjust(organizationId, actorUserId, shiftId, {
      minutes: missing,
      reason: 'Cuadre automático de horas',
    });
  }

  async review(
    organizationId: string | null,
    actorUserId: string,
    shiftId: string,
    dto: ReviewShiftDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, organizationId },
      select: { id: true, userId: true, branchId: true },
    });

    if (!shift) throw new NotFoundException('Turno no encontrado');

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.shift.update({
        where: { id: shift.id },
        data: {
          needsReview: false,
          reviewedById: actorUserId,
          reviewedAt: now,
        },
        include: shiftInclude,
      });

      await tx.attendanceEvent.create({
        data: {
          organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          userId: shift.userId,
          type: AttendanceEventType.REVIEW,
          occurredAt: now,
          recordedById: actorUserId,
          source: AttendanceSource.ADMIN,
          note: dto.note?.trim() || (dto.approve ? 'Autorizado' : 'Rechazado'),
          metadata: { approved: dto.approve },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.reviewed',
          entity: 'Shift',
          entityId: shift.id,
          newValues: { approved: dto.approve, note: dto.note?.trim() || null },
        },
      });

      return result;
    });

    return this.toShiftView(updated);
  }

  async events(organizationId: string | null, shiftId: string) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, organizationId },
      select: { id: true },
    });

    if (!shift) throw new NotFoundException('Turno no encontrado');

    return this.prisma.attendanceEvent.findMany({
      where: { shiftId, organizationId },
      orderBy: { occurredAt: 'asc' },
      include: {
        recordedBy: { select: { id: true, name: true, username: true } },
      },
    });
  }

  // --------------------------------------------------------------------------
  // Consultas y propinas
  // --------------------------------------------------------------------------

  async list(
    organizationId: string | null,
    branchId: string | null,
    from?: string,
    to?: string,
  ) {
    if (!organizationId) return { shifts: [], hours: 0 };

    const start = from ? new Date(`${from}T00:00:00`) : null;
    const end = to ? new Date(`${to}T23:59:59.999`) : null;

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
      include: shiftInclude,
    });

    const views = shifts.map((shift) => this.toShiftView(shift));
    const minutes = views.reduce((sum, shift) => sum + shift.workedMinutes, 0);

    return { shifts: views, hours: Math.round((minutes / 60) * 100) / 100 };
  }

  async me(
    organizationId: string | null,
    userId: string,
    branchId: string | null,
  ) {
    if (!organizationId) {
      return {
        current: null,
        shifts: [],
        schedule: [],
        settings: null,
        tips: null,
        kioskEnabled: false,
      };
    }

    const today = new Date();
    const from = startOfDay(addDays(today, -6));
    const to = addDays(today, 14);

    const [current, shifts, schedule, settings, tips, membership] =
      await Promise.all([
        this.current(organizationId, userId),
        this.prisma.shift.findMany({
          where: {
            organizationId,
            userId,
            startedAt: { gte: from },
            ...(branchId ? { branchId } : {}),
          },
          orderBy: { startedAt: 'desc' },
          include: shiftInclude,
        }),
        this.personalSchedule(organizationId, branchId, userId, from, to),
        this.getSettings(organizationId),
        this.myTips(organizationId, branchId, userId),
        this.prisma.membership.findFirst({
          where: { organizationId, userId, isActive: true },
          select: { attendanceKioskEnabled: true },
        }),
      ]);

    return {
      current,
      shifts: shifts.map((shift) => this.toShiftView(shift)),
      schedule,
      settings,
      tips,
      kioskEnabled: membership?.attendanceKioskEnabled ?? false,
    };
  }

  private async personalSchedule(
    organizationId: string,
    branchId: string | null,
    userId: string,
    from: Date,
    to: Date,
  ) {
    const weekStarts: Date[] = [];
    for (let cursor = startOfWeek(from); cursor <= to; cursor = addDays(cursor, 7)) {
      weekStarts.push(cursor);
    }

    if (weekStarts.length === 0) return [];

    const schedules = await this.prisma.schedule.findMany({
      where: {
        organizationId,
        weekStart: { in: weekStarts },
        status: ScheduleStatus.PUBLISHED,
        ...(branchId
          ? { OR: [{ branchId }, { branchId: null }] }
          : { branchId: null }),
      },
      include: {
        entries: {
          where: { userId, date: { gte: startOfDay(from), lte: to } },
          orderBy: { date: 'asc' },
        },
      },
    });

    return schedules
      .flatMap((schedule) => schedule.entries)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  async myTips(
    organizationId: string | null,
    branchId: string | null,
    userId: string,
  ) {
    if (!organizationId) return null;

    const distribution = await this.tipsDistribution(
      organizationId,
      branchId,
      undefined,
      undefined,
    );
    const mine = distribution.participants.find((row) => row.userId === userId);

    return {
      pool: distribution.pool,
      totalWeight: distribution.totalWeight,
      participant: mine ?? null,
    };
  }

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

    const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
    const start = from
      ? new Date(`${from}T00:00:00`)
      : new Date(end.getFullYear(), end.getMonth(), 1, 0, 0, 0, 0);

    const weights = { ...DEFAULT_WEIGHTS };

    if (weightsRaw) {
      for (const pair of weightsRaw.split(',')) {
        const [role, value] = pair.split(':');
        const key = role?.trim().toUpperCase() as Role;
        const weight = Number(value);

        if (key in DEFAULT_WEIGHTS && Number.isFinite(weight) && weight >= 0) {
          weights[key] = weight;
        }
      }
    }

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
        include: {
          breaks: true,
          adjustments: true,
        },
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
    const now = new Date();

    for (const shift of shifts) {
      const shiftStart = shift.effectiveStartedAt ?? shift.startedAt;
      const shiftEnd =
        shift.effectiveEndedAt ??
        shift.endedAt ??
        new Date(Math.min(now.getTime(), end.getTime()));
      const overlap =
        Math.min(shiftEnd.getTime(), end.getTime()) -
        Math.max(shiftStart.getTime(), start.getTime());

      if (overlap <= 0) continue;

      const breakMinutes = (shift.breaks ?? []).reduce((sum, row) => {
        if (row.effectiveMinutes !== null) return sum + row.effectiveMinutes;
        const breakEnd = row.endedAt ?? now;
        return sum + minutesBetween(row.startedAt, breakEnd);
      }, 0);
      const adjustments = (shift.adjustments ?? []).reduce(
        (sum, row) => sum + row.minutes,
        0,
      );
      const workedMinutes =
        overlap / 60_000 - breakMinutes + adjustments;

      if (workedMinutes <= 0) continue;

      hoursOf.set(
        shift.userId,
        (hoursOf.get(shift.userId) ?? 0) + workedMinutes / 60,
      );
    }

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

  // --------------------------------------------------------------------------
  // Horarios (admin)
  // --------------------------------------------------------------------------

  async scheduleWeek(
    organizationId: string | null,
    branchId: string | null,
    weekStartRaw: string,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const weekStart = startOfWeek(new Date(`${weekStartRaw}T00:00:00`));
    const [schedule, memberships, templates, settings, kiosk] =
      await Promise.all([
        this.prisma.schedule.findFirst({
          where: {
            organizationId,
            branchId,
            weekStart,
          },
          include: { entries: { orderBy: { date: 'asc' } } },
        }),
        this.prisma.membership.findMany({
          where: { organizationId, isActive: true, user: { isActive: true } },
          select: {
            userId: true,
            roles: true,
            attendanceKioskEnabled: true,
            user: { select: { id: true, name: true, username: true } },
          },
          orderBy: { user: { name: 'asc' } },
        }),
        this.prisma.shiftTemplate.findMany({
          where: { organizationId, isActive: true },
          orderBy: { name: 'asc' },
        }),
        this.getSettings(organizationId),
        this.listKioskOperators(organizationId),
      ]);

    return {
      weekStart: dateKey(weekStart),
      branchId,
      status: schedule?.status ?? ScheduleStatus.DRAFT,
      publishedAt: schedule?.publishedAt ?? null,
      entries: schedule?.entries ?? [],
      employees: memberships.map((membership) => ({
        id: membership.userId,
        name: membership.user.name,
        username: membership.user.username,
        roles: membership.roles,
        kioskEnabled: membership.attendanceKioskEnabled,
      })),
      templates,
      settings,
      kioskOperators: kiosk,
    };
  }

  async saveSchedule(
    organizationId: string | null,
    actorUserId: string,
    dto: SaveScheduleDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const weekStart = startOfWeek(new Date(`${dto.weekStart}T00:00:00`));
    const weekEnd = addDays(weekStart, 7);
    const branchId = dto.branchId ?? null;

    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, organizationId },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Sucursal no encontrada');
    }

    const seen = new Set<string>();

    for (const entry of dto.entries) {
      const date = new Date(`${entry.date}T00:00:00`);

      if (Number.isNaN(date.getTime()) || date < weekStart || date >= weekEnd) {
        throw new BadRequestException(
          `La fecha ${entry.date} no pertenece a la semana seleccionada`,
        );
      }

      if (entry.startTime === entry.endTime) {
        throw new BadRequestException(
          'La entrada y la salida no pueden ser iguales',
        );
      }

      const key = `${entry.userId}:${entry.date}`;

      if (seen.has(key)) {
        throw new BadRequestException(
          'Hay dos turnos para la misma persona en el mismo día',
        );
      }
      seen.add(key);
    }

    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        isActive: true,
        userId: { in: [...new Set(dto.entries.map((entry) => entry.userId))] },
      },
      select: { userId: true },
    });
    const allowed = new Set(memberships.map((membership) => membership.userId));

    for (const entry of dto.entries) {
      if (!allowed.has(entry.userId)) {
        throw new BadRequestException(
          'Uno de los usuarios no pertenece al negocio',
        );
      }
    }

    const schedule = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.schedule.findFirst({
        where: { organizationId, branchId, weekStart },
        select: { id: true },
      });

      const target = existing
        ? existing
        : await tx.schedule.create({
            data: { organizationId, branchId, weekStart },
          });

      await tx.scheduleEntry.deleteMany({ where: { scheduleId: target.id } });

      if (dto.entries.length > 0) {
        await tx.scheduleEntry.createMany({
          data: dto.entries.map((entry) => ({
            scheduleId: target.id,
            userId: entry.userId,
            date: new Date(`${entry.date}T00:00:00`),
            startTime: entry.startTime,
            endTime: entry.endTime,
            breakMinutes: entry.breakMinutes ?? 60,
            note: entry.note?.trim() || null,
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.schedule_saved',
          entity: 'Schedule',
          entityId: target.id,
          newValues: {
            weekStart: dateKey(weekStart),
            branchId,
            entries: dto.entries.length,
          },
        },
      });

      return target;
    });

    return this.scheduleWeek(organizationId, branchId, dateKey(weekStart));
  }

  async publishSchedule(
    organizationId: string | null,
    actorUserId: string,
    dto: ScheduleWeekDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const weekStart = startOfWeek(new Date(`${dto.weekStart}T00:00:00`));
    const branchId = dto.branchId ?? null;
    const schedule = await this.prisma.schedule.findFirst({
      where: { organizationId, branchId, weekStart },
      select: { id: true },
    });

    if (!schedule) throw new NotFoundException('Horario no encontrado');

    await this.prisma.$transaction(async (tx) => {
      await tx.schedule.update({
        where: { id: schedule.id },
        data: {
          status: ScheduleStatus.PUBLISHED,
          publishedAt: new Date(),
          publishedById: actorUserId,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.schedule_published',
          entity: 'Schedule',
          entityId: schedule.id,
          newValues: { weekStart: dateKey(weekStart), branchId },
        },
      });
    });

    return this.scheduleWeek(organizationId, branchId, dateKey(weekStart));
  }

  async copySchedule(
    organizationId: string | null,
    actorUserId: string,
    dto: CopyScheduleDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const fromWeekStart = startOfWeek(new Date(`${dto.fromWeekStart}T00:00:00`));
    const toWeekStart = startOfWeek(new Date(`${dto.weekStart}T00:00:00`));
    const branchId = dto.branchId ?? null;
    const source = await this.prisma.schedule.findFirst({
      where: { organizationId, branchId, weekStart: fromWeekStart },
      include: { entries: true },
    });

    if (!source) throw new NotFoundException('No hay horario para copiar');

    const shiftDays = Math.round(
      (toWeekStart.getTime() - fromWeekStart.getTime()) / 86_400_000,
    );

    const target = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.schedule.findFirst({
        where: { organizationId, branchId, weekStart: toWeekStart },
        select: { id: true },
      });

      const schedule = existing
        ? await tx.schedule.update({
            where: { id: existing.id },
            data: { status: ScheduleStatus.DRAFT },
          })
        : await tx.schedule.create({
            data: { organizationId, branchId, weekStart: toWeekStart },
          });

      await tx.scheduleEntry.deleteMany({ where: { scheduleId: schedule.id } });

      if (source.entries.length > 0) {
        await tx.scheduleEntry.createMany({
          data: source.entries.map((entry) => ({
            scheduleId: schedule.id,
            userId: entry.userId,
            date: addDays(entry.date, shiftDays),
            startTime: entry.startTime,
            endTime: entry.endTime,
            breakMinutes: entry.breakMinutes,
            note: entry.note,
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.schedule_copied',
          entity: 'Schedule',
          entityId: schedule.id,
          newValues: {
            from: dateKey(fromWeekStart),
            to: dateKey(toWeekStart),
            branchId,
          },
        },
      });

      return schedule;
    });

    return this.scheduleWeek(organizationId, branchId, dateKey(toWeekStart));
  }

  async templates(organizationId: string | null) {
    if (!organizationId) return [];

    return this.prisma.shiftTemplate.findMany({
      where: { organizationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async createTemplate(
    organizationId: string | null,
    actorUserId: string,
    dto: ScheduleTemplateDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const template = await this.prisma.shiftTemplate.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? 60,
        color: dto.color?.trim() || null,
        isActive: dto.isActive ?? true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: actorUserId,
        action: 'attendance.template_created',
        entity: 'ShiftTemplate',
        entityId: template.id,
        newValues: template,
      },
    });

    return template;
  }

  async updateTemplate(
    organizationId: string | null,
    actorUserId: string,
    templateId: string,
    dto: ScheduleTemplateDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const current = await this.prisma.shiftTemplate.findFirst({
      where: { id: templateId, organizationId },
    });
    if (!current) throw new NotFoundException('Plantilla no encontrada');

    const template = await this.prisma.shiftTemplate.update({
      where: { id: templateId },
      data: {
        name: dto.name.trim(),
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? current.breakMinutes,
        color: dto.color?.trim() || null,
        isActive: dto.isActive ?? current.isActive,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: actorUserId,
        action: 'attendance.template_updated',
        entity: 'ShiftTemplate',
        entityId: template.id,
        oldValues: current,
        newValues: template,
      },
    });

    return template;
  }

  async deleteTemplate(
    organizationId: string | null,
    actorUserId: string,
    templateId: string,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const template = await this.prisma.shiftTemplate.findFirst({
      where: { id: templateId, organizationId },
    });
    if (!template) throw new NotFoundException('Plantilla no encontrada');

    await this.prisma.shiftTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: actorUserId,
        action: 'attendance.template_disabled',
        entity: 'ShiftTemplate',
        entityId: templateId,
        oldValues: template,
      },
    });

    return { ok: true };
  }

  async listKioskOperators(organizationId: string | null) {
    if (!organizationId) return [];

    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        isActive: true,
        attendanceKioskEnabled: true,
      },
      select: { userId: true },
    });

    return memberships.map((membership) => membership.userId);
  }

  async setKioskOperators(
    organizationId: string | null,
    actorUserId: string,
    dto: SetKioskOperatorsDto,
  ) {
    if (!organizationId) throw new NotFoundException('Organización no encontrada');

    const userIds = [...new Set(dto.userIds)];

    if (userIds.length > 0) {
      const memberships = await this.prisma.membership.findMany({
        where: { organizationId, isActive: true, userId: { in: userIds } },
        select: { userId: true },
      });
      const allowed = new Set(memberships.map((membership) => membership.userId));

      for (const userId of userIds) {
        if (!allowed.has(userId)) {
          throw new BadRequestException(
            'Uno de los usuarios no pertenece al negocio',
          );
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.membership.updateMany({
        where: { organizationId, attendanceKioskEnabled: true },
        data: { attendanceKioskEnabled: false },
      });

      if (userIds.length > 0) {
        await tx.membership.updateMany({
          where: { organizationId, userId: { in: userIds } },
          data: { attendanceKioskEnabled: true },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId,
          userId: actorUserId,
          action: 'attendance.kiosk_operators_updated',
          entity: 'Membership',
          newValues: { userIds },
        },
      });
    });

    return { userIds };
  }
}
