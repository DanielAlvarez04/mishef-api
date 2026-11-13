/**
 * Validación de variables de entorno al arranque (plan.md §12).
 * Falla rápido si falta algo imprescindible; en producción exige secretos fuertes.
 */
const REQUIRED = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const INSECURE_SECRETS = new Set([
  'cambiar-en-produccion',
  'default-secret',
  'secret',
  'changeme',
]);

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of REQUIRED) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Falta la variable de entorno obligatoria ${key}`);
    }
  }

  const isProduction = config.NODE_ENV === 'production';

  const hasGoogleId = Boolean(config.GOOGLE_CLIENT_ID);
  const hasGoogleSecret = Boolean(config.GOOGLE_CLIENT_SECRET);

  if (hasGoogleId !== hasGoogleSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET deben configurarse juntas (o ninguna)',
    );
  }

  // Mercado Pago es opcional: si se configura cualquier variable del bloque,
  // deben estar todas para que la integración funcione de punta a punta.
  const mercadoPagoKeys = [
    'MP_CLIENT_ID',
    'MP_CLIENT_SECRET',
    'MP_REDIRECT_URI',
    'MP_WEBHOOK_SECRET',
    'MP_TOKEN_ENCRYPTION_KEY',
  ] as const;

  const hasMercadoPago = mercadoPagoKeys.some((key) => Boolean(config[key]));

  if (hasMercadoPago) {
    for (const key of mercadoPagoKeys) {
      const value = config[key];

      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `Falta la variable de entorno ${key} para la integración con Mercado Pago`,
        );
      }
    }

    const encryptionKey = Buffer.from(
      String(config.MP_TOKEN_ENCRYPTION_KEY),
      'base64',
    );

    if (encryptionKey.length !== 32) {
      throw new Error(
        'MP_TOKEN_ENCRYPTION_KEY debe ser una clave base64 de 32 bytes (AES-256)',
      );
    }
  }

  if (isProduction) {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const value = String(config[key]);

      if (INSECURE_SECRETS.has(value) || value.length < 32) {
        throw new Error(
          `La variable ${key} debe ser un secreto de al menos 32 caracteres en producción`,
        );
      }
    }

    if (!config.RESEND_API_KEY) {
      throw new Error(
        'RESEND_API_KEY es obligatoria en producción para verificación, recuperación y 2FA',
      );
    }

    if (!config.WEB_ORIGIN) {
      throw new Error('WEB_ORIGIN es obligatoria en producción');
    }

    // Swagger solo debe quedar expuesto detrás de basic auth. Se exige en
    // producción para que un despliegue sin credenciales falle al arrancar en
    // lugar de publicar `/docs` abierto.
    for (const key of ['SWAGGER_USER', 'SWAGGER_PASSWORD'] as const) {
      const value = config[key];

      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `${key} es obligatoria en producción para proteger /docs`,
        );
      }
    }
  }

  return config;
}
