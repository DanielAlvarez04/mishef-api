/** Origen normalizado (`https://app.mishef.co`) o `null` si no es válido. */
export function normalizeOrigin(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * `true` si el origen pertenece al dominio de los negocios.
 *
 * Solo acepta HTTPS: los subdominios de producción no se sirven por HTTP.
 * Incluye el dominio base (`https://mishef.co`) y cualquier subdominio.
 */
export function isTenantOrigin(
  origin: string,
  tenantDomain: string,
): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  const domain = tenantDomain.trim().toLowerCase().replace(/^\./, '');
  if (!domain) return false;

  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();

    return (
      url.protocol === 'https:' &&
      (host === domain || host.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

/**
 * Orígenes permitidos para el panel: el origen principal, el de la API y los
 * subdominios de los negocios (`demo.mishef.co`, etc.).
 */
export function isAllowedWebOrigin(
  origin: string,
  webOrigin: string | null | undefined,
  apiOrigin: string | null | undefined,
  tenantDomain: string,
): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  return (
    normalized === normalizeOrigin(webOrigin) ||
    normalized === normalizeOrigin(apiOrigin) ||
    isTenantOrigin(normalized, tenantDomain)
  );
}
