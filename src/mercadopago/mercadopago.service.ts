import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { UpdateMercadoPagoTerminalDto } from './dto/update-terminal.dto';

export interface MercadoPagoConnectionView {
  mpUserId: string;
  status: string;
  expiresAt: Date;
  connectedAt: Date;
  lastRefreshedAt: Date | null;
  needsReconnect: boolean;
}

export interface MercadoPagoTerminalView {
  id: string;
  terminalId: string;
  name: string | null;
  branchId: string | null;
  operatingMode: string | null;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt: Date | null;
}

export interface MercadoPagoStatus {
  configured: boolean;
  connected: boolean;
  connection: MercadoPagoConnectionView | null;
  terminals: MercadoPagoTerminalView[];
}

export type CallbackResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Orquesta la conexión OAuth por organización y la sincronización de
 * terminales Point. Los cobros viven en `MercadoPagoPointService`.
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
  ) {}

  get configured(): boolean {
    return this.client.isConfigured;
  }

  async getStatus(organizationId: string): Promise<MercadoPagoStatus> {
    const [connection, terminals] = await Promise.all([
      this.prisma.mercadoPagoConnection.findUnique({
        where: { organizationId },
      }),
      this.prisma.mercadoPagoTerminal.findMany({
        where: { organizationId },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    ]);

    return {
      configured: this.client.isConfigured,
      connected: Boolean(connection),
      connection: connection
        ? {
            mpUserId: connection.mpUserId,
            status: connection.status,
            expiresAt: connection.expiresAt,
            connectedAt: connection.connectedAt,
            lastRefreshedAt: connection.lastRefreshedAt,
            needsReconnect:
              connection.status !== 'ACTIVE' ||
              connection.expiresAt.getTime() <= Date.now(),
          }
        : null,
      terminals: terminals.map((terminal) => ({
        id: terminal.id,
        terminalId: terminal.terminalId,
        name: terminal.name,
        branchId: terminal.branchId,
        operatingMode: terminal.operatingMode,
        isDefault: terminal.isDefault,
        isActive: terminal.isActive,
        lastSyncedAt: terminal.lastSyncedAt,
      })),
    };
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    return this.client.authorizationUrl(state, codeChallenge);
  }

  /**
   * Canjea el código OAuth y guarda la conexión.
   *
   * `organizationId` y `userId` vienen de la cookie httpOnly firmada por
   * nosotros; además se comprueba que el usuario siga siendo ADMIN de esa
   * organización para que una cookie manipulada no vincule cuentas ajenas.
   */
  async handleCallback(params: {
    organizationId: string;
    userId: string;
    code: string;
    codeVerifier: string;
  }): Promise<CallbackResult> {
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: params.userId,
        organizationId: params.organizationId,
        isActive: true,
        roles: { has: Role.ADMIN },
      },
      select: { id: true },
    });

    if (!membership) {
      return { ok: false, reason: 'session' };
    }

    let tokens;
    try {
      tokens = await this.client.exchangeCode(
        params.code,
        params.codeVerifier,
      );
    } catch (error) {
      this.logger.warn(
        `Mercado Pago rechazó el código OAuth: ${(error as Error).message}`,
      );
      return { ok: false, reason: 'exchange' };
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      return { ok: false, reason: 'exchange' };
    }

    try {
      await this.client.getUser(tokens.access_token);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la cuenta de Mercado Pago: ${
          (error as Error).message
        }`,
      );
      return { ok: false, reason: 'account' };
    }

    await this.tokens.save(
      params.organizationId,
      params.userId,
      tokens,
    );

    // La sincronización es best-effort: si MP falla, la conexión ya quedó
    // guardada y el usuario puede reintentar desde Configuración.
    try {
      await this.syncTerminals(params.organizationId);
    } catch (error) {
      this.logger.warn(
        `No se pudieron sincronizar las terminales: ${
          (error as Error).message
        }`,
      );
    }

    return { ok: true };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.tokens.disconnect(organizationId);
  }

  /** Lista las terminales locales, sincronizando primero con Mercado Pago. */
  async listTerminals(organizationId: string): Promise<MercadoPagoTerminalView[]> {
    await this.syncTerminals(organizationId);

    const terminals = await this.prisma.mercadoPagoTerminal.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    return terminals.map((terminal) => ({
      id: terminal.id,
      terminalId: terminal.terminalId,
      name: terminal.name,
      branchId: terminal.branchId,
      operatingMode: terminal.operatingMode,
      isDefault: terminal.isDefault,
      isActive: terminal.isActive,
      lastSyncedAt: terminal.lastSyncedAt,
    }));
  }

  async syncTerminals(organizationId: string): Promise<void> {
    const accessToken = await this.tokens.getAccessToken(organizationId);
    const remote = await this.client.listTerminals(accessToken);
    const now = new Date();
    const seen: string[] = [];

    for (const terminal of remote) {
      const terminalId = String(terminal.id ?? '').trim();
      if (!terminalId) continue;

      seen.push(terminalId);

      await this.prisma.mercadoPagoTerminal.upsert({
        where: {
          organizationId_terminalId: {
            organizationId,
            terminalId,
          },
        },
        create: {
          organizationId,
          terminalId,
          name: terminal.name ?? null,
          operatingMode: terminal.operating_mode ?? null,
          lastSyncedAt: now,
        },
        update: {
          name: terminal.name ?? null,
          operatingMode: terminal.operating_mode ?? null,
          lastSyncedAt: now,
          isActive: true,
        },
      });
    }

    await this.prisma.mercadoPagoTerminal.updateMany({
      where: {
        organizationId,
        terminalId: { notIn: seen },
      },
      data: { isActive: false },
    });

    await this.ensureDefaultTerminal(organizationId);
  }

  async updateTerminal(
    organizationId: string,
    id: string,
    dto: UpdateMercadoPagoTerminalDto,
  ): Promise<MercadoPagoTerminalView> {
    const terminal = await this.prisma.mercadoPagoTerminal.findFirst({
      where: { id, organizationId },
    });

    if (!terminal) {
      throw new NotFoundException('Terminal no encontrada');
    }

    const branchId = dto.branchId;

    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, organizationId },
        select: { id: true },
      });

      if (!branch) {
        throw new BadRequestException('La sucursal no pertenece al negocio');
      }
    }

    const changes: {
      branchId?: string | null;
      isDefault?: boolean;
      isActive?: boolean;
    } = {};

    if (branchId !== undefined && branchId !== terminal.branchId) {
      changes.branchId = branchId;
    }

    if (
      dto.isDefault !== undefined &&
      dto.isDefault !== terminal.isDefault
    ) {
      changes.isDefault = dto.isDefault;
    }

    if (dto.isActive !== undefined && dto.isActive !== terminal.isActive) {
      changes.isActive = dto.isActive;
    }

    if (Object.keys(changes).length === 0) {
      return toView(terminal);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (changes.isDefault === true) {
        await tx.mercadoPagoTerminal.updateMany({
          where: { organizationId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.mercadoPagoTerminal.update({
        where: { id },
        data: changes,
      });
    });

    return toView(updated);
  }

  /** Cambia el modo de la terminal en Mercado Pago y en la copia local. */
  async setTerminalMode(
    organizationId: string,
    id: string,
    operatingMode: 'PDV' | 'SELF_SERVICE',
  ): Promise<MercadoPagoTerminalView> {
    const terminal = await this.prisma.mercadoPagoTerminal.findFirst({
      where: { id, organizationId },
    });

    if (!terminal) {
      throw new NotFoundException('Terminal no encontrada');
    }

    const accessToken = await this.tokens.getAccessToken(organizationId);

    await this.client.setTerminalMode(
      accessToken,
      terminal.terminalId,
      operatingMode,
    );

    const updated = await this.prisma.mercadoPagoTerminal.update({
      where: { id },
      data: {
        operatingMode,
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    await this.ensureDefaultTerminal(organizationId);

    return toView(updated);
  }

  /**
   * Deja una terminal predeterminada activa. Prefiere las que están en PDV.
   */
  private async ensureDefaultTerminal(
    organizationId: string,
  ): Promise<void> {
    const current = await this.prisma.mercadoPagoTerminal.findFirst({
      where: { organizationId, isDefault: true, isActive: true },
      select: { id: true },
    });

    if (current) return;

    const candidate = await this.prisma.mercadoPagoTerminal.findFirst({
      where: { organizationId, isActive: true },
      orderBy: [{ operatingMode: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, operatingMode: true },
    });

    if (!candidate) return;

    const preferred =
      candidate.operatingMode === 'PDV'
        ? candidate
        : ((await this.prisma.mercadoPagoTerminal.findFirst({
            where: {
              organizationId,
              isActive: true,
              operatingMode: 'PDV',
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })) ?? candidate);

    await this.prisma.$transaction([
      this.prisma.mercadoPagoTerminal.updateMany({
        where: { organizationId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.mercadoPagoTerminal.update({
        where: { id: preferred.id },
        data: { isDefault: true },
      }),
    ]);
  }
}

function toView(terminal: {
  id: string;
  terminalId: string;
  name: string | null;
  branchId: string | null;
  operatingMode: string | null;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt: Date | null;
}): MercadoPagoTerminalView {
  return {
    id: terminal.id,
    terminalId: terminal.terminalId,
    name: terminal.name,
    branchId: terminal.branchId,
    operatingMode: terminal.operatingMode,
    isDefault: terminal.isDefault,
    isActive: terminal.isActive,
    lastSyncedAt: terminal.lastSyncedAt,
  };
}
