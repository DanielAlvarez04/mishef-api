import { formatTicketUid } from '../tickets/ticket-code';
import type { PointReceiptInput } from './point-receipt';

export type ReceiptSampleScenario = 'table' | 'paid';

/**
 * Orden de ejemplo para la vista previa y la prueba de impresión del editor.
 *
 * - `table`: cuenta de mesa antes de cobrar, con propina sugerida.
 * - `paid`: ticket de ventanilla ya pagado, con sección de pagos y propina
 *   cobrada en los totales.
 */
export function sampleReceiptInput(
  business: {
    organizationName: string;
    organizationAddress: string | null;
    rfc: string | null;
    branchName: string | null;
    branchAddress: string | null;
    currency: string;
  },
  scenario: ReceiptSampleScenario = 'table',
): PointReceiptInput {
  const issuedAt = new Date();
  const paid = scenario === 'paid';

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
      tableNumber: paid ? null : '4',
      partySize: paid ? 1 : 2,
      isTakeaway: paid,
      channel: paid ? 'COUNTER' : 'DINE_IN',
      customerName: paid ? 'Cliente de mostrador' : 'Cliente de ejemplo',
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
      payments: paid
        ? [
            {
              method: 'CARD',
              amount: '200.00',
              tipAmount: '20.00',
            },
          ]
        : [],
    },
  };
}
