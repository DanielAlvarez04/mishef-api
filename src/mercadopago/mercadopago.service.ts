import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role, type MercadoPagoConnection } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { UpdateMercadoPagoTerminalDto } from './dto/update-terminal.dto';
import { MercadoPagoApiError } from './mercadopago.types';

/** Frecuencia mínima de la sincronización automática de terminales. */
const TERMINALS_SYNC_TTL_MS = 60_000;

export interface MercadoPagoConnectionView {
  mpUserId: string;
  mpEmail: string | null;
  mpNickname: string | null;
  status: string;
  expiresAt: Date;
  connectedAt: Date;
  lastRefreshedAt: Date | null;
  terminalsSyncedAt: Date | null;
  needsReconnect: boolean;
}

export interface MercadoPagoTerminalView {
  id: string;
  terminalId: string;
  name: string | null;
  branchId: string | null;
  operatingMode: string | null;
  model: string | null;
  storeId: string | null;
  posId: string | null;
  externalPosId: string | null;
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
  | {
      ok: true;
      /** Se reconectó la misma cuenta que se había desconectado. */
      sameAccount: boolean;
    }
  | { ok: false; reason: string };

/**
 * Orquesta la conexión OAuth por organización y la sincronización de
 * terminales Point. Los cobros viven en `MercadoPagoPointService`.
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  /** Sincronizaciones en vuelo para no duplicar llamadas desde POS y Ajustes. */
  private readonly terminalSyncs = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
  ) {}

  get configured(): boolean {
    return this.client.isConfigured;
  }

  get usesPkce(): boolean {
    return this.client.usesPkce;
  }

  async getStatus(organizationId: string): Promise<MercadoPagoStatus> {
    // Abrir Configuración también actualiza terminales recién vinculadas.
    await this.syncTerminalsIfStale(organizationId);

    const [connection, terminals] = await Promise.all([
      this.prisma.mercadoPagoConnection.findUnique({
        where: { organizationId },
      }),
      this.prisma.mercadoPagoTerminal.findMany({
        where: { organizationId },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
    ]);

    // Conexiones anteriores a `mpEmail`/`mpNickname`: se completan una vez con
    // la cuenta actual para no obligar a reconectar.
    if (connection) {
      await this.ensureAccountIdentity(organizationId, connection);
    }

    return {
      configured: this.client.isConfigured,
      connected: Boolean(connection),
      connection: connection
        ? {
            mpUserId: connection.mpUserId,
            mpEmail: connection.mpEmail,
            mpNickname: connection.mpNickname,
            status: connection.status,
            expiresAt: connection.expiresAt,
            connectedAt: connection.connectedAt,
            lastRefreshedAt: connection.lastRefreshedAt,
            terminalsSyncedAt: connection.terminalsSyncedAt,
            needsReconnect:
              connection.status !== 'ACTIVE' ||
              connection.expiresAt.getTime() <= Date.now(),
          }
        : null,
      terminals: terminals.map(toView),
    };
  }

  /**
   * Completa el correo/apodo de una conexión antigua.
   *
   * Se ejecuta solo cuando faltan ambos datos y la conexión está activa. Si
   * Mercado Pago falla, el error no rompe Configuración: se reintenta en la
   * siguiente carga.
   */
  private async ensureAccountIdentity(
    organizationId: string,
    connection: MercadoPagoConnection,
  ): Promise<void> {
    if (
      connection.mpEmail ||
      connection.mpNickname ||
      connection.status !== 'ACTIVE'
    ) {
      return;
    }

    try {
      const accessToken = await this.tokens.getAccessToken(organizationId);
      const account = await this.client.getUser(accessToken);
      const mpEmail = account.email?.trim() || null;
      const mpNickname = account.nickname?.trim() || null;

      if (!mpEmail && !mpNickname) return;

      await this.prisma.mercadoPagoConnection.update({
        where: { organizationId },
        data: { mpEmail, mpNickname },
      });

      connection.mpEmail = mpEmail;
      connection.mpNickname = mpNickname;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la identidad de Mercado Pago (org=${organizationId}): ${
          (error as Error).message
        }`,
      );
    }
  }

  authorizationUrl(state: string, codeChallenge?: string): string {
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
    codeVerifier?: string;
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
      const code =
        error instanceof MercadoPagoApiError ? error.code : undefined;

      this.logger.warn(
        `Mercado Pago rechazó el código OAuth (org=${params.organizationId}, status=${
          error instanceof MercadoPagoApiError ? error.status : 'red'
        }, code=${code ?? 'n/a'}): ${(error as Error).message}`,
      );

      return {
        ok: false,
        reason: code ? `exchange_${code}` : 'exchange',
      };
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      return { ok: false, reason: 'exchange' };
    }

    let mpUserId: string;
    let mpEmail: string | null = null;
    let mpNickname: string | null = null;

    try {
      const account = await this.client.getUser(tokens.access_token);
      mpUserId = String(account.id);
      mpEmail = account.email?.trim() || null;
      mpNickname = account.nickname?.trim() || null;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la cuenta de Mercado Pago (org=${
          params.organizationId
        }): ${(error as Error).message}`,
      );
      return { ok: false, reason: 'account' };
    }

    const previous = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: params.organizationId,
        action: 'mercadopago.disconnect',
      },
      orderBy: { createdAt: 'desc' },
      select: { newValues: true },
    });
    const previousMpUserId =
      previous?.newValues &&
      typeof previous.newValues === 'object' &&
      !Array.isArray(previous.newValues)
        ? (previous.newValues as { mpUserId?: unknown }).mpUserId
        : null;
    const sameAccount = previousMpUserId === mpUserId;

    await this.tokens.save(
      params.organizationId,
      params.userId,
      tokens,
      { email: mpEmail, nickname: mpNickname },
    );

    this.logger.log(
      `Mercado Pago conectado (org=${params.organizationId}, mpUserId=${mpUserId}, sameAccount=${sameAccount})`,
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

    return { ok: true, sameAccount };
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

    return terminals.map(toView);
  }

  /**
   * Sincroniza terminales como máximo una vez por minuto.
   *
   * La usa el POS y Configuración para descubrir terminales vinculadas después
   * del OAuth sin obligar al usuario a pulsar “Actualizar terminales”. Es
   * best-effort: si Mercado Pago falla, se conserva la copia local.
   */
  async syncTerminalsIfStale(organizationId: string): Promise<void> {
    const connection = await this.prisma.mercadoPagoConnection.findUnique({
      where: { organizationId },
      select: {
        status: true,
        expiresAt: true,
        terminalsSyncedAt: true,
      },
    });

    if (
      !connection ||
      connection.status !== 'ACTIVE' ||
      connection.expiresAt.getTime() <= Date.now()
    ) {
      return;
    }

    const last = connection.terminalsSyncedAt?.getTime() ?? 0;

    if (Date.now() - last < TERMINALS_SYNC_TTL_MS) return;

    const inFlight = this.terminalSyncs.get(organizationId);
    if (inFlight) return inFlight;

    const sync = this.syncTerminals(organizationId, { fast: true })
      .catch((error) => {
        this.logger.warn(
          `No se pudieron sincronizar terminales (org=${organizationId}): ${
            (error as Error).message
          }`,
        );
      })
      .finally(() => {
        this.terminalSyncs.delete(organizationId);
      });

    this.terminalSyncs.set(organizationId, sync);
    return sync;
  }

  async syncTerminals(
    organizationId: string,
    options: { fast?: boolean } = {},
  ): Promise<void> {
    // Marca el intento antes de llamar a Mercado Pago: si la API está caída,
    // no reintentamos en cada carga de página.
    await this.prisma.mercadoPagoConnection
      .update({
        where: { organizationId },
        data: { terminalsSyncedAt: new Date() },
      })
      .catch(() => undefined);

    const accessToken = await this.tokens.getAccessToken(organizationId);
    const remote = await this.client.listTerminals(accessToken, options);
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
          storeId:
            terminal.store_id === undefined || terminal.store_id === null
              ? null
              : String(terminal.store_id),
          posId:
            terminal.pos_id === undefined || terminal.pos_id === null
              ? null
              : String(terminal.pos_id),
          externalPosId: terminal.external_pos_id ?? null,
          lastSyncedAt: now,
        },
        update: {
          name: terminal.name ?? null,
          operatingMode: terminal.operating_mode ?? null,
          storeId:
            terminal.store_id === undefined || terminal.store_id === null
              ? null
              : String(terminal.store_id),
          posId:
            terminal.pos_id === undefined || terminal.pos_id === null
              ? null
              : String(terminal.pos_id),
          externalPosId: terminal.external_pos_id ?? null,
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
      model?: string | null;
      isDefault?: boolean;
      isActive?: boolean;
    } = {};

    if (branchId !== undefined && branchId !== terminal.branchId) {
      changes.branchId = branchId;
    }

    if (dto.model !== undefined && dto.model !== terminal.model) {
      changes.model = dto.model;
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

    try {
      await this.client.setTerminalMode(
        accessToken,
        terminal.terminalId,
        operatingMode,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo cambiar el modo de la terminal ${terminal.terminalId} (org=${organizationId}): ${
          (error as Error).message
        }`,
      );

      throw new BadGatewayException(
        `Mercado Pago no aceptó el cambio de modo: ${(error as Error).message}`,
      );
    }

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
  model: string | null;
  storeId: string | null;
  posId: string | null;
  externalPosId: string | null;
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
    model: terminal.model,
    storeId: terminal.storeId,
    posId: terminal.posId,
    externalPosId: terminal.externalPosId,
    isDefault: terminal.isDefault,
    isActive: terminal.isActive,
    lastSyncedAt: terminal.lastSyncedAt,
  };
}
