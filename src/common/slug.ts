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
 * subdominios de infraestructura o rutas que ya existen.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'blog',
  'cdn',
  'dokploy',
  'docs',
  'help',
  'img',
  'login',
  'mail',
  'mishef',
  'status',
  'soporte',
  'static',
  'support',
  'www',
]);

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
