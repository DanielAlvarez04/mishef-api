import { NestFactory } from '@nestjs/core';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { isAllowedWebOrigin } from './common/allowed-origin';
import { swaggerBasicAuth } from './common/swagger-basic-auth';

/**
 * Carga `api/.env`.
 *
 * Se buscan dos rutas para que funcione tanto si el proceso arranca dentro de
 * `api/` (lo habitual) como desde la raíz del repositorio: el `cwd` y el
 * directorio del paquete (`dist/src` → `api/`).
 */
const envPath = [
  resolve(process.cwd(), '.env'),
  resolve(__dirname, '..', '..', '.env'),
].find((candidate) => existsSync(candidate));

config(envPath ? { path: envPath } : {});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Delante de la API hay dos proxies: Cloudflare y Traefik (Dokploy). Hay que
  // confiar en dos capas para que `req.ip` y el throttler lean la IP real del
  // cliente (X-Forwarded-For) y no la del borde de Cloudflare. Con 1 se toma el
  // segundo salto contando desde la derecha, que es la IP de Cloudflare: todos
  // los clientes compartirían el mismo cubo de rate limit.
  app.set('trust proxy', 2);

  // Cabeceras de seguridad. La CSP se deja fuera a propósito: la UI de Swagger
  // usa scripts inline y la API no sirve HTML propio.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:3000';
  const apiOrigin = process.env.API_PUBLIC_ORIGIN;
  const tenantDomain = (process.env.TENANT_DOMAIN ?? 'mishef.co')
    .trim()
    .toLowerCase();

  app.enableCors({
    origin: (origin, callback) => {
      // Sin Origin son peticiones server-to-server o curl: CORS no aplica.
      if (!origin) return callback(null, true);

      callback(
        null,
        isAllowedWebOrigin(origin, webOrigin, apiOrigin, tenantDomain),
      );
    },
    credentials: true,
  });

  // Las respuestas grandes (catálogo, menús, dashboard) son JSON y se
  // benefician mucho de gzip. El umbral evita comprimir respuestas diminutas.
  app.use(compression({ threshold: 1024 }));

  app.use(cookieParser());

  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Naranja Pimienta API')
    .setDescription('API de sistema POS para cafetería')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // Debe registrarse antes que `SwaggerModule.setup`, que añade las rutas de
  // `/docs` al adaptador HTTP.
  app.use(swaggerBasicAuth());

  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
