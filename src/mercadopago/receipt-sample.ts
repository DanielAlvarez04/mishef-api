import { formatTicketUid } from '../tickets/ticket-code';
import type { PointReceiptInput } from './point-receipt';

/**
 * Orden de ejemplo para la vista previa y la prueba de impresión del editor.
 *
 * Representa un ticket en efectivo sin propina capturada: así se ve el bloque
 * de «Propina sugerida» y el folio de reclamos.
 */
export function sampleReceiptInput(business: {
  organizationName: string;
  organizationAddress: string | null;
  rfc: string | null;
  branchName: string | null;
  branchAddress: string | null;
  currency: string;
}): PointReceiptInput {
  const issuedAt = new Date();

  return {
    organizationName: business.organizationName,
    organizationAddress: business.organizationAddress,
    organizationRfc: business.rfc,
    branchName: business.branchName,
    branchAddress: business.branchAddress,
    currency: business.currency,
    order: {
      ticketNumber: 1,
      ticketUid: formatTicketUid(issuedAt, 1),
      tableNumber: '4',
      partySize: 2,
      isTakeaway: false,
      channel: 'DINE_IN',
      customerName: 'Cliente de ejemplo',
      issuedAt,
      subtotal: '172.41',
      taxTotal: '27.59',
      discountTotal: '0.00',
      deliveryFee: '0.00',
      total: '200.00',
      items: [
        {
          name: 'Tacos al pastor',
          variant: 'Orden',
          quantity: 2,
          subtotal: '120.00',
        },
        {
          name: 'Agua fresca',
          variant: 'Jamaica',
          quantity: 1,
          subtotal: '35.00',
        },
        {
          name: 'Flan napolitano',
          variant: null,
          quantity: 1,
          subtotal: '45.00',
        },
      ],
      payments: [
        {
          method: 'CASH',
          amount: '200.00',
          tipAmount: '0.00',
        },
      ],
    },
  };
}
