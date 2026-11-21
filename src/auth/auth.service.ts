import {
  BadRequestException,
  Injectable,
  Optional,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hash, verify } from 'argon2';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, TwoFactorPurpose } from '@prisma/client';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  buildOrganizationSlug,
  isValidSlug,
  normalizeSlug,
} from '../common/slug';
import { PRACTICE_WINDOW_MS } from '../common/practice';
import { isValidUsername, normalizeUsername } from '../common/usernames';
import { permissionsForRoles } from '../common/permissions';
import {
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from './totp';
import { MailService } from '../mail/mail.service';
import type { GoogleProfile } from './google-oauth.service';
import { InventoryService } from '../inventory/inventory.service';
import { BillingService } from '../billing/billing.service';
import {
  loginAlertEmail,
  passwordChangedEmail,
  passwordResetEmail,
  twoFactorEmail,
  verificationEmail,
} from '../mail/mail.templates';

export interface JwtUser {
  sub: string;
  email: string | null;
  roles: Role[];
  organizationId: string | null;
  sid: string;
  /**
   * Sucursal fija de la membresía (empleados asignados a un local). Se resuelve
   * al validar el token para no volver a consultar la membresía en cada
   * petición. `null` = puede operar en cualquier sucursal de la organización.
   */
  branchId?: string | null;
  /** Acceso al panel interno de la plataforma. */
  isPlatformAdmin?: boolean;
  /** Dueño del negocio: único que puede entrar por el dominio principal. */
  isOwner?: boolean;
  /** Slug del negocio de la sesión, para validar el host. */
  organizationSlug?: string | null;
  /** El correo de la cuenta está verificado. */
  emailVerified?: boolean;
  /** Debe cambiar la contraseña inicial antes de operar. */
  mustChangePassword?: boolean;
  /** Usuario de plataforma que abrió esta sesión de soporte. */
  impersonatedById?: string | null;
  /** Nombre visible del actor, para el banner de soporte. */
  impersonatedByName?: string | null;
}

export interface RefreshPayload {
  sub: string;
  sid: string;
  type: 'refresh';
  /** Negocio de la sesión; evita elegir `memberships[0]` al rotar. */
  organizationId?: string | null;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export type GoogleLoginResult =
  | {
      kind: 'session';
      accessToken: string;
      refreshToken: string;
      /** `true` cuando la cuenta y su organización se acaban de crear. */
      created?: boolean;
      user: {
        id: string;
        email: string | null;
        name: string | null;
        roles: Role[];
        organizationId: string | null;
        organizationName: string;
      };
    }
  | {
      kind: 'twofactor';
      challengeId: string;
      email: string;
      method?: 'TOTP' | 'EMAIL';
    }
  | {
      kind: 'error';
      reason:
        | 'no_account'
        | 'inactive'
        | 'no_membership'
        | 'mismatch'
        | 'unverified_email'
        | 'not_linked'
        | 'subdomain_required';
    };

export type GoogleLinkResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'inactive' | 'unverified_email' | 'already_linked' | 'mismatch';
    };

const googleUserInclude = {
  memberships: {
    where: { isActive: true, organization: { isActive: true } },
    include: { organization: true },
    orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.UserInclude;

function sanitizeBusinessName(value?: string): string | null {
  const name = value?.trim();
  return name ? name.slice(0, 80) : null;
}

const ACCESS_TOKEN_TTL = '15m';
/** La impersonación es corta y no se renueva. */
const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutos
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
const TWO_FACTOR_TTL_MS = 10 * 60 * 1000; // 10 minutos
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const TWO_FACTOR_RECOVERY_CODE_COUNT = 8;

/**
 * Una sesión rotada conserva el id de la sesión que la reemplazó.
 *
 * Si una pestaña suspendida vuelve con el refresh viejo, no se revocan las
 * demás sesiones: solo esa petición pierde la carrera. La pestaña puede
 * recuperarse al recargar con las cookies compartidas del navegador.
 */
interface RotatableSession {
  revokedAt: Date | null;
  revokedReason: string | null;
  replacedBySessionId: string | null;
}

function isRotatedSession(session: RotatableSession): boolean {
  return Boolean(
    session.revokedAt &&
      session.revokedReason === 'ROTATED' &&
      session.replacedBySessionId,
  );
}

function rotatedException(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: 'SESSION_ROTATED',
    message:
      'La sesión se renovó en otra pestaña. Vuelve a intentarlo con las cookies actualizadas.',
  });
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Intentos fallidos por negocio+identificador (en memoria, por proceso). */
  private readonly loginAttempts = new Map<
    string,
    { count: number; blockedUntil: number }
  >();

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private readonly mail: MailService,
    private readonly inventory?: InventoryService,
    @Optional() private readonly billing?: BillingService,
  ) {}

  // --------------------------------------------------------------------------
  // Login / sesiones
  // --------------------------------------------------------------------------

  async login(dto: LoginDto, meta: SessionMeta = {}) {
    const identifier = normalizeUsername(dto.identifier);
    const tenant = dto.tenant ? normalizeSlug(dto.tenant) : null;
    const attemptKey = `${tenant ?? "main"}:${identifier}`;
    const attempt = this.loginAttempts.get(attemptKey);

    if (attempt && attempt.blockedUntil > Date.now()) {
      throw new UnauthorizedException(
        'Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.',
      );
    }

    const membership = await this.resolveLoginMembership(identifier, tenant);

    if (!membership?.user.passwordHash) {
      this.registerLoginFailure(attemptKey);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await verify(membership.user.passwordHash, dto.password);
    if (!valid) {
      this.registerLoginFailure(attemptKey);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    this.loginAttempts.delete(attemptKey);

    if (!membership.user.isActive || !membership.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    // En el dominio principal solo entra el dueño del negocio (o el equipo de
    // plataforma). El resto debe usar el subdominio de su negocio.
    if (
      !tenant &&
      !membership.isOwner &&
      !membership.roles.includes(Role.ADMIN) &&
      !membership.user.isPlatformAdmin
    ) {
      throw new UnauthorizedException(
        'Entra por el subdominio de tu negocio para iniciar sesión',
      );
    }

    if (membership.user.twoFactorEnabled) {
      if (
        membership.user.twoFactorTotpEnabled &&
        membership.user.twoFactorTotpSecret
      ) {
        const challenge = await this.createTwoFactorCode(
          membership.user.id,
          TwoFactorPurpose.LOGIN,
          membership.organizationId,
        );

        return {
          twoFactorRequired: true as const,
          challengeId: challenge.id,
          email: membership.user.email,
          method: 'TOTP' as const,
        };
      }

      if (!membership.user.email) {
        throw new UnauthorizedException(
          'La cuenta no tiene un correo para el segundo factor',
        );
      }

      const challenge = await this.createTwoFactorCode(
        membership.user.id,
        TwoFactorPurpose.LOGIN,
        membership.organizationId,
      );

      await this.mail.send({
        to: membership.user.email,
        ...twoFactorEmail(challenge.code, 'LOGIN'),
      });

      return {
        twoFactorRequired: true as const,
        challengeId: challenge.id,
        email: membership.user.email,
        method: 'EMAIL' as const,
      };
    }

    return this.issueSessionForUser(
      membership.user.id,
      meta,
      membership.organizationId,
      { notifyLogin: true },
    );
  }

  private registerLoginFailure(key: string) {
    const now = Date.now();
    const current = this.loginAttempts.get(key);
    const count =
      current && current.blockedUntil > now ? current.count + 1 : 1;

    this.loginAttempts.set(key, {
      count,
      blockedUntil:
        count >= 10 ? now + 15 * 60 * 1000 : (current?.blockedUntil ?? 0),
    });
  }

  /**
   * Busca la membresía con la que se intenta iniciar sesión.
   *
   * - Con subdominio: usuario o correo dentro de esa organización.
   * - Sin subdominio: se prefiere la membresía de dueño; el login decide
   *   después si permite la entrada.
   */
  private async resolveLoginMembership(
    identifier: string,
    tenant: string | null,
  ) {
    const email = identifier.includes('@') ? identifier : null;

    const memberships = await this.prisma.membership.findMany({
      where: {
        isActive: true,
        organization: {
          isActive: true,
          ...(tenant ? { slug: tenant } : {}),
        },
        user: {
          isActive: true,
          ...(email ? { email } : {}),
        },
        ...(email ? {} : { username: identifier }),
      },
      include: { user: true, organization: true },
      orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
      take: 10,
    });

    return (
      memberships.find((item) => item.isOwner) ??
      memberships.find((item) => item.roles.includes(Role.ADMIN)) ??
      memberships[0] ??
      null
    );
  }

  /**
   * Abre una sesión normal para un usuario autenticado por otro medio
   * (PIN de caja en un dispositivo vinculado).
   */
  async issuePosSession(
    userId: string,
    organizationId: string,
    meta: SessionMeta = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { organizationId, isActive: true },
        },
      },
    });

    if (!user || !user.isActive || user.memberships.length === 0) {
      throw new UnauthorizedException('Usuario sin acceso a este negocio');
    }

    const membership = user.memberships[0];
    const tokens = await this.createSession(
      user.id,
      user.email,
      membership.roles,
      organizationId,
      meta,
      membership.isOwner,
    );

    return {
      ...tokens,
      user: {
        id: user.id,
        name: user.name,
        username: membership.username,
        roles: membership.roles,
      },
    };
  }

  async verifyTwoFactor(
    challengeId: string,
    code: string,
    meta: SessionMeta = {},
  ) {
    const record = await this.prisma.twoFactorCode.findUnique({
      where: { id: challengeId },
    });

    if (
      !record ||
      record.purpose !== TwoFactorPurpose.LOGIN ||
      record.consumedAt ||
      record.expiresAt <= new Date() ||
      record.attempts >= TWO_FACTOR_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    // Los códigos de recuperación son alfanuméricos; el de correo es de 6
    // dígitos. Ambos consumen el mismo reto.
    if (!/^\d{6}$/.test(code.trim())) {
      const user = await this.prisma.user.findUnique({
        where: { id: record.userId },
      });

      const normalized = code.trim().toLowerCase();
      let matchedIndex = -1;

      if (user) {
        for (const [index, hashValue] of user.twoFactorRecoveryCodes.entries()) {
          if (await verify(hashValue, normalized)) {
            matchedIndex = index;
            break;
          }
        }
      }

      if (!user || !user.twoFactorEnabled || matchedIndex < 0) {
        await this.registerTwoFactorFailure(record);
        throw new UnauthorizedException('Código inválido o expirado');
      }

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            twoFactorRecoveryCodes: user.twoFactorRecoveryCodes.filter(
              (_value, index) => index !== matchedIndex,
            ),
          },
        }),
        this.prisma.twoFactorCode.update({
          where: { id: record.id },
          data: { consumedAt: new Date() },
        }),
      ]);

      return this.issueSessionForUser(
        user.id,
        meta,
        record.organizationId,
        { notifyLogin: true },
      );
    }

    const normalizedCode = code.trim();
    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });

    if (
      /^\d{6}$/.test(normalizedCode) &&
      user?.twoFactorTotpEnabled &&
      user.twoFactorTotpSecret &&
      verifyTotp(user.twoFactorTotpSecret, normalizedCode)
    ) {
      await this.prisma.twoFactorCode.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });

      return this.issueSessionForUser(
        user.id,
        meta,
        record.organizationId,
        { notifyLogin: true },
      );
    }

    const challenge = await this.consumeTwoFactorCode(
      challengeId,
      normalizedCode,
      TwoFactorPurpose.LOGIN,
    );

    return this.issueSessionForUser(
      challenge.userId,
      meta,
      challenge.organizationId,
      { notifyLogin: true },
    );
  }

  private async registerTwoFactorFailure(record: {
    id: string;
    attempts: number;
  }) {
    const attempts = record.attempts + 1;

    await this.prisma.twoFactorCode.update({
      where: { id: record.id },
      data: {
        attempts,
        consumedAt:
          attempts >= TWO_FACTOR_MAX_ATTEMPTS ? new Date() : undefined,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Login con Google
  // --------------------------------------------------------------------------

  /**
   * Inicia sesión con un perfil de Google ya validado.
   *
   * - Busca primero por `googleId` (vínculo explícito desde Ajustes) y luego
   *   por correo verificado.
   * - Si no existe ninguna cuenta, **crea un negocio nuevo** con el usuario
   *   como ADMIN (registro público con Google).
   * - Respeta la verificación en dos pasos si está activa.
   */
  async loginWithGoogle(
    profile: GoogleProfile,
    meta: SessionMeta = {},
    options: { businessName?: string; tenant?: string } = {},
  ): Promise<GoogleLoginResult> {
    const email = profile.email.trim().toLowerCase();
    const tenant = options.tenant ? normalizeSlug(options.tenant) : null;

    if (!profile.emailVerified) {
      return { kind: 'error', reason: 'unverified_email' };
    }

    let user = await this.prisma.user.findUnique({
      where: { googleId: profile.sub },
      include: googleUserInclude,
    });

    if (!user && !tenant) {
      user = await this.prisma.user.findUnique({
        where: { email },
        include: googleUserInclude,
      });
    }

    if (!user) {
      // En un subdominio solo se permite una cuenta de Google ya vinculada.
      if (tenant) {
        return { kind: 'error', reason: 'not_linked' };
      }

      return this.registerWithGoogle(profile, email, meta, options.businessName);
    }

    if (!user.isActive) {
      return { kind: 'error', reason: 'inactive' };
    }

    if (user.googleId && user.googleId !== profile.sub) {
      return { kind: 'error', reason: 'mismatch' };
    }

    const membership = tenant
      ? user.memberships.find(
          (item) => item.organization?.slug === tenant,
        ) ?? null
      : user.memberships.find((item) => item.isOwner) ??
        user.memberships.find((item) => item.roles.includes(Role.ADMIN)) ??
        user.memberships[0];

    if (!membership) {
      return { kind: 'error', reason: 'no_membership' };
    }

    // En el dominio principal solo entran dueños, ADMIN o plataforma.
    if (
      !tenant &&
      !membership.isOwner &&
      !membership.roles.includes(Role.ADMIN) &&
      !user.isPlatformAdmin
    ) {
      return { kind: 'error', reason: 'subdomain_required' };
    }

    // Vinculación idempotente: si otra petición ya vinculó la cuenta, no duplica.
    if (!user.googleId) {
      await this.prisma.user.updateMany({
        where: { id: user.id, googleId: null },
        data: { googleId: profile.sub },
      });
    }

    // El correo de Google solo verifica la cuenta si es el mismo correo.
    if (
      !user.emailVerified &&
      user.email?.toLowerCase() === email
    ) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    if (user.twoFactorEnabled) {
      if (user.twoFactorTotpEnabled && user.twoFactorTotpSecret) {
        const challenge = await this.createTwoFactorCode(
          user.id,
          TwoFactorPurpose.LOGIN,
          membership.organizationId,
        );

        return {
          kind: 'twofactor',
          challengeId: challenge.id,
          email: user.email ?? '',
          method: 'TOTP',
        };
      }

      if (!user.email) {
        return { kind: 'error', reason: 'unverified_email' };
      }

      const challenge = await this.createTwoFactorCode(
        user.id,
        TwoFactorPurpose.LOGIN,
        membership.organizationId,
      );

      await this.mail.send({
        to: user.email,
        ...twoFactorEmail(challenge.code, 'LOGIN'),
      });

      return {
        kind: 'twofactor',
        challengeId: challenge.id,
        email: user.email,
        method: 'EMAIL',
      };
    }

    const session = await this.issueSessionForUser(
      user.id,
      meta,
      membership.organizationId,
      { notifyLogin: true },
    );

    return { kind: 'session', ...session };
  }

  /**
   * Registro público con Google: crea la cuenta y su negocio (ADMIN).
   *
   * El nombre del negocio puede venir de `/register`; si no, se usa un nombre
   * provisional editable desde Ajustes.
   */
  private async registerWithGoogle(
    profile: GoogleProfile,
    email: string,
    meta: SessionMeta,
    businessName?: string,
  ): Promise<GoogleLoginResult> {
    const displayName = profile.name?.trim() || email.split('@')[0];
    const organizationName =
      sanitizeBusinessName(businessName) ?? `Negocio de ${displayName}`;
    let organizationId: string | null = null;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: organizationName,
            slug: buildOrganizationSlug(organizationName),
            practiceMode: true,
            practiceUntil: new Date(Date.now() + PRACTICE_WINDOW_MS),
          },
        });
        organizationId = organization.id;

        const user = await tx.user.create({
          data: {
            email,
            name: profile.name?.trim() || null,
            googleId: profile.sub,
            emailVerified: true,
          },
        });

        await tx.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            roles: [Role.ADMIN],
            isOwner: true,
          },
        });

        return user;
      });

      const session = await this.issueSessionForUser(
        created.id,
        meta,
        organizationId,
      );
      if (this.inventory) await this.inventory.ensureCoreDefaults();
      if (organizationId) await this.billing?.startTrial(organizationId);

      return { kind: 'session', created: true, ...session };
    } catch (error) {
      // Carrera: otra petición ya creó la cuenta con este correo o `sub`.
      if ((error as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.user.findUnique({
          where: { email },
          include: googleUserInclude,
        });

        if (existing) {
          return this.loginWithGoogle(profile, meta);
        }
      }

      throw error;
    }
  }

  /**
   * Vincula una identidad de Google a una cuenta ya autenticada.
   *
   * Permite que un usuario cuyo correo de Google sea distinto al de su cuenta
   * inicie sesión con Google. El vínculo es explícito (desde Ajustes), nunca
   * implícito, para evitar tomas de cuenta por correos no verificados.
   */
  async linkGoogleAccount(
    userId: string,
    profile: GoogleProfile,
  ): Promise<GoogleLinkResult> {
    if (!profile.emailVerified) {
      return { ok: false, reason: 'unverified_email' };
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.isActive) {
      return { ok: false, reason: 'inactive' };
    }

    if (user.googleId) {
      return user.googleId === profile.sub
        ? { ok: true }
        : { ok: false, reason: 'already_linked' };
    }

    const owner = await this.prisma.user.findUnique({
      where: { googleId: profile.sub },
    });

    if (owner && owner.id !== user.id) {
      return { ok: false, reason: 'mismatch' };
    }

    const updated = await this.prisma.user.updateMany({
      where: { id: user.id, googleId: null },
      data: { googleId: profile.sub },
    });

    if (updated.count === 0) {
      return { ok: false, reason: 'already_linked' };
    }

    return { ok: true };
  }

  /**
   * Resuelve el usuario dueño de un access token válido.
   *
   * Se usa en el callback de Google en modo vinculación, donde la petición
   * llega desde el navegador (redirect) y no pasa por `JwtAuthGuard`.
   */
  async userIdFromAccessToken(token: string | undefined): Promise<string | null> {
    if (!token) {
      return null;
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtUser>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });

      if (!payload.sid) {
        return null;
      }

      const session = await this.prisma.authSession.findUnique({
        where: { id: payload.sid },
      });

      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.absoluteExpiresAt <= new Date()
      ) {
        return null;
      }

      return session.userId;
    } catch {
      return null;
    }
  }

  async logout(refreshToken: string | undefined) {
    if (refreshToken) {
      try {
        const payload = await this.jwt.verifyAsync<RefreshPayload>(
          refreshToken,
          { secret: this.config.get('JWT_REFRESH_SECRET') },
        );

        if (payload.sid) {
          await this.prisma.authSession.updateMany({
            where: { id: payload.sid, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
          });
        }
      } catch {
        // Un refresh token inválido o caducado no impide cerrar la sesión local.
      }
    }

    return { ok: true };
  }

  /** Sesiones activas del usuario, marcando la sesión actual. */
  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        impersonatedById: true,
      },
      take: 50,
    });

    return sessions.map((session) => ({
      ...session,
      current: session.id === currentSessionId,
    }));
  }

  /** Revoca una sesión concreta del propio usuario. */
  async revokeSession(userId: string, sessionId: string) {
    const result = await this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
    });

    if (result.count === 0) {
      throw new NotFoundException('Sesión no encontrada');
    }

    return { ok: true };
  }

  async refresh(refreshToken: string | undefined, meta: SessionMeta = {}) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token no proporcionado');
    }

    const payload = await this.verifyRefreshToken(refreshToken);
    if (!payload.sid) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
    });

    if (!session) {
      throw new UnauthorizedException('Sesión no encontrada');
    }

    const now = new Date();
    if (session.revokedAt) {
      // Una pestaña suspendida o una petición en paralelo puede volver con el
      // refresh anterior. No se cierran las demás sesiones del usuario.
      if (isRotatedSession(session)) {
        throw rotatedException();
      }

      // Un token ya cerrado (logout, revocación) se está reutilizando.
      await this.revokeAllSessions(session.userId, 'REUSE_DETECTED');
      throw new UnauthorizedException('Sesión revocada');
    }

    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new UnauthorizedException('Sesión expirada');
    }

    const valid = await verify(session.refreshTokenHash, refreshToken);
    if (!valid) {
      await this.revokeAllSessions(session.userId, 'REUSE_DETECTED');
      throw new UnauthorizedException('Refresh token inválido');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        memberships: {
          where: { isActive: true, organization: { isActive: true } },
          include: { organization: true },
          orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = payload.organizationId
      ? user.memberships.find(
          (item) => item.organizationId === payload.organizationId,
        )
      : user.memberships.find((item) => item.isOwner) ?? user.memberships[0];

    if (!membership) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    // Rotación atómica: solo una petición puede revocar la sesión actual.
    const rotated = await this.prisma.authSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'ROTATED' },
    });

    if (rotated.count === 0) {
      // Otra petición ganó la rotación hace un instante: no se revoca nada.
      const current = await this.prisma.authSession.findUnique({
        where: { id: session.id },
        select: {
          revokedAt: true,
          revokedReason: true,
          replacedBySessionId: true,
        },
      });

      if (current && isRotatedSession(current)) {
        throw rotatedException();
      }

      await this.revokeAllSessions(session.userId, 'REUSE_DETECTED');
      throw new UnauthorizedException('Refresh token reutilizado');
    }

    const tokens = await this.createSession(
      user.id,
      user.email,
      membership.roles,
      membership.organizationId,
      meta,
      membership.isOwner,
    );

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { replacedBySessionId: tokens.sessionId },
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /**
   * Abre una sesión de soporte en nombre de otro usuario.
   *
   * No toca las sesiones reales del usuario objetivo: crea una sesión
   * efímera sin refresh token, marcada con `impersonatedById`. El superadmin
   * puede editar datos del negocio; credenciales, 2FA y suscripción quedan
   * bloqueados por `ImpersonationWritePolicyInterceptor`.
   */
  async impersonate(
    actor: JwtUser,
    targetUserId: string,
    organizationId: string,
    meta: SessionMeta = {},
  ) {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException('Solo el equipo de Mishef puede impersonar');
    }

    if (!targetUserId || !organizationId) {
      throw new BadRequestException('Falta el usuario o el negocio');
    }

    if (targetUserId === actor.sub) {
      throw new BadRequestException('No puedes impersonarte a ti mismo');
    }

    const actorUser = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        isPlatformAdmin: true,
      },
    });

    if (!actorUser?.isActive || !actorUser.isPlatformAdmin) {
      throw new ForbiddenException('Tu cuenta ya no puede impersonar');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        memberships: {
          where: {
            organizationId,
            isActive: true,
            organization: { isActive: true },
          },
          include: { organization: { select: { id: true, name: true } } },
        },
      },
    });

    if (!target || !target.isActive) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (target.isPlatformAdmin) {
      throw new ForbiddenException(
        'No se puede impersonar a una cuenta de plataforma',
      );
    }

    const membership = target.memberships[0];

    if (!membership?.organizationId || !membership.organization) {
      throw new BadRequestException(
        'El usuario no tiene una membresía activa en ese negocio',
      );
    }

    const sessionId = randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + IMPERSONATION_TTL_MS);
    const actorName =
      actorUser.name?.trim() || actorUser.email || 'Soporte Mishef';

    const accessToken = await this.jwt.signAsync(
      {
        sub: target.id,
        email: target.email,
        roles: membership.roles,
        organizationId: membership.organizationId,
        sid: sessionId,
        impersonatedById: actorUser.id,
        impersonatedByName: actorName,
      } satisfies JwtUser,
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: '30m',
      },
    );

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId: target.id,
        // No hay refresh: la sesión se cierra sola o al salir de soporte.
        refreshTokenHash: `impersonation:${sessionId}`,
        expiresAt,
        absoluteExpiresAt: expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
        impersonatedById: actorUser.id,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: membership.organizationId,
        userId: actorUser.id,
        action: 'platform.impersonate.start',
        entity: 'User',
        entityId: target.id,
        newValues: {
          organizationId: membership.organizationId,
          organizationName: membership.organization.name,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });

    return {
      accessToken,
      expiresAt,
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        organizationName: membership.organization.name,
      },
      actor: {
        id: actorUser.id,
        name: actorName,
      },
    };
  }

  /** Revoca la sesión de soporte actual y deja auditoría del cierre. */
  async endImpersonation(user: JwtUser) {
    if (!user.impersonatedById) {
      throw new BadRequestException('No hay una impersonación activa');
    }

    const revoked = await this.prisma.authSession.updateMany({
      where: {
        id: user.sid,
        userId: user.sub,
        impersonatedById: user.impersonatedById,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedReason: 'IMPERSONATION_END',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.impersonatedById,
        action: 'platform.impersonate.end',
        entity: 'User',
        entityId: user.sub,
        newValues: {
          sessionId: user.sid,
          revoked: revoked.count,
        },
      },
    });

    return { ok: true };
  }

  async me(
    userId: string,
    impersonation?: { byId: string; byName: string | null },
    organizationId?: string | null,
  ) {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: {
            isActive: true,
            organization: { isActive: true },
            // La sesión (normal o de soporte) fija el negocio activo.
            ...(organizationId ? { organizationId } : {}),
          },
          include: { organization: true },
        },
      },
    });

    if (!found || !found.isActive) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = found.memberships[0];
    // `storageBytes` es BigInt y JSON no lo serializa. La sesión no lo usa: el
    // consumo vive en `/organizations/current`, ya formateado.
    const { storageBytes: _storageBytes, ...organizationFields } =
      membership?.organization ?? {};
    const organization = membership?.organization
      ? {
          ...organizationFields,
          practiceActive:
            membership.organization.practiceMode &&
            (!membership.organization.practiceUntil ||
              membership.organization.practiceUntil > new Date()),
        }
      : null;

    return {
      id: found.id,
      email: found.email,
      username: membership?.username ?? null,
      name: found.name,
      emailVerified: found.emailVerified,
      twoFactorEnabled: found.twoFactorEnabled,
      twoFactorTotpEnabled: found.twoFactorTotpEnabled,
      mustChangePassword: found.mustChangePassword,
      onboarded: Boolean(found.onboardedAt),
      googleLinked: Boolean(found.googleId),
      isPlatformAdmin: found.isPlatformAdmin,
      isOwner: membership?.isOwner ?? false,
      roles: membership?.roles ?? [],
      permissions: permissionsForRoles(membership?.roles ?? []),
      organizationId: membership?.organizationId,
      organizationSlug: membership?.organization?.slug ?? null,
      organization,
      // Sucursal fija del miembro: si existe, no puede operar en el consolidado.
      branchId: membership?.branchId ?? null,
      // El banner de soporte vive de estos dos campos; vienen del token de la
      // sesión efímera, no de la cuenta objetivo.
      impersonation: impersonation ?? null,
    };
  }

  /**
   * Edita el nombre, el usuario local y/o el correo de la cuenta actual.
   *
   * El username vive en la membresía del negocio activo. Cambiar el correo lo
   * deja sin verificar y desactiva 2FA hasta que se confirme la nueva dirección.
   */
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
    organizationId?: string | null,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { isActive: true, organization: { isActive: true } },
          include: { organization: true },
          orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = organizationId
      ? user.memberships.find((item) => item.organizationId === organizationId)
      : user.memberships.find((item) => item.isOwner) ?? user.memberships[0];

    if (!membership) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    let username: string | undefined;

    if (dto.username !== undefined) {
      username = normalizeUsername(dto.username);

      if (!isValidUsername(username)) {
        throw new BadRequestException(
          'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion y guion bajo; sin @dominio',
        );
      }

      if (username !== membership.username) {
        const taken = await this.prisma.membership.findFirst({
          where: {
            organizationId: membership.organizationId,
            username,
            id: { not: membership.id },
          },
          select: { id: true },
        });

        if (taken) {
          throw new ConflictException(
            'Ese nombre de usuario ya está en uso en este negocio',
          );
        }
      }
    }

    const email =
      dto.email !== undefined ? dto.email.trim().toLowerCase() : undefined;

    if (email !== undefined && email !== user.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (taken && taken.id !== userId) {
        throw new ConflictException('Ese correo ya está registrado');
      }
    }

    const name = dto.name === undefined ? undefined : dto.name.trim() || null;
    const nameChanged = name !== undefined && name !== user.name;
    const usernameChanged =
      username !== undefined && username !== membership.username;
    const emailChanged = email !== undefined && email !== user.email;

    if (!nameChanged && !usernameChanged && !emailChanged) {
      return {
        id: user.id,
        name: user.name,
        username: membership.username,
        email: user.email,
        emailVerified: user.emailVerified,
      };
    }

    await this.prisma.$transaction(async (tx) => {
      if (nameChanged || emailChanged || usernameChanged) {
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(nameChanged ? { name } : {}),
            ...(usernameChanged ? { username } : {}),
            ...(emailChanged
              ? {
                  email,
                  emailVerified: false,
                  twoFactorEnabled: false,
                  twoFactorTotpEnabled: false,
                  twoFactorTotpSecret: null,
                  twoFactorRecoveryCodes: [],
                }
              : {}),
          },
        });
      }

      if (usernameChanged) {
        await tx.membership.update({
          where: { id: membership.id },
          data: { username },
        });
      }
    });

    if (emailChanged) {
      await this.sendVerificationEmail(userId, email ?? null);
    }

    return {
      id: userId,
      name: nameChanged ? name : user.name,
      username: usernameChanged ? username : membership.username,
      email: emailChanged ? email : user.email,
      emailVerified: emailChanged ? false : user.emailVerified,
    };
  }

  /** Marca el onboarding como completado (idempotente). */
  async completeOnboarding(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardedAt: new Date() },
    });

    return { onboarded: true };
  }

  // --------------------------------------------------------------------------
  // Registro público (cada alta crea su propio negocio)
  // --------------------------------------------------------------------------

  async register(dto: RegisterDto, meta: SessionMeta = {}) {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese correo');
    }

    const passwordHash = await hash(dto.password);
    const organizationName =
      sanitizeBusinessName(dto.organizationName) ??
      sanitizeBusinessName(dto.name) ??
      `Negocio de ${email.split('@')[0]}`;
    let organizationId: string | null = null;

    // Dirección elegida por el negocio. Se valida y reserva aquí para no
    // descubrir la colisión a mitad de la transacción.
    let requestedSlug: string | undefined;
    if (dto.slug !== undefined && dto.slug.trim() !== '') {
      const candidate = normalizeSlug(dto.slug);

      if (!isValidSlug(candidate)) {
        throw new BadRequestException(
          'La dirección del negocio no es válida o está reservada',
        );
      }

      const taken = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (taken) {
        throw new ConflictException('Esa dirección de negocio ya está en uso');
      }

      requestedSlug = candidate;
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug: requestedSlug ?? buildOrganizationSlug(organizationName),
          practiceMode: true,
          practiceUntil: new Date(Date.now() + PRACTICE_WINDOW_MS),
        },
      });
      organizationId = organization.id;

      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name?.trim() || null,
        },
      });

      await tx.membership.create({
        data: {
          userId: created.id,
          organizationId: organization.id,
          roles: [Role.ADMIN],
          isOwner: true,
        },
      });

      return created;
    });
    if (this.inventory) await this.inventory.ensureCoreDefaults();
    if (organizationId) await this.billing?.startTrial(organizationId);
    await this.sendVerificationEmail(user.id, user.email);

    return this.issueSessionForUser(user.id, meta, organizationId);
  }

  // --------------------------------------------------------------------------
  // Verificación de correo
  // --------------------------------------------------------------------------

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (user.emailVerified) {
      throw new BadRequestException('El correo ya está verificado');
    }

    await this.sendVerificationEmail(user.id, user.email);

    return { ok: true };
  }

  async verifyEmail(rawToken: string) {
    const parsed = this.parseToken(rawToken);
    if (!parsed) {
      throw new BadRequestException('Código inválido o expirado');
    }

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { id: parsed.id },
    });

    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new BadRequestException('Código inválido o expirado');
    }

    const valid = await verify(record.tokenHash, parsed.secret);
    if (!valid) {
      throw new BadRequestException('Código inválido o expirado');
    }

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
      }),
    ]);

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Recuperación y cambio de contraseña
  // --------------------------------------------------------------------------

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Respuesta genérica: no revelamos si el correo existe.
    if (!user || !user.isActive || !user.email) {
      return { ok: true };
    }

    await this.prisma.passwordResetToken.deleteMany({
      where: { userId: user.id },
    });

    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await hash(secret);

    await this.prisma.passwordResetToken.create({
      data: {
        id,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    try {
      await this.mail.send({
        to: user.email,
        ...passwordResetEmail(
          `${id}.${secret}`,
          PASSWORD_RESET_TTL_MS / 60_000,
          this.webUrl(
            `/reset-password?token=${encodeURIComponent(`${id}.${secret}`)}`,
          ),
        ),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo enviar el correo de recuperación: ${(error as Error).message}`,
      );
    }

    return { ok: true };
  }

  async resetPassword(rawToken: string, password: string) {
    const parsed = this.parseToken(rawToken);
    if (!parsed) {
      throw new BadRequestException('Código inválido o expirado');
    }

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { id: parsed.id },
    });

    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new BadRequestException('Código inválido o expirado');
    }

    const valid = await verify(record.tokenHash, parsed.secret);
    if (!valid) {
      throw new BadRequestException('Código inválido o expirado');
    }

    const passwordHash = await hash(password);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.authSession.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      }),
    ]);

    await this.notifyPasswordChange(record.userId);

    return { ok: true };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (!user.passwordHash) {
      throw new BadRequestException(
        'Esta cuenta no tiene contraseña. Usa la recuperación de contraseña.',
      );
    }

    const valid = await verify(user.passwordHash, currentPassword);
    if (!valid) {
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'La nueva contraseña debe ser distinta a la actual',
      );
    }

    const passwordHash = await hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.authSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      }),
      this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id },
      }),
    ]);

    await this.notifyPasswordChange(user.id);

    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // 2FA por código de correo
  // --------------------------------------------------------------------------

  async startTwoFactorEnable(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (user.twoFactorEnabled) {
      throw new BadRequestException('La verificación en dos pasos ya está activa');
    }

    if (!user.email) {
      throw new BadRequestException(
        'Añade un correo a tu cuenta para activar la verificación en dos pasos',
      );
    }

    if (!user.emailVerified) {
      throw new BadRequestException(
        'Verifica tu correo antes de activar la verificación en dos pasos',
      );
    }

    const challenge = await this.createTwoFactorCode(
      user.id,
      TwoFactorPurpose.ENABLE,
    );

    await this.mail.send({
      to: user.email,
      ...twoFactorEmail(challenge.code, 'ENABLE'),
    });

    return { challengeId: challenge.id };
  }

  async confirmTwoFactorEnable(userId: string, challengeId: string, code: string) {
    const challenge = await this.consumeTwoFactorCode(
      challengeId,
      code,
      TwoFactorPurpose.ENABLE,
    );

    if (challenge.userId !== userId) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    const { codes: recoveryCodes, hashes: recoveryHashes } =
      await this.createRecoveryCodeSet();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorRecoveryCodes: recoveryHashes,
      },
    });

    return { twoFactorEnabled: true, recoveryCodes };
  }

  /** Genera el secreto TOTP y lo deja pendiente de confirmar. */
  async startTotpSetup(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (user.twoFactorTotpEnabled) {
      throw new BadRequestException(
        'La app autenticadora ya está activa. Desactiva 2FA para cambiarla.',
      );
    }

    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorTotpSecret: secret, twoFactorTotpEnabled: false },
    });

    return {
      secret,
      otpauthUrl: totpUri(
        secret,
        user.email ?? user.username ?? 'cuenta',
      ),
    };
  }

  /** Confirma el primer código de la app y activa TOTP. */
  async confirmTotpSetup(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user?.twoFactorTotpSecret) {
      throw new BadRequestException('Primero genera el secreto TOTP');
    }

    if (!verifyTotp(user.twoFactorTotpSecret, code)) {
      throw new BadRequestException('El código de la app no es válido');
    }

    const { codes: recoveryCodes, hashes: recoveryHashes } =
      await this.createRecoveryCodeSet();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorTotpEnabled: true,
        twoFactorRecoveryCodes: recoveryHashes,
      },
    });

    return { twoFactorEnabled: true, recoveryCodes };
  }

  private async createRecoveryCodeSet() {
    const codes = Array.from(
      { length: TWO_FACTOR_RECOVERY_CODE_COUNT },
      () => randomBytes(5).toString('hex'),
    );
    const hashes = await Promise.all(codes.map((code) => hash(code)));

    return { codes, hashes };
  }

  async disableTwoFactor(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (!user.passwordHash) {
      throw new BadRequestException(
        'Esta cuenta no tiene contraseña; no puede desactivar 2FA con ella.',
      );
    }

    const valid = await verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Contraseña incorrecta');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          twoFactorTotpEnabled: false,
          twoFactorTotpSecret: null,
          twoFactorRecoveryCodes: [],
        },
      }),
      this.prisma.twoFactorCode.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    ]);

    return { twoFactorEnabled: false };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async issueSessionForUser(
    userId: string,
    meta: SessionMeta,
    organizationId?: string | null,
    options: { notifyLogin?: boolean } = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { isActive: true, organization: { isActive: true } },
          include: { organization: true },
          orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = organizationId
      ? user.memberships.find((item) => item.organizationId === organizationId)
      : user.memberships.find((item) => item.isOwner) ??
        user.memberships.find((item) => item.roles.includes(Role.ADMIN)) ??
        user.memberships[0];

    if (!membership) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    if (
      !organizationId &&
      !membership.isOwner &&
      !membership.roles.includes(Role.ADMIN) &&
      !user.isPlatformAdmin
    ) {
      throw new UnauthorizedException(
        'Entra por el subdominio de tu negocio para iniciar sesión',
      );
    }

    const tokens = await this.createSession(
      user.id,
      user.email,
      membership.roles,
      membership.organizationId,
      meta,
      membership.isOwner,
    );

    const ip = meta.ip?.trim() || null;
    const userAgent = meta.userAgent?.trim() || null;
    const previousIp = user.lastLoginIp;
    const previousAgent = user.lastLoginUserAgent;

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: ip,
          lastLoginUserAgent: userAgent,
        },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el último inicio de sesión: ${
          (error as Error).message
        }`,
      );
    }

    if (
      options.notifyLogin &&
      user.email &&
      previousIp &&
      (previousIp !== ip || previousAgent !== userAgent)
    ) {
      try {
        await this.mail.send({
          to: user.email,
          ...loginAlertEmail({ ip, userAgent }),
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo enviar la alerta de inicio de sesión: ${
            (error as Error).message
          }`,
        );
      }
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: membership.username,
        roles: membership.roles,
        organizationId: membership.organizationId,
        organizationName: membership.organization?.name ?? '',
        organizationSlug: membership.organization?.slug ?? null,
        isOwner: membership.isOwner,
        isPlatformAdmin: user.isPlatformAdmin,
      },
    };
  }

  private async createSession(
    userId: string,
    email: string | null,
    roles: Role[],
    organizationId: string | null,
    meta: SessionMeta,
    isOwner = false,
  ) {
    const sessionId = randomUUID();
    const now = Date.now();

    const accessToken = await this.jwt.signAsync(
      {
        sub: userId,
        email,
        roles,
        organizationId,
        sid: sessionId,
        isOwner,
      } satisfies JwtUser,
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      {
        sub: userId,
        sid: sessionId,
        type: 'refresh',
        organizationId,
      } satisfies RefreshPayload,
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      },
    );

    const refreshTokenHash = await hash(refreshToken);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_TTL_MS),
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    return { accessToken, refreshToken, sessionId };
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<RefreshPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(
        refreshToken,
        { secret: this.config.get('JWT_REFRESH_SECRET') },
      );

      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Token inválido');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Refresh token inválido');
    }
  }

  private async revokeAllSessions(userId: string, reason: string) {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async sendVerificationEmail(userId: string, email: string | null) {
    if (!email) {
      return;
    }

    await this.prisma.emailVerificationToken.deleteMany({
      where: { userId },
    });

    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');

    await this.prisma.emailVerificationToken.create({
      data: {
        id,
        userId,
        tokenHash: await hash(secret),
        expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      },
    });

    try {
      await this.mail.send({
        to: email,
        ...verificationEmail(
          `${id}.${secret}`,
          this.webUrl(
            `/verify-email?token=${encodeURIComponent(`${id}.${secret}`)}`,
          ),
        ),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo enviar el correo de verificación: ${(error as Error).message}`,
      );
    }
  }

  /** URL del frontend para enlaces de correo (si `WEB_ORIGIN` está definido). */
  private webUrl(path: string): string | undefined {
    const origin = this.config.get<string>('WEB_ORIGIN');
    if (!origin) {
      return undefined;
    }

    return `${origin.replace(/\/$/, '')}${path}`;
  }

  private parseToken(rawToken: string): { id: string; secret: string } | null {    if (typeof rawToken !== 'string') {
      return null;
    }

    const separator = rawToken.indexOf('.');
    if (separator <= 0 || separator === rawToken.length - 1) {
      return null;
    }

    return {
      id: rawToken.slice(0, separator),
      secret: rawToken.slice(separator + 1),
    };
  }

  private async createTwoFactorCode(
    userId: string,
    purpose: TwoFactorPurpose,
    organizationId: string | null = null,
  ): Promise<{ id: string; code: string }> {
    await this.prisma.twoFactorCode.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.prisma.twoFactorCode.create({
      data: {
        id,
        userId,
        organizationId,
        purpose,
        codeHash: await hash(code),
        expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_MS),
      },
    });

    return { id, code };
  }

  private async consumeTwoFactorCode(
    challengeId: string,
    code: string,
    purpose: TwoFactorPurpose,
  ): Promise<{ userId: string; organizationId: string | null }> {
    const record = await this.prisma.twoFactorCode.findUnique({
      where: { id: challengeId },
    });

    if (
      !record ||
      record.purpose !== purpose ||
      record.consumedAt ||
      record.expiresAt <= new Date() ||
      record.attempts >= TWO_FACTOR_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    const valid = await verify(record.codeHash, code);
    if (!valid) {
      const attempts = record.attempts + 1;

      await this.prisma.twoFactorCode.update({
        where: { id: record.id },
        data: {
          attempts,
          consumedAt:
            attempts >= TWO_FACTOR_MAX_ATTEMPTS ? new Date() : undefined,
        },
      });

      throw new UnauthorizedException('Código inválido o expirado');
    }

    await this.prisma.twoFactorCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    return {
      userId: record.userId,
      organizationId: record.organizationId,
    };
  }

  private async notifyPasswordChange(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return;
    }

    if (!user.email) {
      return;
    }

    try {
      await this.mail.send({
        to: user.email,
        ...passwordChangedEmail(),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo enviar el aviso de cambio de contraseña: ${(error as Error).message}`,
      );
    }
  }
}
