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

/**
 * Prefijos que siguen bloqueados en una sesión de soporte.
 *
 * El superadmin puede editar el negocio (catálogo, inventario, ajustes,
 * terminales de Mercado Pago, equipo...), pero no cambiar credenciales, 2FA ni
 * la suscripción: son acciones que el cliente debe hacer por su cuenta.
 */
const PROTECTED_PREFIXES = ['/v1/auth', '/v1/billing', '/auth', '/billing'];

/** Única mutación de `/auth` permitida: cerrar la propia sesión de soporte. */
const ALLOWED_PATHS = new Set([
  '/v1/auth/impersonation/end',
  // Por si el router entrega la ruta sin el prefijo global.
  '/auth/impersonation/end',
]);

/**
 * Política de escritura de la impersonación.
 *
 * La sesión de soporte opera como el usuario objetivo para poder corregir datos
 * reales, pero conserva un límite de seguridad: nada de contraseñas, segundo
 * factor ni cambios de plan/suscripción.
 */
@Injectable()
export class ImpersonationWritePolicyInterceptor implements NestInterceptor {
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

    const blocked = PROTECTED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );

    if (!blocked) {
      return next.handle();
    }

    throw new ForbiddenException(
      'La sesión de soporte no puede cambiar credenciales, seguridad ni la suscripción.',
    );
  }
}
