import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Rutas que sirve `SwaggerModule`: `/docs`, `/docs/`, los assets
 * (`/docs/swagger-ui.css`) y los documentos JSON/YAML (`/docs-json`,
 * `/docs-yaml`). El guion se incluye para cubrir las dos últimas sin abrir
 * rutas ajenas como `/docs-otra-cosa`.
 */
const SWAGGER_PATH = /^\/docs(?:[/-]|$)/;

/**
 * Comparación de tiempo constante. `timingSafeEqual` exige buffers del mismo
 * tamaño, así que la longitud se comprueba antes: esa comparación filtra un bit
 * (si las longitudes coinciden) pero no permite ir adivinando el valor.
 */
function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}

function deny(res: Response): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="Mishef API", charset="UTF-8"');
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).send('Autenticación requerida');
}

/**
 * Basic auth para la documentación de Swagger.
 *
 * Se resuelve en la API (y no en el reverse proxy) para poder proteger solo
 * `/docs*` sin bloquear el resto del dominio, que consume la web.
 *
 * En producción `SWAGGER_USER` y `SWAGGER_PASSWORD` son obligatorias (ver
 * `config/env.validation.ts`), así que allí nunca se sirve `/docs` sin
 * credenciales. En desarrollo, si no están definidas, la documentación queda
 * accesible como antes.
 */
export function swaggerBasicAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!SWAGGER_PATH.test(req.path)) {
      next();
      return;
    }

    const user = process.env.SWAGGER_USER;
    const password = process.env.SWAGGER_PASSWORD;

    // Red de seguridad: el arranque en producción ya falla si faltan.
    if (!user || !password) {
      if (process.env.NODE_ENV === 'production') {
        deny(res);
        return;
      }

      next();
      return;
    }

    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'basic' || !encoded) {
      deny(res);
      return;
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      deny(res);
      return;
    }

    // Ambas comparaciones se evalúan siempre para no filtrar por tiempo cuál
    // de las dos falló.
    const userOk = equalSecret(decoded.slice(0, separator), user);
    const passwordOk = equalSecret(decoded.slice(separator + 1), password);

    if (!userOk || !passwordOk) {
      deny(res);
      return;
    }

    next();
  };
}
