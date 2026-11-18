import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JwtUser } from '../auth/auth.service';

/**
 * Permiso para editar los estilos globales.
 *
 * Además del platform admin, se puede autorizar por correo con
 * `DESIGN_EDITOR_EMAILS` (lista separada por comas). Así se prueban los estilos
 * con cuentas reales sin darles acceso al resto de la plataforma.
 */
const DEFAULT_EDITORS = ['portafolio.d.alvarez@gmail.com'];

@Injectable()
export class DesignEditorGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtUser }>();
    const user = request.user;

    if (user?.isPlatformAdmin) return true;

    const email = user?.email?.trim().toLowerCase();

    if (email && this.allowedEmails().has(email)) return true;

    throw new ForbiddenException(
      'Solo el equipo de Mishef puede editar los estilos',
    );
  }

  private allowedEmails(): Set<string> {
    const configured = this.config.get<string>('DESIGN_EDITOR_EMAILS') ?? '';

    return new Set(
      [...DEFAULT_EDITORS, ...configured.split(',')]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
  }
}
