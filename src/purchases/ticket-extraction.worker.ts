import { Injectable, Logger } from '@nestjs/common';
import { PurchaseStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TicketExtractionService } from './ticket-extraction.service';

/**
 * Procesa un ticket encolado.
 *
 * Reglas:
 * - Solo se reprocesan tickets en `PROCESSING` o `FAILED`; una compra ya
 *   revisada, aprobada o rechazada no se toca (podría sobrescribir ediciones
 *   humanas).
 * - Si la extracción falla, el error se propaga para que pg-boss reintente
 *   (2 reintentos con backoff). Al agotarse, el ticket queda en `FAILED`.
 */
@Injectable()
export class TicketExtractionWorker {
  private readonly logger = new Logger(TicketExtractionWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly extraction: TicketExtractionService,
  ) {}

  async process(organizationId: string, purchaseId: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id: purchaseId, organizationId },
      select: { status: true },
    });

    if (!purchase) {
      this.logger.warn(`Ticket ${purchaseId} no encontrado`);
      return;
    }

    if (
      purchase.status !== PurchaseStatus.PROCESSING &&
      purchase.status !== PurchaseStatus.FAILED
    ) {
      this.logger.log(
        `Ticket ${purchaseId} ya está en ${purchase.status}; no se reprocesa`,
      );
      return;
    }

    const result = await this.extraction.extract(organizationId, purchaseId);

    await this.prisma.auditLog
      .create({
        data: {
          organizationId,
          userId: null,
          action: 'PURCHASE_EXTRACTED',
          entity: 'Purchase',
          entityId: purchaseId,
          newValues: {
            source: 'WORKER',
            items: result.items.length,
            status: result.status,
          },
        },
      })
      .catch((error) => {
        this.logger.warn(
          `No se pudo auditar la extracción ${purchaseId}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
      });
  }
}
