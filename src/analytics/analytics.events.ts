/**
 * Catálogo central de eventos de analítica.
 *
 * Se mantiene como constantes (y no como enum de Prisma) para poder añadir
 * eventos nuevos sin una migración: el análisis histórico solo necesita el
 * nombre y las dimensiones que ya guarda `AnalyticsEvent`.
 */
export const ANALYTICS_EVENTS = {
  /** Se envió una ronda a cocina. */
  orderRoundSent: 'order.round_sent',
  /** Se vendió una línea de artículo (cantidad e importe). */
  itemSold: 'item.sold',
  /** Se eligió un grupo de opciones en una línea. */
  optionGroupSelected: 'option_group.selected',
  /** Se eligió un valor concreto de un grupo. */
  optionValueSelected: 'option_value.selected',
  /** POS: se añadió un artículo a la comanda (incluye posición en el menú). */
  itemAddedToCart: 'pos.item_added',
  /** POS: se filtró el catálogo por un menú. */
  menuFiltered: 'pos.menu_filtered',
  /** POS: se abrió un grupo de opciones al configurar un artículo. */
  optionGroupOpened: 'pos.option_group_opened',
  /** POS: terminó una captura de pedido (enviada, abandonada o cambiada). */
  posOrderCaptureFinished: 'pos.order_capture_finished',
  /** POS: se abrió la card de un artículo para configurarlo. */
  posItemOpened: 'pos.item_opened',
  /** POS: una búsqueda no devolvió resultados. */
  posSearchNoResults: 'pos.search_no_results',
  /** POS: se cerró el diálogo del platillo sin guardar. */
  posItemDialogCancelled: 'pos.item_dialog_cancelled',
  /** POS: validación fallida antes de guardar un platillo. */
  posValidationError: 'pos.validation_error',
} as const

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]

/**
 * Eventos que puede enviar el navegador. El resto solo se genera en el
 * servidor para que no se puedan falsificar ventas ni selecciones.
 */
export const CLIENT_ANALYTICS_EVENTS: readonly AnalyticsEventName[] = [
  ANALYTICS_EVENTS.itemAddedToCart,
  ANALYTICS_EVENTS.menuFiltered,
  ANALYTICS_EVENTS.optionGroupOpened,
  ANALYTICS_EVENTS.posOrderCaptureFinished,
  ANALYTICS_EVENTS.posItemOpened,
  ANALYTICS_EVENTS.posSearchNoResults,
  ANALYTICS_EVENTS.posItemDialogCancelled,
  ANALYTICS_EVENTS.posValidationError,
]

export function isClientAnalyticsEvent(
  name: string,
): name is AnalyticsEventName {
  return (CLIENT_ANALYTICS_EVENTS as readonly string[]).includes(name)
}
