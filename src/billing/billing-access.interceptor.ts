import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

import { JwtUser } from '../auth/auth.service';
import { BillingService } from './billing.service';

const ALLOWED_PREFIXES = [
  '/v1/auth',
  '/v1/billing',
  '/v1/platform',
  '/v1/webhooks',
  '/v1/public',
  '/v1/health',
  '/v1/mercadopago',
];

/**
 * Bloquea escrituras cuando la suscripción está vencida.
 *
 * Las lecturas y los endpoints de cobro/facturación siguen disponibles para
 * que el negocio pueda renovar o descargar su información.
 */
@Injectable()
export class BillingAccessInterceptor implements NestInterceptor {
  constructor(private readonly billing: BillingService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtUser }>();
    const user = request.user;

    if (
      !user?.organizationId ||
      user.isPlatformAdmin ||
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      return next.handle();
    }

    const path = request.path ?? request.url.split('?')[0];

    if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return next.handle();
    }

    if (!(await this.billing.canWrite(user.organizationId))) {
      throw new HttpException(
        'Tu suscripción está vencida. Renueva el plan para seguir operando.',
        402,
      );
    }

    return next.handle();
  }
}
