import { createHash, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Límite por defecto de una imagen de catálogo (5 MB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Tipos aceptados y extensión con la que se guarda el objeto.
 *
 * La extensión se deriva del `content-type` validado, nunca del nombre que
 * manda el cliente.
 */
export const IMAGE_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type ImageContentType = keyof typeof IMAGE_CONTENT_TYPES;

/**
 * Módulos de carga. El valor coincide con la página/ruta de la app, no con el
 * tipo de contenido: así una receta y un artículo viven bajo `catalog/`.
 */
export type UploadModule =
  | 'catalog'
  | 'inventory'
  | 'users'
  | 'menus'
  | 'kitchen'
  | 'reports'
  | 'settings';

/**
 * Las variables se leen en cada llamada: `dotenv` corre después de los imports.
 *
 * Si falta alguna se responde 503 con una explicación accionable en vez de un
 * 500 genérico: casi siempre es que se editó `.env` con la API ya arrancada
 * (`nest start --watch` no recarga ese archivo) o que falta el bloque R2.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new ServiceUnavailableException(
      `Falta la variable de entorno ${name} (Cloudflare R2). Configúrala en api/.env y reinicia la API.`,
    );
  }

  return value;
}

export function r2Bucket(): string {
  return process.env.R2_BUCKET || 'sazona-public';
}

/** URL pública del bucket, sin barra final. */
export function r2PublicBaseUrl(): string {
  return requiredEnv('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
}

export function maxUploadBytes(): number {
  const configured = Number(process.env.R2_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_BYTES;
}

let cachedClient: S3Client | null = null;

/** Cliente S3 apuntando a la API S3 de R2. Se crea una sola vez. */
export function r2Client(): S3Client {
  if (cachedClient) return cachedClient;

  cachedClient = new S3Client({
    region: 'auto',
    endpoint:
      process.env.R2_ENDPOINT ||
      `https://${requiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });

  return cachedClient;
}

/**
 * Clave del objeto con la que el navegador sube el archivo.
 *
 * - El negocio va primero y luego la página (`catalog`, `inventory`, `users`…):
 *   permite reglas de ciclo de vida, auditoría y una futura migración a bucket
 *   privado por cliente.
 * - Cada entidad tiene su carpeta: `{org}/{página}/{entityId}/`. Para el
 *   catálogo, `entityId` es el `CatalogEntry.id`, compartido por la receta y su
 *   artículo.
 * - El nombre es un hash: no expone el nombre del artículo en un bucket
 *   público ni permite enumerar objetos. El nombre legible vive en la base
 *   (`CatalogEntry.imageName`).
 */
export function buildObjectKey(
  organizationId: string,
  module: UploadModule,
  entityId: string,
  contentType: ImageContentType,
): string {
  return `${assetFolder(organizationId, module, entityId)}/${objectHash()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

/** Hash opaco para el nombre del objeto (no expone el nombre del artículo). */
function objectHash(): string {
  return createHash('sha256')
    .update(randomUUID())
    .digest('hex')
    .slice(0, 32);
}

/** Carpeta de una presentación: `{org}/catalog/{entryId}/variants/{variantId}`. */
export function variantFolder(
  organizationId: string,
  catalogEntryId: string,
  variantId: string,
): string {
  return `${catalogFolder(organizationId, catalogEntryId)}/variants/${variantId}`;
}

/** Clave de la imagen propia de una presentación. */
export function buildVariantObjectKey(
  organizationId: string,
  catalogEntryId: string,
  variantId: string,
  contentType: ImageContentType,
): string {
  return `${variantFolder(organizationId, catalogEntryId, variantId)}/${objectHash()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

/** Carpeta de un módulo/entidad: `{org}/{página}/{entityId}`. */
export function assetFolder(
  organizationId: string,
  module: UploadModule,
  entityId: string,
): string {
  return `${organizationId}/${module}/${entityId}`;
}

/** Carpeta de un elemento del catálogo: `{org}/catalog/{entryId}`. */
export function catalogFolder(
  organizationId: string,
  catalogEntryId: string,
): string {
  return assetFolder(organizationId, 'catalog', catalogEntryId);
}

/**
 * Nombre normalizado del artículo para usarlo en la base.
 *
 * Minúsculas, sin acentos y solo `a-z0-9`. Ej.: "Café Americano" →
 * "cafeamericano".
 */
export function normalizeName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 60);

  return slug || 'articulo';
}

/**
 * Nombre legible que se guarda en la base: `snap{nombre}{DDMMYYHHMM}`.
 *
 * Todo corrido, sin guiones ni extensión. La hora va en local (no UTC) porque
 * el nombre es para leerlo, no para ordenar. Ej.: `snapcafeamericano3010261005`.
 */
export function imageSnapshotName(name: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${pad(date.getDate())}${pad(date.getMonth() + 1)}` +
    `${String(date.getFullYear()).slice(-2)}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`;

  return `snap${normalizeName(name)}${stamp}`;
}

export function publicUrlForKey(key: string): string {
  return `${r2PublicBaseUrl()}/${key}`;
}

/** Tipo de contenido a partir de la extensión de una clave ya guardada. */
export function contentTypeFromKey(key: string): ImageContentType | null {
  const extension = key.split('.').pop()?.toLowerCase();

  for (const [contentType, candidate] of Object.entries(IMAGE_CONTENT_TYPES)) {
    if (candidate === extension) return contentType as ImageContentType;
  }

  return null;
}

/** Segundos de validez de la URL firmada de subida. */
export const UPLOAD_URL_EXPIRES_IN = 300;

/**
 * Firma una subida directa del navegador a R2.
 *
 * Se usa **PUT** con `Content-Type` firmado: R2 todavía no implementa los
 * POST con política (`Presigned post requests are not yet implemented`), y el
 * navegador puede enviar el `Content-Type` sin problemas porque el CORS del
 * bucket lo permite. El tamaño se valida en el cliente y, al guardar, con
 * `objectSize`.
 */
export function presignPutUrl(key: string, contentType: ImageContentType) {
  return getSignedUrl(
    r2Client(),
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: UPLOAD_URL_EXPIRES_IN },
  );
}

/**
 * Tamaño del objeto en bytes, o `null` si no se pudo consultar.
 *
 * Es una comprobación best-effort: si R2 no responde, la subida ya validada en
 * el navegador se acepta igual.
 */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await r2Client().send(
      new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }),
    );

    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch {
    return null;
  }
}

/** Borra un objeto. Un fallo aquí nunca debe romper el guardado del artículo. */
export async function deleteR2Object(key: string): Promise<void> {
  try {
    await r2Client().send(
      new DeleteObjectCommand({ Bucket: r2Bucket(), Key: key }),
    );
  } catch {
    // Se ignora: el objeto huérfano se puede limpiar con una regla de ciclo de vida.
  }
}

/**
 * Copia un objeto dentro del bucket (server-side, sin descargarlo).
 *
 * Se usa en migraciones de rutas: primero se copia, luego se actualiza la base
 * y al final se borra el original.
 */
export async function copyR2Object(
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  await r2Client().send(
    new CopyObjectCommand({
      Bucket: r2Bucket(),
      CopySource: `${r2Bucket()}/${sourceKey}`,
      Key: targetKey,
    }),
  );
}
