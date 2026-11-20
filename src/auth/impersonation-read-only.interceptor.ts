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

/** Únicas mutaciones permitidas dentro de una sesión de soporte. */
const ALLOWED_PATHS = new Set([
  '/v1/auth/impersonation/end',
  // Por si el router entrega la ruta sin el prefijo global.
  '/auth/impersonation/end',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Congela la app mientras un superadmin la ve como otro usuario.
 *
 * La impersonación es de solo lectura: se bloquea cualquier mutación
 * (POST/PUT/PATCH/DELETE) salvo cerrar la propia sesión de soporte. Así una
 * revisión de soporte no puede cobrar, editar el catálogo ni cambiar ajustes
 * del negocio por accidente.
 */
@Injectable()
export class ImpersonationReadOnlyInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtUser }>();

    if (
      !request.user?.impersonatedById ||
      SAFE_METHODS.has(request.method)
    ) {
      return next.handle();
    }

    const path = request.path ?? request.url.split('?')[0];

    if (ALLOWED_PATHS.has(path)) {
      return next.handle();
    }

    throw new ForbiddenException(
      'La impersonación es de solo lectura: no se pueden modificar datos.',
    );
  }
}
