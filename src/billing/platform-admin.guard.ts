import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { JwtUser } from '../auth/auth.service';

/** Guard interno: solo cuentas marcadas como platform admin. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtUser }>();

    if (!request.user?.isPlatformAdmin) {
      throw new ForbiddenException(
        'Solo el equipo de Mishef puede acceder a esta sección',
      );
    }

    return true;
  }
}

export function requireOrganization(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene un negocio activo');
  }

  return user.organizationId;
}
