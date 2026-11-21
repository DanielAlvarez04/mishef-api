/**
 * Reglas compartidas del nombre de usuario local y del dominio del negocio.
 *
 * El username identifica a la persona **dentro de un negocio**: el subdominio
 * resuelve la organización y el username solo se busca en su membresía. Nunca
 * lleva `@dominio`; el correo es un dato aparte.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_LOCAL_PATTERN = /^[a-z0-9._-]+$/;

/** Dominio con al menos dos etiquetas: `naranjapimienta.cafe`. */
export const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidDomain(value: string): boolean {
  return value.length >= 3 && value.length <= 80 && DOMAIN_PATTERN.test(value);
}

/** Username local: minúsculas, letras, números, punto, guion y guion bajo. */
export function isValidUsername(value: string): boolean {
  if (
    value.length < USERNAME_MIN_LENGTH ||
    value.length > USERNAME_MAX_LENGTH
  ) {
    return false;
  }

  return USERNAME_LOCAL_PATTERN.test(value);
}

/** Separa un nombre en nombre de pila y primer apellido (sin acentos). */
export function splitName(name: string): { first: string; surname: string } {
  const words = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return { first: words[0] ?? '', surname: words[1] ?? '' };
}

/**
 * Usuarios propuestos para un nombre, en orden de preferencia:
 * `ana`, `a.perez`, `a.perez2`, ...
 */
export function usernameCandidates(name: string): string[] {
  const { first, surname } = splitName(name);

  if (!first) {
    return [];
  }

  const alt = surname ? `${first[0]}.${surname}` : first[0];
  const candidates = [first];
  const altUsername = alt;

  if (!candidates.includes(altUsername)) {
    candidates.push(altUsername);
  }

  for (let n = 2; n <= 9; n += 1) {
    candidates.push(`${alt}${n}`);
  }

  return candidates;
}
