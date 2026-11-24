import type { PointReceiptInput } from './point-receipt';

/**
 * Orden de ejemplo para la vista previa y la prueba de impresión del editor.
 *
 * Los importes son consistentes con el modelo del POS: los precios de los
 * productos ya incluyen IVA y la propina se registra aparte.
 */
export function sampleReceiptInput(business: {
  organizationName: string;
  organizationAddress: string | null;
  branchName: string | null;
  branchAddress: string | null;
  currency: string;
}): PointReceiptInput {
  return {
    ...business,
    order: {
      ticketNumber: 123,
      tableNumber: '4',
      partySize: 2,
      isTakeaway: false,
      channel: 'DINE_IN',
      customerName: 'Cliente de ejemplo',
      issuedAt: new Date(),
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
          tipAmount: '30.00',
        },
      ],
    },
  };
}
