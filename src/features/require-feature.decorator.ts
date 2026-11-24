import { SetMetadata } from '@nestjs/common';

/**
 * Marca un controlador o una ruta como perteneciente a una función.
 *
 * Se usa cuando la ruta no coincide con la ruta pública de la página (por
 * ejemplo, los cobros viven en `/orders/:id/payments`). El interceptor
 * `FeatureAccessInterceptor` lo evalúa antes de llegar al servicio.
 */
export const REQUIRED_FEATURE_KEY = 'required-feature';

export const RequireFeature = (feature: string) =>
  SetMetadata(REQUIRED_FEATURE_KEY, feature);
