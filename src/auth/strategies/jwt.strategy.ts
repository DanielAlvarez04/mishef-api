import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtUser } from '../auth.service';

const ACCESS_TOKEN_COOKIE = 'np_at';

/** El frontend usa cookies httpOnly; se acepta también `Authorization: Bearer` para Swagger. */
function fromCookieOrHeader(req: Request): string | null {
  const cookieToken = req?.cookies?.[ACCESS_TOKEN_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken;
  }
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET no está definido');
    }
    super({
      jwtFromRequest: fromCookieOrHeader,
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Valida el token y comprueba que la sesión siga viva.
   * Así el logout, el cambio de contraseña y la desactivación de un usuario
   * surten efecto de inmediato, sin esperar a que caduque el access token.
   */
  async validate(payload: JwtUser): Promise<JwtUser> {
    if (!payload.sid) {
      throw new UnauthorizedException('Sesión inválida');
    }

    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          include: {
            memberships: {
              where: {
                organizationId: payload.organizationId,
                isActive: true,
                organization: { isActive: true },
              },
            },
          },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      !session.user.isActive
    ) {
      throw new UnauthorizedException('Sesión inválida');
    }

    const membership = session.user.memberships[0];
    if (!membership) {
      throw new UnauthorizedException('Usuario sin membresía activa');
    }

    return {
      sub: session.user.id,
      email: session.user.email,
      roles: membership.roles,
      organizationId: membership.organizationId,
      sid: session.id,
      branchId: membership.branchId,
    };
  }
}
