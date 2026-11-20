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
import { Role, TwoFactorPurpose } from '@prisma/client';
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
import { MailService } from '../mail/mail.service';
import type { GoogleProfile } from './google-oauth.service';
import { InventoryService } from '../inventory/inventory.service';
import { BillingService } from '../billing/billing.service';
import {
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
  /** Usuario de plataforma que abrió esta sesión de soporte. */
  impersonatedById?: string | null;
  /** Nombre visible del actor, para el banner de soporte. */
  impersonatedByName?: string | null;
}

export interface RefreshPayload {
  sub: string;
  sid: string;
  type: 'refresh';
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
  | { kind: 'twofactor'; challengeId: string; email: string }
  | {
      kind: 'error';
      reason:
        | 'no_account'
        | 'inactive'
        | 'no_membership'
        | 'mismatch'
        | 'unverified_email';
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
  },
} as const;

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
    const identifier = dto.identifier.trim().toLowerCase();
    const include = {
      memberships: {
        where: { isActive: true, organization: { isActive: true } },
        include: { organization: true },
      },
    } as const;

    // El identificador con `@` es siempre un correo. Antes se probaba también
    // como `username`, lo que permitía crear usuarios con forma de correo y
    // confundir cuentas entre negocios: ya no se admite.
    let user = await this.prisma.user.findUnique({
      where: identifier.includes('@')
        ? { email: identifier }
        : { username: identifier },
      include,
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Si la petición viene de un subdominio de negocio, la cuenta debe
    // pertenecer a esa organización. Sin esto, el login de `micafeteria`
    // aceptaría a un empleado de otro negocio y la sesión se crearía igual.
    if (dto.tenant) {
      const tenant = normalizeSlug(dto.tenant);
      const belongs = user.memberships.some(
        (membership) => membership.organization?.slug === tenant,
      );

      if (!belongs) {
        throw new UnauthorizedException(
          'Esta cuenta no pertenece a este negocio',
        );
      }
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    if (user.memberships.length === 0) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    if (user.twoFactorEnabled) {
      if (!user.email) {
        throw new UnauthorizedException(
          'La cuenta no tiene un correo para el segundo factor',
        );
      }

      const challenge = await this.createTwoFactorCode(
        user.id,
        TwoFactorPurpose.LOGIN,
      );

      await this.mail.send({
        to: user.email,
        ...twoFactorEmail(challenge.code, 'LOGIN'),
      });

      return {
        twoFactorRequired: true as const,
        challengeId: challenge.id,
        email: user.email,
      };
    }

    return this.issueSessionForUser(user.id, meta);
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
    );

    return {
      ...tokens,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        roles: membership.roles,
      },
    };
  }

  async verifyTwoFactor(
    challengeId: string,
    code: string,
    meta: SessionMeta = {},
  ) {
    const userId = await this.consumeTwoFactorCode(
      challengeId,
      code,
      TwoFactorPurpose.LOGIN,
    );

    return this.issueSessionForUser(userId, meta);
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
    options: { businessName?: string } = {},
  ): Promise<GoogleLoginResult> {
    const email = profile.email.trim().toLowerCase();

    if (!profile.emailVerified) {
      return { kind: 'error', reason: 'unverified_email' };
    }

    let user = await this.prisma.user.findUnique({
      where: { googleId: profile.sub },
      include: googleUserInclude,
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email },
        include: googleUserInclude,
      });
    }

    if (!user) {
      return this.registerWithGoogle(profile, email, meta, options.businessName);
    }

    if (!user.isActive) {
      return { kind: 'error', reason: 'inactive' };
    }

    if (user.googleId && user.googleId !== profile.sub) {
      return { kind: 'error', reason: 'mismatch' };
    }

    const membership = user.memberships[0];
    if (!membership) {
      return { kind: 'error', reason: 'no_membership' };
    }

    // Vinculación idempotente: si otra petición ya vinculó la cuenta, no duplica.
    if (!user.googleId) {
      await this.prisma.user.updateMany({
        where: { id: user.id, googleId: null },
        data: { googleId: profile.sub },
      });
    }

    if (!user.emailVerified) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    if (user.twoFactorEnabled) {
      if (!user.email) {
        return { kind: 'error', reason: 'unverified_email' };
      }

      const challenge = await this.createTwoFactorCode(
        user.id,
        TwoFactorPurpose.LOGIN,
      );

      await this.mail.send({
        to: user.email,
        ...twoFactorEmail(challenge.code, 'LOGIN'),
      });

      return {
        kind: 'twofactor',
        challengeId: challenge.id,
        email: user.email,
      };
    }

    const session = await this.issueSessionForUser(user.id, meta);

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
          },
        });

        return user;
      });

      const session = await this.issueSessionForUser(created.id, meta);
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
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = user.memberships[0];
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
      username: found.username,
      name: found.name,
      emailVerified: found.emailVerified,
      twoFactorEnabled: found.twoFactorEnabled,
      onboarded: Boolean(found.onboardedAt),
      googleLinked: Boolean(found.googleId),
      isPlatformAdmin: found.isPlatformAdmin,
      roles: membership?.roles ?? [],
      organizationId: membership?.organizationId,
      organization,
      // Sucursal fija del miembro: si existe, no puede operar en el consolidado.
      branchId: membership?.branchId ?? null,
      // El banner de soporte vive de estos dos campos; vienen del token de la
      // sesión efímera, no de la cuenta objetivo.
      impersonation: impersonation ?? null,
    };
  }

  /**
   * Edita el nombre visible y/o el nombre de usuario de la cuenta actual.
   *
   * Se usa en el onboarding (Admin dueño del negocio) y desde Ajustes. El
   * usuario se normaliza a minúsculas y debe ser único entre todas las cuentas.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    let username: string | undefined;

    if (dto.username !== undefined) {
      username = normalizeUsername(dto.username);

      if (!isValidUsername(username)) {
        throw new BadRequestException(
          'El usuario debe tener entre 3 y 120 caracteres: letras, números, punto, guion, guion bajo y, opcionalmente, @dominio',
        );
      }

      if (username !== user.username) {
        const taken = await this.prisma.user.findUnique({
          where: { username },
        });

        if (taken) {
          throw new ConflictException('Ese nombre de usuario ya está en uso');
        }
      }
    }

    const name = dto.name === undefined ? undefined : dto.name.trim() || null;
    const nameChanged = name !== undefined && name !== user.name;
    const usernameChanged = username !== undefined && username !== user.username;

    const updated =
      nameChanged || usernameChanged
        ? await this.prisma.user.update({
            where: { id: userId },
            data: {
              ...(nameChanged ? { name } : {}),
              ...(usernameChanged ? { username } : {}),
            },
          })
        : user;

    return {
      id: updated.id,
      name: updated.name,
      username: updated.username,
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
        },
      });

      return created;
    });
    if (this.inventory) await this.inventory.ensureCoreDefaults();
    if (organizationId) await this.billing?.startTrial(organizationId);
    await this.sendVerificationEmail(user.id, user.email);

    return this.issueSessionForUser(user.id, meta);
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
        data: { passwordHash },
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
        data: { passwordHash },
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
    const owner = await this.consumeTwoFactorCode(
      challengeId,
      code,
      TwoFactorPurpose.ENABLE,
    );

    if (owner !== userId) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });

    return { twoFactorEnabled: true };
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
        data: { twoFactorEnabled: false },
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

  private async issueSessionForUser(userId: string, meta: SessionMeta) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { isActive: true, organization: { isActive: true } },
          include: { organization: true },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = user.memberships[0];
    if (!membership) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    const tokens = await this.createSession(
      user.id,
      user.email,
      membership.roles,
      membership.organizationId,
      meta,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: membership.roles,
        organizationId: membership.organizationId,
        organizationName: membership.organization?.name ?? '',
      },
    };
  }

  private async createSession(
    userId: string,
    email: string | null,
    roles: Role[],
    organizationId: string | null,
    meta: SessionMeta,
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
      } satisfies JwtUser,
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'refresh' } satisfies RefreshPayload,
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
  ): Promise<string> {
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

    return record.userId;
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
