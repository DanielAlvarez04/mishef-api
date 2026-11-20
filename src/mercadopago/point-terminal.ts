/** Reglas de compatibilidad de las terminales Point con el POS. */

export const POINT_TERMINAL_MODELS = ['SMART_1', 'SMART_2', 'AIR_2'] as const;

export type PointTerminalModel = (typeof POINT_TERMINAL_MODELS)[number];

/**
 * Solo Point Smart 2 captura propina desde su pantalla.
 *
 * `null` significa que el negocio todavía no indicó el modelo; la app debe
 * mostrar una advertencia en lugar de prometer la propina.
 */
export function supportsPointTips(
  model: string | null | undefined,
): boolean | null {
  if (model === 'SMART_2') return true;
  if (model === 'SMART_1' || model === 'AIR_2') return false;

  return null;
}

/**
 * Una terminal puede recibir orders del POS cuando está en PDV.
 *
 * Air 2 solo opera en autoservicio, aunque una configuración manual la deje
 * en PDV; se excluye para no ofrecer un cobro que no va a funcionar.
 */
export function isPointPdvTerminal(
  operatingMode: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return operatingMode === 'PDV' && model !== 'AIR_2';
}
