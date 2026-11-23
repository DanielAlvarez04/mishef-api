/**
 * Colores disponibles para las secciones (grupos) de un menú.
 *
 * El orden importa: primero se reparten todos los tonos 300, después los 500 y
 * al final los 700. Así los grupos nuevos reciben un color distinto sin que el
 * usuario tenga que elegirlo.
 */
export const GROUP_COLOR_SHADES = [300, 500, 700] as const;

export const GROUP_COLOR_NAMES = [
  'sky',
  'indigo',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'lime',
  'green',
  'teal',
] as const;

export const GROUP_COLOR_SEQUENCE = GROUP_COLOR_SHADES.flatMap((shade) =>
  GROUP_COLOR_NAMES.map((name) => `${name}-${shade}`),
);

const GROUP_COLOR_SET = new Set(GROUP_COLOR_SEQUENCE);

export function isGroupColor(value: unknown): value is string {
  return typeof value === 'string' && GROUP_COLOR_SET.has(value);
}

/**
 * Asigna un color único a cada grupo.
 *
 * Conserva los colores válidos que ya tenía el menú (por nombre de grupo) y
 * completa los grupos nuevos con el siguiente color libre de la secuencia. Si
 * se repite un color, solo se conserva en el primer grupo.
 */
export function normalizeGroupColors(
  groups: string[],
  input: unknown,
): Record<string, string> {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const result: Record<string, string> = {};
  const used = new Set<string>();

  for (const group of groups) {
    const value = source[group];

    if (isGroupColor(value) && !used.has(value)) {
      result[group] = value;
      used.add(value);
    }
  }

  let cursor = 0;

  for (const group of groups) {
    if (result[group]) continue;

    while (cursor < GROUP_COLOR_SEQUENCE.length) {
      const candidate = GROUP_COLOR_SEQUENCE[cursor];
      cursor += 1;

      if (used.has(candidate)) continue;

      result[group] = candidate;
      used.add(candidate);
      break;
    }
  }

  return result;
}
