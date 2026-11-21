import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import type { JwtUser } from './auth.service';

/**
 * Defensa adicional del aislamiento por subdominio.
 *
 * El panel envía `x-tenant-slug` con el negocio del host. Si la sesión
 * pertenece a otra organización, la petición se rechaza aunque la cookie sea
 * válida. Sin cabecera (POS, API directa, dominio principal) no se aplica.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtUser }>();

    const tenant = request.headers['x-tenant-slug'];
    const sessionSlug = request.user?.organizationSlug;
    const requested = Array.isArray(tenant) ? tenant[0] : tenant;

    if (request.user?.isPlatformAdmin) {
      return next.handle();
    }

    if (
      requested &&
      sessionSlug &&
      requested.trim().toLowerCase() !== sessionSlug.toLowerCase()
    ) {
      throw new ForbiddenException(
        'La sesión pertenece a otro negocio. Entra por su subdominio.',
      );
    }

    return next.handle();
  }
}
