/**
 * Redacción mínima para logs.
 *
 * No se aplica al contenido persistido (`AiMessage`), que es el historial real
 * de la conversación; solo evita que correos y teléfonos terminen en logs o en
 * mensajes de error del proveedor.
 */
export function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:\+?52[\s-]?)?(?:\d[\s-]?){10}\b/g, '[phone]');
}
