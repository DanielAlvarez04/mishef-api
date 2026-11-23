import { createHash } from 'node:crypto';

/**
 * Huella de un ticket para detectar la misma compra subida dos veces.
 *
 * Se basa en el proveedor y el folio impreso: dos fotos del mismo ticket
 * producen la misma huella. Si falta cualquiera de los dos datos no hay
 * huella (no se puede afirmar que sea duplicado).
 */
export function purchaseFingerprint(input: {
  supplierId: string | null | undefined;
  folio: string | null | undefined;
}): string | null {
  const supplierId = input.supplierId?.trim();
  const folio = input.folio?.trim().toLowerCase();

  if (!supplierId || !folio) return null;

  return createHash('sha256').update(`${supplierId}|${folio}`).digest('hex');
}

/** `true` si el JSON guardado marca la compra como duplicada de otra. */
export function duplicateOf(purchase: { extractedJson: unknown }): string | null {
  const meta = purchase.extractedJson;

  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;

  const value = (meta as Record<string, unknown>).duplicateOf;

  return typeof value === 'string' && value.length > 0 ? value : null;
}
