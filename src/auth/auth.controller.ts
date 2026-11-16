import {
  Controller,
  Post,
  Patch,
  Body,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService, SessionMeta } from './auth.service';
import { GoogleOauthService } from './google-oauth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  DisableTwoFactorDto,
  TwoFactorChallengeDto,
} from './dto/two-factor.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { permissionsForRoles } from '../common/permissions';
import { TurnstileService } from '../common/turnstile.service';

const ACCESS_TOKEN_COOKIE = 'np_at';
const REFRESH_TOKEN_COOKIE = 'np_rt';
const OAUTH_STATE_COOKIE = 'np_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'np_oauth_verifier';
const OAUTH_LINK_COOKIE = 'np_oauth_link';
const OAUTH_BUSINESS_COOKIE = 'np_oauth_business';
const OAUTH_COOKIE_PATH = '/v1/auth/google';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private google: GoogleOauthService,
    private config: ConfigService,
    private turnstile: TurnstileService,
  ) {}

  @ApiOperation({ summary: 'Iniciar sesión' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, this.metaFrom(req));

    if ('twoFactorRequired' in result) {
      return result;
    }

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return { user: result.user };
  }

  @ApiOperation({ summary: 'Iniciar sesión o registro con Google' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('google')
  startGoogleLogin(
    @Res() res: Response,
    @Query('business') business?: string,
  ) {
    if (!this.google.isConfigured) {
      throw new ServiceUnavailableException(
        'El inicio de sesión con Google no está configurado',
      );
    }

    const { state, verifier, challenge } = this.google.createChallenge();

    this.setOAuthCookies(res, state, verifier);

    const businessName = business?.trim();

    if (businessName) {
      res.cookie(
        OAUTH_BUSINESS_COOKIE,
        businessName.slice(0, 80),
        this.oauthCookieOptions(),
      );
    }

    return res.redirect(this.google.authorizationUrl(state, challenge));
  }

  @ApiOperation({
    summary: 'Vincular una cuenta de Google a la cuenta autenticada',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Get('google/link')
  startGoogleLink(@Res() res: Response) {
    if (!this.google.isConfigured) {
      throw new ServiceUnavailableException(
        'El inicio de sesión con Google no está configurado',
      );
    }

    const { state, verifier, challenge } = this.google.createChallenge();

    this.setOAuthCookies(res, state, verifier);
    res.cookie(OAUTH_LINK_COOKIE, '1', this.oauthCookieOptions());

    return res.redirect(this.google.authorizationUrl(state, challenge));
  }

  @ApiOperation({ summary: 'Callback de Google (redirect del navegador)' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');

    const isLinkFlow = req.cookies?.[OAUTH_LINK_COOKIE] === '1';

    this.clearOAuthCookies(res);

    const fail = (reason: string) =>
      res.redirect(
        isLinkFlow
          ? `${webOrigin}/settings?google=${encodeURIComponent(reason)}`
          : `${webOrigin}/login?error=${encodeURIComponent(reason)}`,
      );

    if (error) {
      return fail('google_cancelled');
    }

    const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
    const verifier = req.cookies?.[OAUTH_VERIFIER_COOKIE];

    if (
      !code ||
      !state ||
      !expectedState ||
      !verifier ||
      state !== expectedState
    ) {
      return fail('google_state');
    }

    let profile;
    try {
      profile = await this.google.fetchProfile(code, verifier);
    } catch {
      return fail('google_failed');
    }

    if (isLinkFlow) {
      const userId = await this.auth.userIdFromAccessToken(
        req.cookies?.[ACCESS_TOKEN_COOKIE],
      );

      if (!userId) {
        return fail('google_link_session');
      }

      const link = await this.auth.linkGoogleAccount(userId, profile);

      return res.redirect(
        `${webOrigin}/settings?google=${
          link.ok ? 'linked' : `error_${link.reason}`
        }`,
      );
    }

    const result = await this.auth.loginWithGoogle(
      profile,
      this.metaFrom(req),
      { businessName: req.cookies?.[OAUTH_BUSINESS_COOKIE] },
    );

    if (result.kind === 'error') {
      return fail(`google_${result.reason}`);
    }

    if (result.kind === 'twofactor') {
      const params = new URLSearchParams({
        twoFactor: '1',
        challengeId: result.challengeId,
        email: result.email,
      });

      return res.redirect(`${webOrigin}/login?${params.toString()}`);
    }

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return res.redirect(
      `${webOrigin}${result.created ? '/onboarding' : '/dashboard'}`,
    );
  }

  @ApiOperation({ summary: 'Verificar el código de segundo factor' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/verify')
  async verifyTwoFactor(
    @Body() dto: TwoFactorChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyTwoFactor(
      dto.challengeId,
      dto.code,
      this.metaFrom(req),
    );

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return { user: result.user };
  }

  @ApiOperation({ summary: 'Crear cuenta y negocio (registro público)' })
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const passed = await this.turnstile.verify(dto.turnstileToken, req.ip);

    if (!passed) {
      throw new BadRequestException(
        'Completa la verificación anti-bots e inténtalo de nuevo',
      );
    }

    const result = await this.auth.register(dto, this.metaFrom(req));

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return { user: result.user };
  }

  @ApiOperation({ summary: 'Renovar token de acceso' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.refresh(
      req.cookies?.[REFRESH_TOKEN_COOKIE],
      this.metaFrom(req),
    );

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    return { ok: true };
  }

  @ApiOperation({ summary: 'Cerrar sesión' })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.cookies?.[REFRESH_TOKEN_COOKIE]);

    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });

    return { ok: true };
  }

  @ApiOperation({ summary: 'Obtener usuario autenticado' })
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user.sub);
  }

  @ApiOperation({ summary: 'Actualizar nombre y usuario de la cuenta' })
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  updateProfile(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(user.sub, dto);
  }

  @ApiOperation({ summary: 'Completar el onboarding inicial' })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('onboarding/complete')
  completeOnboarding(@CurrentUser() user: JwtUser) {
    return this.auth.completeOnboarding(user.sub);
  }

  @ApiOperation({ summary: 'Permisos del usuario autenticado' })
  @UseGuards(JwtAuthGuard)
  @Get('permissions')
  permissions(@CurrentUser() user: JwtUser) {
    return { roles: user.roles, permissions: permissionsForRoles(user.roles) };
  }

  @ApiOperation({ summary: 'Verificar el correo electrónico' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @ApiOperation({ summary: 'Reenviar la verificación de correo' })
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  resendVerification(@CurrentUser() user: JwtUser) {
    return this.auth.resendVerification(user.sub);
  }

  @ApiOperation({ summary: 'Solicitar recuperación de contraseña' })
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @ApiOperation({ summary: 'Restablecer contraseña con código' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.resetPassword(dto.token, dto.password);

    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });

    return result;
  }

  @ApiOperation({ summary: 'Cambiar la contraseña del usuario autenticado' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: JwtUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.changePassword(
      user.sub,
      dto.currentPassword,
      dto.newPassword,
    );

    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });

    return result;
  }

  @ApiOperation({ summary: 'Iniciar la activación de 2FA' })
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('2fa/enable')
  startTwoFactor(@CurrentUser() user: JwtUser) {
    return this.auth.startTwoFactorEnable(user.sub);
  }

  @ApiOperation({ summary: 'Confirmar la activación de 2FA' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('2fa/enable/confirm')
  confirmTwoFactor(
    @CurrentUser() user: JwtUser,
    @Body() dto: TwoFactorChallengeDto,
  ) {
    return this.auth.confirmTwoFactorEnable(
      user.sub,
      dto.challengeId,
      dto.code,
    );
  }

  @ApiOperation({ summary: 'Desactivar 2FA' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('2fa/disable')
  disableTwoFactor(
    @CurrentUser() user: JwtUser,
    @Body() dto: DisableTwoFactorDto,
  ) {
    return this.auth.disableTwoFactor(user.sub, dto.password);
  }

  private metaFrom(req: Request): SessionMeta {
    return {
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    };
  }

  private oauthCookieOptions() {
    const secure = this.config.get('NODE_ENV') === 'production';

    return {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: OAUTH_COOKIE_PATH,
      maxAge: 10 * 60 * 1000,
    };
  }

  private setOAuthCookies(res: Response, state: string, verifier: string) {
    const options = this.oauthCookieOptions();

    res.cookie(OAUTH_STATE_COOKIE, state, options);
    res.cookie(OAUTH_VERIFIER_COOKIE, verifier, options);
  }

  private clearOAuthCookies(res: Response) {
    res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_COOKIE_PATH });
    res.clearCookie(OAUTH_VERIFIER_COOKIE, { path: OAUTH_COOKIE_PATH });
    res.clearCookie(OAUTH_LINK_COOKIE, { path: OAUTH_COOKIE_PATH });
    res.clearCookie(OAUTH_BUSINESS_COOKIE, { path: OAUTH_COOKIE_PATH });
  }

  private setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ) {
    const secure = this.config.get('NODE_ENV') === 'production';
    // En producción el frontend y la API pueden vivir en subdominios distintos
    // (app.ejemplo.com y api.ejemplo.com): `COOKIE_DOMAIN=.ejemplo.com` hace que
    // el navegador envíe la sesión a ambos. En local se deja host-only.
    const domain = this.config.get<string>('COOKIE_DOMAIN')?.trim() || undefined;
    const common = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
      ...(domain ? { domain } : {}),
    };

    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...common,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...common,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}
