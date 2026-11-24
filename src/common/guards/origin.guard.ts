import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { isAllowedWebOrigin } from '../allowed-origin';

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
      request.cookies?.np_at ||
        request.cookies?.np_rt ||
        request.cookies?.np_imp,
    );

    if (!usesCookies || request.get('authorization')) {
      return true;
    }

    const origin =
      request.get('origin') ?? this.originFromReferer(request.get('referer'));

    if (!origin || !this.isAllowedOrigin(origin)) {
      throw new ForbiddenException('Origen de la petición no permitido');
    }

    return true;
  }

  private isAllowedOrigin(origin: string): boolean {
    const webOrigin = this.config.get<string>('WEB_ORIGIN');
    const apiOrigin =
      this.config.get<string>('API_PUBLIC_ORIGIN') ??
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;
    const tenantDomain = (this.config.get<string>('TENANT_DOMAIN') ?? 'mishef.co')
      .trim()
      .toLowerCase();

    return isAllowedWebOrigin(origin, webOrigin, apiOrigin, tenantDomain);
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
