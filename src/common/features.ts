/**
 * Catálogo de funciones visibles/contratables por organización.
 *
 * Todos los negocios empiezan con los mismos defaults. Las excepciones se
 * guardan por organización en `Organization.featureOverrides`.
 *
 * Los defaults de páginas que ya existen en producción son `true`; las
 * funciones que todavía no se promueven a `master` quedan en `false` hasta
 * que su código y sus endpoints estén disponibles.
 */
export type FeatureGroup = "service" | "application" | "settings";

export interface FeatureDefinition {
  key: string;
  label: string;
  description?: string;
  group: FeatureGroup;
  /** Ruta de la página principal; se usa para bloquear accesos directos. */
  path?: string;
  default: boolean;
}

export const FEATURE_CATALOG: FeatureDefinition[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    group: "service",
    path: "/dashboard",
    default: true,
  },
  {
    key: "menus",
    label: "Menús",
    group: "service",
    path: "/menus",
    default: true,
  },
  {
    key: "pos",
    label: "Punto de venta",
    group: "service",
    path: "/pos",
    default: true,
  },
  {
    key: "pos.payments",
    label: "Cobros del POS",
    description: "Botón para cobrar cuentas y registrar pagos.",
    group: "service",
    default: true,
  },
  {
    key: "kitchen",
    label: "Cocina",
    group: "service",
    path: "/kitchen",
    default: true,
  },
  {
    key: "catalog",
    label: "Catálogo",
    group: "application",
    path: "/catalog",
    default: true,
  },
  {
    key: "catalog.ai",
    label: "Catálogo IA",
    group: "application",
    path: "/catalog/ai",
    default: false,
  },
  {
    key: "inventory",
    label: "Inventario",
    group: "application",
    path: "/inventory",
    default: true,
  },
  {
    key: "reports",
    label: "Reportes",
    group: "application",
    path: "/reports",
    default: true,
  },
  {
    key: "reports.food-cost",
    label: "Food cost",
    group: "application",
    path: "/reports/food-cost",
    default: true,
  },
  {
    key: "reports.leakage",
    label: "Fuga interna",
    group: "application",
    path: "/reports/leakage",
    default: true,
  },
  {
    key: "reports.benchmark",
    label: "Benchmark",
    group: "application",
    path: "/reports/benchmark",
    default: true,
  },
  {
    key: "attendance",
    label: "Asistencia",
    group: "application",
    path: "/attendance",
    default: true,
  },
  {
    key: "waste",
    label: "Merma",
    group: "application",
    path: "/waste",
    default: true,
  },
  {
    key: "purchases",
    label: "Compras",
    group: "application",
    path: "/purchases",
    default: false,
  },
  {
    key: "purchases.suggestions",
    label: "Sugerencias de compra",
    group: "application",
    path: "/purchases/suggestions",
    default: false,
  },
  {
    key: "suppliers",
    label: "Proveedores",
    group: "application",
    path: "/suppliers",
    default: false,
  },
  {
    key: "intel",
    label: "Intel",
    group: "application",
    path: "/intel",
    default: false,
  },
  {
    key: "intel.notifications",
    label: "Bandeja Intel",
    group: "application",
    path: "/intel/notifications",
    default: false,
  },
  {
    key: "intel.anomalies",
    label: "Anomalías Intel",
    group: "application",
    path: "/intel/anomalies",
    default: false,
  },
  {
    key: "settings",
    label: "Configuración",
    group: "settings",
    path: "/settings",
    default: true,
  },
  {
    key: "users",
    label: "Usuarios",
    group: "settings",
    path: "/users",
    default: true,
  },
];

export const DEFAULT_FEATURES: Record<string, boolean> = Object.fromEntries(
  FEATURE_CATALOG.map((feature) => [feature.key, feature.default]),
);

export const FEATURE_KEYS = new Set(FEATURE_CATALOG.map((feature) => feature.key));

/** Si el padre está apagado, la función hija también. */
export const FEATURE_PARENTS: Record<string, string> = {
  'pos.payments': 'pos',
  'catalog.ai': 'catalog',
  'reports.food-cost': 'reports',
  'reports.leakage': 'reports',
  'reports.benchmark': 'reports',
  'purchases.suggestions': 'purchases',
  'intel.notifications': 'intel',
  'intel.anomalies': 'intel',
};

export function isFeatureEnabled(
  features: Record<string, boolean>,
  key: string,
): boolean {
  if (features[key] === false) return false;

  const parent = FEATURE_PARENTS[key];
  return parent ? isFeatureEnabled(features, parent) : true;
}

/** Ruta pública → función, eligiendo el prefijo más específico. */
export function featureForPath(path: string): string | null {
  const normalized = path.split("?")[0].replace(/\/+$/, "") || "/";
  const match = [...FEATURE_CATALOG]
    .filter((feature) => feature.path)
    .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
    .find(
      (feature) =>
        normalized === feature.path ||
        normalized.startsWith(`${feature.path}/`),
    );

  return match?.key ?? null;
}

/**
 * Rutas de la API que pertenecen a una sola función.
 *
 * No se incluyen `/catalog`, `/inventory`, `/cash`, `/orders`, `/analytics` ni
 * `/branches`: los comparten POS, cocina, reportes y configuración, y apagarlos
 * desde la matriz rompería esas pantallas. Esas funciones se ocultan en la UI y
 * sus acciones siguen protegidas por roles/permisos. Los cobros del POS se
 * declaran aparte con `@RequireFeature('pos.payments')` porque viven en
 * `/orders/:id/payments`.
 */
const API_FEATURE_PATHS: Array<[string, string]> = [
  ["/reports/benchmark", "reports.benchmark"],
  ["/reports/leakage", "reports.leakage"],
  ["/reports/food-cost", "reports.food-cost"],
  ["/reports", "reports"],
  ["/purchases", "purchases"],
  ["/suppliers", "suppliers"],
  ["/intel", "intel"],
  ["/attendance", "attendance"],
  ["/waste", "waste"],
  ["/kitchen", "kitchen"],
  ["/users", "users"],
  ["/dashboard", "dashboard"],
];

/** Ruta de la API (sin `/v1`) → función que la protege. */
export function featureForApiPath(path: string): string | null {
  const normalized = path.split("?")[0].replace(/\/+$/, "") || "/";

  return (
    API_FEATURE_PATHS.find(
      ([prefix]) =>
        normalized === prefix || normalized.startsWith(`${prefix}/`),
    )?.[1] ?? null
  );
}

/** Normaliza los overrides guardados, descartando claves/valores inválidos. */
export function normalizeFeatureOverrides(
  input: unknown,
): Record<string, boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const result: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(
    input as Record<string, unknown>,
  )) {
    if (FEATURE_KEYS.has(key) && typeof value === "boolean") {
      result[key] = value;
    }
  }

  return result;
}
