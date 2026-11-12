import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  ClaimPosPairingDto,
  CreatePosDisplayDto,
  CreatePosPairingDto,
  PosDisplayTipDto,
  PosPinLoginDto,
  SetPosPinDto,
  UpdatePosDisplayStateDto,
} from './dto/pos.dto';
import { PosService } from './pos.service';

const ACCESS_TOKEN_COOKIE = 'np_at';
const REFRESH_TOKEN_COOKIE = 'np_rt';
const DEVICE_COOKIE = 'np_pos_device';
const BRANCH_COOKIE = 'np_branch';
const DEVICE_COOKIE_MAX_AGE = 180 * 24 * 60 * 60 * 1000;

@ApiTags('pos')
@Controller('pos')
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly config: ConfigService,
  ) {}

  @ApiOperation({ summary: 'Generar el QR para vincular una caja' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Post('pairing')
  createPairing(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreatePosPairingDto,
  ) {
    return this.pos.createPairing(
      user.organizationId,
      dto.branchId ?? null,
      user.sub,
    );
  }

  @ApiOperation({ summary: 'Información pública del código de vinculación' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('pairing/:code')
  pairingInfo(@Param('code') code: string) {
    return this.pos.pairingInfo(code);
  }

  @ApiOperation({ summary: 'Vincular esta caja con el código del QR' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('pairing/:code/claim')
  async claim(
    @Param('code') code: string,
    @Body() dto: ClaimPosPairingDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pos.claimPairing(code, dto.name);
    this.setDeviceCookie(res, result.token);

    return {
      deviceId: result.deviceId,
      organizationName: result.organizationName,
      branchName: result.branchName,
    };
  }

  @ApiOperation({ summary: 'Caja vinculada y miembros disponibles' })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('device')
  async device(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.pos.deviceSession(
      req.cookies?.[DEVICE_COOKIE],
    );

    if (session.branchId) {
      this.setBranchCookie(res, session.branchId);
    }

    return session;
  }

  @ApiOperation({ summary: 'Entrar a la caja con PIN' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('device/pin')
  async pin(
    @Req() req: Request,
    @Body() dto: PosPinLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pos.pinLogin(
      req.cookies?.[DEVICE_COOKIE],
      dto.userId,
      dto.pin,
      { ip: req.ip, userAgent: req.get('user-agent') },
    );

    this.setSessionCookies(res, result.accessToken, result.refreshToken);

    if (result.branchId) {
      this.setBranchCookie(res, result.branchId);
    }

    return { ok: true, user: result.user };
  }

  @ApiOperation({ summary: 'Definir mi PIN de caja' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Put('pin')
  setOwnPin(@CurrentUser() user: JwtUser, @Body() dto: SetPosPinDto) {
    return this.pos.setPin(user.organizationId, user.sub, dto.pin);
  }

  @ApiOperation({ summary: 'Definir el PIN de un miembro (ADMIN)' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Put('pin/:userId')
  setUserPin(
    @CurrentUser() user: JwtUser,
    @Param('userId') userId: string,
    @Body() dto: SetPosPinDto,
  ) {
    return this.pos.setPin(user.organizationId, userId, dto.pin);
  }

  @ApiOperation({ summary: 'Cajas vinculadas' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Get('devices')
  devices(@CurrentUser() user: JwtUser) {
    return this.pos.listDevices(user.organizationId);
  }

  @ApiOperation({ summary: 'Revocar una caja vinculada' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Delete('devices/:id')
  revoke(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.pos.revokeDevice(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear una pantalla de cliente' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Post('displays')
  createDisplay(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreatePosDisplayDto,
  ) {
    return this.pos.createDisplay(
      user.organizationId,
      dto.branchId ?? branchId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Pantallas de cliente del negocio' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('cash:read')
  @Get('displays')
  displays(@CurrentUser() user: JwtUser) {
    return this.pos.listDisplays(user.organizationId);
  }

  @ApiOperation({ summary: 'Estado actual de una pantalla de cliente' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('cash:read')
  @Get('displays/:id/state')
  displayState(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.pos.displayState(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Publicar el carrito en la pantalla de cliente' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('cash:read')
  @Put('displays/:id/state')
  pushDisplayState(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdatePosDisplayStateDto,
  ) {
    return this.pos.pushDisplayState(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Revocar una pantalla de cliente' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequirePermissions('organization:manage')
  @Delete('displays/:id')
  revokeDisplay(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.pos.revokeDisplay(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Datos públicos de la pantalla de cliente' })
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('display/:token')
  displayInfo(@Param('token') token: string) {
    return this.pos.displayInfo(token);
  }

  @ApiOperation({ summary: 'El cliente elige la propina en la pantalla' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('display/:token/tip')
  displayTip(
    @Param('token') token: string,
    @Body() dto: PosDisplayTipDto,
  ) {
    return this.pos.setDisplayTip(token, dto.tipPercent);
  }

  @ApiOperation({ summary: 'El cliente confirma el pedido en la pantalla' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('display/:token/confirm')
  displayConfirm(@Param('token') token: string) {
    return this.pos.confirmDisplayOrder(token);
  }

  private commonCookieOptions() {
    const secure = this.config.get('NODE_ENV') === 'production';
    const domain =
      this.config.get<string>('COOKIE_DOMAIN')?.trim() || undefined;

    return {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
      ...(domain ? { domain } : {}),
    };
  }

  private setSessionCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ) {
    const common = this.commonCookieOptions();

    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...common,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...common,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private setDeviceCookie(res: Response, token: string) {
    res.cookie(DEVICE_COOKIE, token, {
      ...this.commonCookieOptions(),
      maxAge: DEVICE_COOKIE_MAX_AGE,
    });
  }

  private setBranchCookie(res: Response, branchId: string) {
    res.cookie(BRANCH_COOKIE, branchId, {
      ...this.commonCookieOptions(),
      httpOnly: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}
