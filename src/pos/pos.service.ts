import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { hash, verify } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

import { AuthService, type SessionMeta } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePosDisplayDto,
  UpdatePosDisplayStateDto,
} from './dto/pos.dto';

export interface DisplayState {
  sessionKey: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  customerName: string | null;
  tipPercent: number | null;
  confirmedAt: string | null;
  updatedAt: string;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Genera un código/QR de un solo uso para vincular una caja. */
  async createPairing(
    organizationId: string | null,
    branchId: string | null,
    userId: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, organizationId },
        select: { id: true },
      });

      if (!branch) {
        throw new BadRequestException('Sucursal inválida');
      }
    }

    // 64 bits: el código se muestra y se teclea, pero 32 bits eran adivinables
    // con el throttling del endpoint.
    const code = randomBytes(8).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);

    await this.prisma.posPairing.create({
      data: {
        organizationId,
        branchId,
        codeHash: sha256(code),
        createdById: userId,
        expiresAt,
      },
    });

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');

    return {
      code,
      url: `${webOrigin}/pair?code=${code}`,
      expiresAt,
    };
  }

  /** Información pública del código (para la pantalla de vinculación). */
  async pairingInfo(code: string) {
    const pairing = await this.prisma.posPairing.findFirst({
      where: {
        codeHash: sha256(code.toUpperCase()),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        organization: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    if (!pairing) {
      throw new NotFoundException('El código no es válido o ya expiró');
    }

    return {
      organizationName: pairing.organization.name,
      branchName: pairing.branch?.name ?? null,
      expiresAt: pairing.expiresAt,
    };
  }

  /** Reclama el código desde la tablet y crea el dispositivo. */
  async claimPairing(code: string, name?: string) {
    const pairing = await this.prisma.posPairing.findFirst({
      where: {
        codeHash: sha256(code.toUpperCase()),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        organization: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    if (!pairing) {
      throw new NotFoundException('El código no es válido o ya expiró');
    }

    const claimed = await this.prisma.posPairing.updateMany({
      where: {
        id: pairing.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new ConflictException('El código ya fue utilizado');
    }

    const token = randomBytes(32).toString('base64url');

    const device = await this.prisma.posDevice.create({
      data: {
        organizationId: pairing.organizationId,
        branchId: pairing.branchId,
        name: name?.trim() || 'Caja',
        tokenHash: sha256(token),
        pairedById: pairing.createdById,
      },
    });

    return {
      token,
      deviceId: device.id,
      organizationName: pairing.organization.name,
      branchName: pairing.branch?.name ?? null,
      branchId: pairing.branchId,
    };
  }

  /** Datos de la caja vinculada y miembros con PIN para el desbloqueo. */
  async deviceSession(token: string | undefined) {
    const device = await this.requireDevice(token);

    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId: device.organizationId,
        isActive: true,
        user: { isActive: true },
      },
      select: {
        userId: true,
        roles: true,
        pinHash: true,
        user: { select: { id: true, name: true, username: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      organizationName: device.organization.name,
      branchId: device.branchId,
      branchName: device.branch?.name ?? null,
      deviceName: device.name,
      members: memberships.map((membership) => ({
        id: membership.userId,
        name: membership.user.name,
        username: membership.user.username,
        roles: membership.roles,
        hasPin: Boolean(membership.pinHash),
      })),
    };
  }

  /** Login rápido con PIN sobre un dispositivo vinculado. */
  async pinLogin(
    token: string | undefined,
    userId: string,
    pin: string,
    meta: SessionMeta,
  ) {
    const device = await this.requireDevice(token);

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId,
        organizationId: device.organizationId,
        isActive: true,
        user: { isActive: true },
      },
    });

    if (!membership) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!membership.pinHash) {
      throw new BadRequestException(
        'Esta cuenta no tiene PIN configurado. Configúralo desde Ajustes.',
      );
    }

    if (membership.pinLockedUntil && membership.pinLockedUntil > new Date()) {
      throw new ForbiddenException(
        'PIN bloqueado por intentos fallidos. Intenta en unos minutos.',
      );
    }

    const valid = await verify(membership.pinHash, pin);

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

      throw new UnauthorizedException(
        locked
          ? 'PIN bloqueado por intentos fallidos. Intenta en unos minutos.'
          : 'PIN incorrecto',
      );
    }

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { pinAttempts: 0, pinLockedUntil: null },
    });

    const session = await this.auth.issuePosSession(
      userId,
      device.organizationId,
      meta,
    );

    return {
      ...session,
      branchId: device.branchId,
      organizationName: device.organization.name,
    };
  }

  /** Define o cambia el PIN de una membresía. */
  async setPin(
    organizationId: string | null,
    userId: string,
    pin: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const membership = await this.prisma.membership.findFirst({
      where: { userId, organizationId, isActive: true },
      select: { id: true },
    });

    if (!membership) {
      throw new NotFoundException('El usuario no pertenece al negocio');
    }

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: {
        pinHash: await hash(pin),
        pinUpdatedAt: new Date(),
        pinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    return { ok: true };
  }

  listDevices(organizationId: string | null) {
    if (!organizationId) return [];

    return this.prisma.posDevice.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        branchId: true,
        branch: { select: { name: true } },
        lastSeenAt: true,
        createdAt: true,
        pairedBy: { select: { name: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeDevice(organizationId: string | null, id: string) {
    const device = await this.prisma.posDevice.findFirst({
      where: { id, organizationId: organizationId ?? undefined },
    });

    if (!device) {
      throw new NotFoundException('Dispositivo no encontrado');
    }

    await this.prisma.posDevice.update({
      where: { id },
      data: { isActive: false, revokedAt: new Date() },
    });

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Pantalla de cliente
  // --------------------------------------------------------------------------

  /** Crea una pantalla de cliente y devuelve el token/URL para abrirla. */
  async createDisplay(
    organizationId: string | null,
    branchId: string | null,
    userId: string,
    dto: CreatePosDisplayDto,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, organizationId },
        select: { id: true },
      });

      if (!branch) throw new BadRequestException('Sucursal inválida');
    }

    const token = randomBytes(24).toString('base64url');
    const display = await this.prisma.posDisplay.create({
      data: {
        organizationId,
        branchId,
        name: dto.name?.trim() || 'Pantalla de cliente',
        tokenHash: sha256(token),
        createdById: userId,
      },
    });

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');

    return {
      id: display.id,
      name: display.name,
      token,
      url: `${webOrigin}/display/${token}`,
    };
  }

  listDisplays(organizationId: string | null) {
    if (!organizationId) return [];

    return this.prisma.posDisplay.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        name: true,
        branchId: true,
        branch: { select: { name: true } },
        lastSeenAt: true,
        stateUpdatedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeDisplay(organizationId: string | null, id: string) {
    const display = await this.prisma.posDisplay.findFirst({
      where: { id, organizationId: organizationId ?? undefined },
    });

    if (!display) {
      throw new NotFoundException('Pantalla no encontrada');
    }

    await this.prisma.posDisplay.update({
      where: { id },
      data: { isActive: false, revokedAt: new Date() },
    });

    return { ok: true };
  }

  /** Datos públicos que consume la pantalla del cliente. */
  async displayInfo(token: string | undefined) {
    const display = await this.requireDisplay(token);

    const menus = await this.prisma.menu.findMany({
      where: { organizationId: display.organizationId, isActive: true },
      select: { id: true, name: true, description: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 8,
    });

    return {
      organizationName: display.organization.name,
      branchName: display.branch?.name ?? null,
      displayName: display.name,
      state: (display.state as unknown as DisplayState | null) ?? null,
      menus,
    };
  }

  /** El POS publica el carrito actual en la pantalla. */
  async pushDisplayState(
    organizationId: string | null,
    id: string,
    dto: UpdatePosDisplayStateDto,
  ) {
    const display = await this.prisma.posDisplay.findFirst({
      where: {
        id,
        organizationId: organizationId ?? undefined,
        isActive: true,
      },
    });

    if (!display) {
      throw new NotFoundException('Pantalla no encontrada');
    }

    const current = display.state as unknown as DisplayState | null;
    const sameSession = current?.sessionKey === dto.sessionKey;
    const state: DisplayState = {
      sessionKey: dto.sessionKey,
      items: dto.items,
      total: dto.total,
      customerName: dto.customerName?.trim() || null,
      tipPercent: sameSession ? current?.tipPercent ?? null : null,
      confirmedAt: sameSession ? current?.confirmedAt ?? null : null,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.posDisplay.update({
      where: { id },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        stateUpdatedAt: new Date(),
      },
    });

    return state;
  }

  async displayState(organizationId: string | null, id: string) {
    const display = await this.prisma.posDisplay.findFirst({
      where: {
        id,
        organizationId: organizationId ?? undefined,
        isActive: true,
      },
      select: { state: true },
    });

    if (!display) throw new NotFoundException('Pantalla no encontrada');

    return (display.state as unknown as DisplayState | null) ?? null;
  }

  /** El cliente elige propina en la pantalla. */
  async setDisplayTip(token: string | undefined, tipPercent: number) {
    const display = await this.requireDisplay(token);
    const current = display.state as unknown as DisplayState | null;

    if (!current || current.items.length === 0) {
      throw new BadRequestException('No hay un pedido en la pantalla');
    }

    const state: DisplayState = {
      ...current,
      tipPercent,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.posDisplay.update({
      where: { id: display.id },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        stateUpdatedAt: new Date(),
      },
    });

    return state;
  }

  /** El cliente confirma el pedido en la pantalla. */
  async confirmDisplayOrder(token: string | undefined) {
    const display = await this.requireDisplay(token);
    const current = display.state as unknown as DisplayState | null;

    if (!current || current.items.length === 0) {
      throw new BadRequestException('No hay un pedido para confirmar');
    }

    const state: DisplayState = {
      ...current,
      confirmedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.posDisplay.update({
      where: { id: display.id },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        stateUpdatedAt: new Date(),
      },
    });

    return state;
  }

  private async requireDisplay(token: string | undefined) {
    if (!token) {
      throw new UnauthorizedException('Pantalla no vinculada');
    }

    const display = await this.prisma.posDisplay.findFirst({
      where: { tokenHash: sha256(token), isActive: true },
      include: {
        organization: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    if (!display) {
      throw new UnauthorizedException('Pantalla no reconocida');
    }

    // La pantalla consulta cada 1.5 s: se evita escribir en cada lectura.
    if (
      !display.lastSeenAt ||
      Date.now() - display.lastSeenAt.getTime() > 20_000
    ) {
      await this.prisma.posDisplay.update({
        where: { id: display.id },
        data: { lastSeenAt: new Date() },
      });
    }

    return display;
  }

  private async requireDevice(token: string | undefined) {
    if (!token) {
      throw new UnauthorizedException('Esta caja no está vinculada');
    }

    const device = await this.prisma.posDevice.findFirst({
      where: { tokenHash: sha256(token), isActive: true },
      include: {
        organization: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    if (!device) {
      throw new UnauthorizedException('Dispositivo no reconocido');
    }

    await this.prisma.posDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return device;
  }
}
