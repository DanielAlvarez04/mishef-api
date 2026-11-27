import { OrderRoundStatus } from '@prisma/client';

/**
 * Rondas que todavía no terminaron su ciclo de entrega.
 *
 * Una cuenta no puede cerrarse mientras alguna ronda esté en esta lista.
 * Solo `DELIVERED` y `CANCELLED` liberan la cuenta.
 */
export const ACTIVE_ROUND_STATUSES: OrderRoundStatus[] = [
  OrderRoundStatus.PENDING,
  OrderRoundStatus.HELD,
  OrderRoundStatus.PENDING_PAYMENT,
  OrderRoundStatus.FIRED,
  OrderRoundStatus.PREPARING,
  OrderRoundStatus.READY,
  OrderRoundStatus.PICKED_UP,
];
