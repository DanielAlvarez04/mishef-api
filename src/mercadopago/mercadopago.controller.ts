import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { MercadoPagoService } from './mercadopago.service';
import { SetTerminalModeDto } from './dto/set-terminal-mode.dto';
import { UpdateMercadoPagoTerminalDto } from './dto/update-terminal.dto';

const OAUTH_COOKIE = 'np_mp_oauth';
const OAUTH_COOKIE_PATH = '/v1/mercadopago';
const OAUTH_COOKIE_MAX_AGE = 10 * 60 * 1000;

interface OAuthCookie {
  state: string;
  verifier: string;
  organizationId: string;
  userId: string;
}

function encodeCookie(payload: OAuthCookie): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCookie(value: string | undefined): OAuthCookie | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<OAuthCookie>;

    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.verifier !== 'string' ||
      typeof parsed.organizationId !== 'string' ||
      typeof parsed.userId !== 'string'
    ) {
      return null;
    }

    return parsed as OAuthCookie;
  } catch {
    return null;
  }
}

@ApiTags('mercadopago')
@Controller('mercadopago')
export class MercadoPagoController {
  private readonly logger = new Logger(MercadoPagoController.name);

  constructor(
    private readonly mercadoPago: MercadoPagoService,
    private readonly config: ConfigService,
  ) {}

  @ApiOperation({ summary: 'Iniciar la conexión OAuth con Mercado Pago' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Get('connect')
  connect(@CurrentUser() user: JwtUser, @Res() res: Response) {
    if (!this.mercadoPago.configured) {
      throw new ServiceUnavailableException(
        'La integración con Mercado Pago no está configurada',
      );
    }

    const organizationId = this.organizationId(user);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64url');

    res.cookie(
      OAUTH_COOKIE,
      encodeCookie({
        state,
        verifier,
        organizationId,
        userId: user.sub,
      }),
      this.cookieOptions(),
    );

    return res.redirect(
      this.mercadoPago.authorizationUrl(state, challenge),
    );
  }

  @ApiOperation({ summary: 'Callback OAuth de Mercado Pago' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');

    const cookie = decodeCookie(req.cookies?.[OAUTH_COOKIE]);
    res.clearCookie(OAUTH_COOKIE, {
      path: OAUTH_COOKIE_PATH,
      sameSite: 'lax',
      secure: this.isProduction(),
    });

    const fail = (reason: string) =>
      res.redirect(
        `${webOrigin}/settings?mp=${encodeURIComponent(reason)}`,
      );

    if (error) return fail('cancelled');
    if (!code || !state || !cookie || state !== cookie.state) {
      return fail('state');
    }

    try {
      const result = await this.mercadoPago.handleCallback({
        organizationId: cookie.organizationId,
        userId: cookie.userId,
        code,
        codeVerifier: cookie.verifier,
      });

      return result.ok
        ? res.redirect(`${webOrigin}/settings?mp=connected`)
        : res.redirect(
            `${webOrigin}/settings?mp=error_${encodeURIComponent(result.reason)}`,
          );
    } catch (cause) {
      this.logger.error(
        `Error conectando Mercado Pago: ${(cause as Error).message}`,
      );
      return fail('unexpected');
    }
  }

  @ApiOperation({ summary: 'Estado de la conexión y terminales' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Get('status')
  status(@CurrentUser() user: JwtUser) {
    return this.mercadoPago.getStatus(this.organizationId(user));
  }

  @ApiOperation({ summary: 'Desconectar la cuenta de Mercado Pago' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Delete('connection')
  async disconnect(@CurrentUser() user: JwtUser) {
    await this.mercadoPago.disconnect(this.organizationId(user));
    return { ok: true };
  }

  @ApiOperation({ summary: 'Listar terminales (sincroniza con Mercado Pago)' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Get('terminals')
  terminals(@CurrentUser() user: JwtUser) {
    return this.mercadoPago.listTerminals(this.organizationId(user));
  }

  @ApiOperation({ summary: 'Forzar sincronización de terminales' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Post('terminals/sync')
  syncTerminals(@CurrentUser() user: JwtUser) {
    return this.mercadoPago.listTerminals(this.organizationId(user));
  }

  @ApiOperation({ summary: 'Actualizar sucursal o predeterminada' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Patch('terminals/:id')
  updateTerminal(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateMercadoPagoTerminalDto,
  ) {
    return this.mercadoPago.updateTerminal(
      this.organizationId(user),
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Cambiar el modo de operación (PDV/SELF_SERVICE)' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Patch('terminals/:id/mode')
  setTerminalMode(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: SetTerminalModeDto,
  ) {
    return this.mercadoPago.setTerminalMode(
      this.organizationId(user),
      id,
      dto.operatingMode,
    );
  }

  private organizationId(user: JwtUser): string {
    if (!user.organizationId) {
      throw new BadRequestException(
        'La sesión no tiene un negocio activo',
      );
    }

    return user.organizationId;
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction(),
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_COOKIE_MAX_AGE,
    };
  }

  private isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }
}
