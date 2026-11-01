import { Prisma } from '@prisma/client';

/**
 * Utilidades para actualizaciones parciales.
 *
 * Regla del proyecto: un `PATCH` solo escribe las columnas que realmente
 * cambiaron. Los servicios comparan el valor actual con el solicitado antes de
 * armar el `data` de Prisma; si no queda nada, no se ejecuta el `update` (así
 * tampoco se toca `updatedAt` ni se disparan efectos secundarios).
 */

/** Compara dos valores `Decimal` (o `null`) sin depender de su representación. */
export function sameDecimal(
  current: Prisma.Decimal | string | number | null | undefined,
  next: Prisma.Decimal | string | number | null | undefined,
): boolean {
  if (
    current === null ||
    current === undefined ||
    next === null ||
    next === undefined
  ) {
    return (current ?? null) === (next ?? null);
  }

  return new Prisma.Decimal(current).equals(new Prisma.Decimal(next));
}

/** Compara listas de texto como conjuntos (el orden no importa). */
export function sameStringSet(
  current: readonly string[],
  next: readonly string[],
): boolean {
  if (current.length !== next.length) return false;

  const left = [...current].sort();
  const right = [...next].sort();

  return left.every((value, index) => value === right[index]);
}

/** Compara arrays/objetos JSON simples (el orden sí importa). */
export function sameJson(current: unknown, next: unknown): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

/** `true` cuando el objeto no tiene ningún campo que escribir. */
export function isEmptyPatch(data: object): boolean {
  return Object.keys(data).length === 0;
}
