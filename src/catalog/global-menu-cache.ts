/**
 * Control de frescura del «Menú global».
 *
 * El menú global es una vista derivada del catálogo: se recalcula leyendo todos
 * los artículos y comparando todos sus `MenuItem`. Hacerlo en cada `GET /menus`
 * (que el POS pide en cada carga) es trabajo repetido sin cambios reales.
 *
 * Esta marca vive en memoria del proceso: es suficiente porque la API corre en
 * un único contenedor. Si algún día hay varias réplicas, el TTL sigue siendo
 * correcto (cada réplica resincroniza como mucho cada `TTL_MS`).
 */
const TTL_MS = 15_000;

const syncedAt = new Map<string, number>();

export function globalMenuIsFresh(organizationId: string): boolean {
  const last = syncedAt.get(organizationId);

  return last !== undefined && Date.now() - last < TTL_MS;
}

export function markGlobalMenuSynced(organizationId: string): void {
  syncedAt.set(organizationId, Date.now());
}

/**
 * Fuerza la resincronización en la próxima lectura. Se llama desde las
 * mutaciones del catálogo, que son las que cambian el contenido del menú.
 */
export function invalidateGlobalMenu(organizationId: string | null): void {
  if (organizationId) syncedAt.delete(organizationId);
}
