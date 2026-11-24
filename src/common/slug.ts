import { randomBytes } from 'node:crypto';

/** Convierte un nombre libre en un slug ASCII seguro para URL. */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'negocio'
  );
}

/** Slug único por negocio; el sufijo aleatorio evita colisiones entre cafeterías. */
export function buildOrganizationSlug(name: string): string {
  return `${slugify(name)}-${randomBytes(3).toString('hex')}`;
}

/** Longitud máxima de una dirección elegida por el negocio (`mi-cafeteria`). */
export const MAX_SLUG_LENGTH = 32;

/** Longitud mínima: evita direcciones de una letra. */
export const MIN_SLUG_LENGTH = 3;

/**
 * Direcciones que no puede tomar un negocio porque chocan con servicios,
 * subdominios de infraestructura, correo o rutas que ya existen.
 *
 * Regla: solo se reservan palabras de infraestructura, producto y marca. Nunca
 * palabras normales de negocio (`menu`, `cafe`, `bar`, `pan`…), porque eso le
 * quitaría direcciones legítimas a los clientes.
 */
const RESERVED_WORDS = [
  // Infraestructura y marca
  'www',
  'app',
  'api',
  'img',
  'cdn',
  'static',
  'assets',
  'dokploy',
  'mishef',
  'saas',
  'mail',
  'send',
  'rsend',
  'links',
  'ns1',
  'ns2',
  'mx',
  'dns',
  'autodiscover',
  'autoconfig',
  'ftp',
  'ssh',
  'vpn',
  'internal',
  // Autenticación y cuentas
  'admin',
  'auth',
  'login',
  'logout',
  'register',
  'signup',
  'onboarding',
  'account',
  'sso',
  'id',
  // Producto y futuro
  'pay',
  'pagos',
  'billing',
  'checkout',
  'dash',
  'dashboard',
  'panel',
  'console',
  'ai',
  'ia',
  'cfdi',
  'facturas',
  'docs',
  'help',
  'soporte',
  'support',
  'status',
  'blog',
  'm',
  'mobile',
  // Operación técnica
  'webhook',
  'webhooks',
  'hooks',
  'jobs',
  'queue',
  'metrics',
  'monitor',
  'db',
  'postgres',
  'redis',
  'test',
  'demo',
  'staging',
  'dev',
  'prod',
  'sandbox',
  // Analítica
  'tracking',
  'analytics',
  'data',
  // Letras sueltas (hoy imposibles por la longitud mínima, reservadas por si
  // algún día cambia)
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
];

export const RESERVED_SLUGS = new Set(RESERVED_WORDS);

/**
 * Slugs reservados que sí pueden resolver como negocio.
 *
 * Solo se usa para demos controladas (por defecto `demo`). Las altas normales
 * siguen pasando por `isValidSlug`, así que un cliente no puede reclamar
 * `demo`, `api` ni ningún otro reservado. Configurable con
 * `DEMO_TENANT_SLUGS=demo,otra-demo`; vacío desactiva la excepción.
 *
 * Se lee en la primera petición, no al importar el módulo, para que `dotenv`
 * ya haya cargado el `.env` en desarrollo.
 */
let resolvableReservedSlugs: Set<string> | null = null;

function getResolvableReservedSlugs(): Set<string> {
  if (!resolvableReservedSlugs) {
    resolvableReservedSlugs = new Set(
      (process.env.DEMO_TENANT_SLUGS ?? 'demo')
        .split(',')
        .map((value) => normalizeSlug(value))
        .filter(Boolean),
    );
  }

  return resolvableReservedSlugs;
}

/**
 * Normaliza una dirección escrita por el usuario: mayúsculas, acentos,
 * espacios y guiones repetidos.
 */
export function normalizeSlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/** `true` si la dirección puede usarse como subdominio. */
export function isValidSlug(slug: string): boolean {
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) {
    return false;
  }

  if (RESERVED_SLUGS.has(slug)) return false;

  // Solo minúsculas, números y guiones; sin guion al inicio o al final y sin
  // guiones consecutivos (un subdominio con `--` es válido pero confuso).
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * `true` si el slug puede resolver un negocio, aunque esté reservado.
 *
 * Se usa al resolver el tenant (subdominio y Google), no al crear o cambiar la
 * dirección de un negocio: esas rutas siguen usando `isValidSlug`.
 */
export function isResolvableTenantSlug(slug: string): boolean {
  if (!slug) return false;

  if (getResolvableReservedSlugs().has(slug)) {
    return (
      slug.length >= MIN_SLUG_LENGTH &&
      slug.length <= MAX_SLUG_LENGTH &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    );
  }

  return isValidSlug(slug);
}
