/**
 * Monedas que puede configurar una organización.
 *
 * Se guardan como código ISO 4217 en `Organization.currency`. La lista es una
 * allowlist en código (no un enum de Prisma) para poder sumar monedas sin una
 * migración: basta agregarlas aquí y en la UI.
 */
export const SUPPORTED_CURRENCIES = ['MXN', 'USD'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** Moneda por defecto de las organizaciones existentes y de las nuevas. */
export const DEFAULT_CURRENCY: SupportedCurrency = 'MXN';

/** `true` si el valor es una moneda soportada. */
export function isSupportedCurrency(
  value: string | null | undefined,
): value is SupportedCurrency {
  return SUPPORTED_CURRENCIES.includes(value as SupportedCurrency);
}
