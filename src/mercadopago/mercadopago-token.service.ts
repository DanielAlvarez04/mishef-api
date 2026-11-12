import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { MercadoPagoClient } from './mercadopago.client';
import {
  MercadoPagoApiError,
  MpTokenResponse,
} from './mercadopago.types';
import { TokenCipher } from './token-cipher';

const REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 180 * 24 * 60 * 60;

/**
 * Persistencia y ciclo de vida de los tokens OAuth de Mercado Pago.
 *
 * El access token se refresca automáticamente cuando le quedan menos de 7 días.
 * El `refresh_token` rota en cada refresco, así que las peticiones concurrentes
 * de una misma organización se serializan con una promesa en memoria.
 */
@Injectable()
export class MercadoPagoTokenService {
  private readonly logger = new Logger(MercadoPagoTokenService.name);
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly client: MercadoPagoClient,
  ) {}

  async save(
    organizationId: string,
    connectedById: string | null,
    tokens: MpTokenResponse,
  ): Promise<void> {
    const expiresIn =
      Number(tokens.expires_in) > 0
        ? Number(tokens.expires_in)
        : DEFAULT_EXPIRES_IN_SECONDS;

    const data = {
      mpUserId: String(tokens.user_id),
      accessTokenEnc: this.cipher.encrypt(tokens.access_token),
      refreshTokenEnc: this.cipher.encrypt(tokens.refresh_token),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : [],
      status: 'ACTIVE',
    };

    await this.prisma.mercadoPagoConnection.upsert({
      where: { organizationId },
      create: {
        organizationId,
        connectedById,
        ...data,
      },
      update: {
        ...data,
        connectedById: connectedById ?? undefined,
        lastRefreshedAt: new Date(),
      },
    });
  }

  /** Access token válido (refrescándolo si está por vencer). */
  async getAccessToken(organizationId: string): Promise<string> {
    const connection = await this.prisma.mercadoPagoConnection.findUnique({
      where: { organizationId },
    });

    if (!connection) {
      throw new NotFoundException(
        'Mercado Pago no está conectado a este negocio',
      );
    }

    if (connection.status !== 'ACTIVE') {
      throw new BadRequestException(
        'La conexión con Mercado Pago necesita reconectarse',
      );
    }

    if (
      connection.expiresAt.getTime() - Date.now() >
      REFRESH_MARGIN_MS
    ) {
      return this.cipher.decrypt(connection.accessTokenEnc);
    }

    return this.refresh(organizationId);
  }

  /** Refresca el token; las llamadas concurrentes comparten la promesa. */
  async refresh(organizationId: string): Promise<string> {
    const inflight = this.refreshes.get(organizationId);
    if (inflight) return inflight;

    const promise = this.performRefresh(organizationId).finally(() => {
      this.refreshes.delete(organizationId);
    });

    this.refreshes.set(organizationId, promise);

    return promise;
  }

  async disconnect(organizationId: string): Promise<void> {
    const connection = await this.prisma.mercadoPagoConnection.findUnique({
      where: { organizationId },
    });

    if (!connection) {
      throw new NotFoundException(
        'Mercado Pago no está conectado a este negocio',
      );
    }

    try {
      const accessToken = this.cipher.decrypt(connection.accessTokenEnc);
      await this.client.revoke(accessToken);
    } catch (error) {
      this.logger.warn(
        `No se pudo revocar el token al desconectar: ${
          (error as Error).message
        }`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.mercadoPagoTerminal.deleteMany({
        where: { organizationId },
      }),
      this.prisma.mercadoPagoConnection.delete({
        where: { organizationId },
      }),
    ]);
  }

  private async performRefresh(organizationId: string): Promise<string> {
    const connection = await this.prisma.mercadoPagoConnection.findUnique({
      where: { organizationId },
    });

    if (!connection) {
      throw new NotFoundException(
        'Mercado Pago no está conectado a este negocio',
      );
    }

    try {
      const tokens = await this.client.refresh(
        this.cipher.decrypt(connection.refreshTokenEnc),
      );

      if (!tokens.access_token || !tokens.refresh_token) {
        throw new BadRequestException(
          'Mercado Pago devolvió una respuesta sin tokens',
        );
      }

      await this.save(organizationId, connection.connectedById, tokens);

      return tokens.access_token;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;

      if (
        error instanceof MercadoPagoApiError &&
        (error.status === 400 || error.status === 401)
      ) {
        await this.prisma.mercadoPagoConnection.update({
          where: { organizationId },
          data: { status: 'ERROR' },
        });

        throw new BadRequestException(
          'La conexión con Mercado Pago expiró. Vuelve a conectar tu cuenta.',
        );
      }

      throw error;
    }
  }
}
