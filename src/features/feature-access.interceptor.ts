import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

import { JwtUser } from '../auth/auth.service';
import {
  FEATURE_CATALOG,
  featureForApiPath,
} from '../common/features';
import { FeaturesService } from './features.service';
import { REQUIRED_FEATURE_KEY } from './require-feature.decorator';

/**
 * Corta el acceso a la API de una función que el negocio tiene apagada.
 *
 * La UI también oculta la página, pero esto es la barrera real: aunque alguien
 * escriba la URL o llame al endpoint directamente, la API responde 403.
 *
 * La función se resuelve primero por `@RequireFeature(...)` y, si la ruta no
 * lo declara, por el prefijo de la ruta. Los módulos compartidos por varias
 * pantallas (`catalog`, `inventory`, `cash`, `orders`, `analytics`) no se
 * mapean por prefijo a propósito: apagarlos desde la matriz rompería POS,
 * reportes o configuración.
 */
@Injectable()
export class FeatureAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly features: FeaturesService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context
      .switchToHttp()
      .getRequest<{ path?: string; url: string; user?: JwtUser }>();
    const user = request.user;

    if (!user?.organizationId || user.isPlatformAdmin) {
      return next.handle();
    }

    const rawPath = request.path ?? request.url.split('?')[0];
    const path = rawPath.replace(/^\/v1(?=\/|$)/, '');

    const allowed = [
      '/auth',
      '/billing',
      '/platform',
      '/features',
      '/public',
      '/health',
      '/webhooks',
      '/mercadopago',
    ];

    if (
      allowed.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      )
    ) {
      return next.handle();
    }

    const declared = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const featureKey = declared ?? featureForApiPath(path);

    if (!featureKey) return next.handle();

    const enabled = await this.features.isEnabled(
      user.organizationId,
      featureKey,
    );

    if (!enabled) {
      const label =
        FEATURE_CATALOG.find((feature) => feature.key === featureKey)?.label ??
        featureKey;

      throw new ForbiddenException(
        `La función «${label}» no está habilitada para este negocio.`,
      );
    }

    return next.handle();
  }
}
