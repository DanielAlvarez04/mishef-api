import { Role } from '@prisma/client';

/**
 * Matriz de permisos (plan.md §5).
 *
 * Celdas ambiguas del plan ("Según permiso") resueltas de forma conservadora:
 * - `payments:register`: el mesero puede registrar pagos, pero no confirmarlos.
 * - `payments:confirm`: solo ADMIN y CASHIER (implica responsabilidad sobre el dinero).
 * - `payments:refund`: solo ADMIN. Las reglas de anulación/devolución requieren
 *   aprobación explícita antes de implementarse (plan.md §5 y §6.8).
 * - `reports:read`: ADMIN y CASHIER (reportes de ventas).
 * - `reports:read:operations`: ADMIN, WAITER, KITCHEN e INVENTORY_MANAGER
 *   (solo métricas operativas: pedidos, tiempos, stock).
 */
export const PERMISSIONS = {
  'users:manage': ['ADMIN'],
  'organization:manage': ['ADMIN'],
  'catalog:manage': ['ADMIN', 'INVENTORY_MANAGER'],
  'orders:draft': ['ADMIN', 'WAITER', 'CASHIER'],
  'orders:send': ['ADMIN', 'WAITER'],
  'kitchen:transition': ['ADMIN', 'KITCHEN'],
  'payments:register': ['ADMIN', 'CASHIER', 'WAITER'],
  'payments:confirm': ['ADMIN', 'CASHIER'],
  'payments:refund': ['ADMIN'],
  'cash:read': ['ADMIN', 'CASHIER', 'WAITER'],
  'cash:manage': ['ADMIN', 'CASHIER'],
  'inventory:manage': ['ADMIN', 'INVENTORY_MANAGER'],
  'inventory:adjust': ['ADMIN', 'INVENTORY_MANAGER'],
  'reports:read': ['ADMIN', 'CASHIER'],
  'reports:read:operations': [
    'ADMIN',
    'WAITER',
    'KITCHEN',
    'INVENTORY_MANAGER',
  ],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function rolesHavePermission(
  roles: readonly Role[],
  permission: Permission,
): boolean {
  const allowed = PERMISSIONS[permission] as readonly Role[];
  return roles.some((role) => allowed.includes(role));
}

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) =>
    rolesHavePermission(roles, permission),
  );
}
