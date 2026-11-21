import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

import type { JwtUser } from '../auth.service';

/**
 * Exige correo verificado para acciones sensibles (facturación, dominio).
 *
 * No bloquea el login ni la operación diaria: solo evita comprometer dinero o
 * infraestructura desde una cuenta cuyo correo no está probado.
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtUser }>();

    if (!request.user?.emailVerified) {
      throw new ForbiddenException(
        'Verifica tu correo electrónico para usar esta función.',
      );
    }

    return true;
  }
}
