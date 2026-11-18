import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Protección CSRF para la autenticación por cookies.
 *
 * Política: toda petición mutante (POST/PUT/PATCH/DELETE) que se autentique con
 * cookies debe traer un `Origin` (o `Referer`) que coincida con un origen de
 * confianza. Las peticiones con `Authorization: Bearer` o sin cookies no se ven
 * afectadas. Esto se combina con `sameSite: lax` en las cookies.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const usesCookies = Boolean(
      request.cookies?.np_at || request.cookies?.np_rt,
    );

    if (!usesCookies || request.get('authorization')) {
      return true;
    }

    const origin =
      request.get('origin') ?? this.originFromReferer(request.get('referer'));

    if (!origin || !this.allowedOrigins().includes(origin)) {
      throw new ForbiddenException('Origen de la petición no permitido');
    }

    return true;
  }

  private allowedOrigins(): string[] {
    const webOrigin = this.config.get<string>('WEB_ORIGIN');
    const apiOrigin =
      this.config.get<string>('API_PUBLIC_ORIGIN') ??
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;

    return [webOrigin, apiOrigin]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.replace(/\/$/, ''));
  }

  private originFromReferer(referer: string | undefined): string | null {
    if (!referer) {
      return null;
    }

    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
}
