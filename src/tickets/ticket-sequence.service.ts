import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { formatTicketUid, ticketDayKey } from './ticket-code';

type TransactionClient = Prisma.TransactionClient;

export interface TicketSequenceValue {
  number: number;
  uid: string;
}

/**
 * Consecutivo diario de tickets.
 *
 * El `INSERT ... ON CONFLICT` es atómico en PostgreSQL, así que dos cajas
 * abriendo cuentas a la vez no repiten número. El contador se reinicia cada
 * día del negocio (America/Mexico_City), no cada día UTC.
 */
@Injectable()
export class TicketSequenceService {
  constructor(private readonly prisma: PrismaService) {}

  async next(
    branchId: string,
    date: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<TicketSequenceValue> {
    const client = tx ?? this.prisma;
    const day = ticketDayKey(date);
    const rows = await client.$queryRaw<Array<{ lastNumber: number }>>`
      INSERT INTO "BranchDailySequence" ("id", "branchId", "date", "lastNumber")
      VALUES (gen_random_uuid()::text, ${branchId}, ${day}::date, 1)
      ON CONFLICT ("branchId", "date")
      DO UPDATE SET "lastNumber" = "BranchDailySequence"."lastNumber" + 1
      RETURNING "lastNumber"
    `;
    const number = rows[0]?.lastNumber ?? 1;

    return { number, uid: formatTicketUid(date, number) };
  }

  /**
   * Asigna número y UID a una cuenta que todavía no los tiene.
   *
   * Devuelve `null` cuando la cuenta no existe o no tiene sucursal. Se usa al
   * imprimir para que las cuentas abiertas antes de este cambio también
   * obtengan su ticket.
   */
  async ensure(
    orderId: string,
    date: Date = new Date(),
  ): Promise<TicketSequenceValue | null> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { branchId: true, ticketNumber: true, ticketUid: true },
      });

      if (!order?.branchId) return null;

      if (order.ticketNumber && order.ticketUid) {
        return { number: order.ticketNumber, uid: order.ticketUid };
      }

      const value = order.ticketNumber
        ? {
            number: order.ticketNumber,
            uid: formatTicketUid(date, order.ticketNumber),
          }
        : await this.next(order.branchId, date, tx);

      await tx.order.update({
        where: { id: orderId },
        data: { ticketNumber: value.number, ticketUid: value.uid },
      });

      return value;
    });
  }
}
