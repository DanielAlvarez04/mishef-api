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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALLOWED_PATHS = new Set([
  '/v1/auth/change-password',
  '/v1/auth/logout',
  '/v1/auth/impersonation/end',
  '/auth/change-password',
  '/auth/logout',
  '/auth/impersonation/end',
]);

/**
 * Bloquea la operación normal hasta que la cuenta cambie la contraseña
 * inicial que le asignó un administrador.
 */
@Injectable()
export class PasswordChangeInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtUser }>();

    if (
      !request.user?.mustChangePassword ||
      SAFE_METHODS.has(request.method)
    ) {
      return next.handle();
    }

    const path = request.path ?? request.url.split('?')[0];

    if (ALLOWED_PATHS.has(path)) {
      return next.handle();
    }

    throw new ForbiddenException(
      'Debes cambiar la contraseña inicial antes de continuar.',
    );
  }
}
