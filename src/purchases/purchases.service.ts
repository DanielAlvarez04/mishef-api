import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AiDocumentStatus,
  InventoryMovementType,
  Prisma,
  PurchaseStatus,
} from '@prisma/client';

import { QuantityConverter } from '../common/quantity-converter.service';
import { toCanonicalCost } from '../common/units';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  buildTicketObjectKey,
  IMAGE_CONTENT_TYPES,
  normalizeName,
  presignGetUrl,
  presignPutUrl,
  type ImageContentType,
} from '../uploads/r2';
import {
  CreateTicketDto,
  PresignTicketDto,
  RejectPurchaseDto,
  ReviewPurchaseDto,
} from './dto/purchases.dto';
import { duplicateOf, purchaseFingerprint } from './purchase-fingerprint';
import { TicketExtractionService } from './ticket-extraction.service';
import { TicketQueueService } from './ticket-queue.service';

interface PurchaseFilters {
  status?: PurchaseStatus;
  supplierId?: string;
  from?: string;
  to?: string;
  search?: string;
}

const CLOSED = new Set<PurchaseStatus>([
  PurchaseStatus.APPROVED,
  PurchaseStatus.REJECTED,
]);

function metaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly quantities: QuantityConverter,
    private readonly extraction: TicketExtractionService,
    private readonly queue: TicketQueueService,
  ) {}

  async presignTicket(organizationId: string, dto: PresignTicketDto) {
    const type = dto.contentType as ImageContentType;

    if (!IMAGE_CONTENT_TYPES[type]) {
      throw new BadRequestException('El ticket debe ser JPEG, PNG o WebP');
    }

    await this.storage.assertWithinLimit(organizationId, dto.size ?? 0);

    const key = buildTicketObjectKey(organizationId, type);

    return {
      key,
      contentType: type,
      uploadUrl: await presignPutUrl(key, type),
    };
  }

  async createTicket(
    organizationId: string,
    userId: string,
    branchId: string | null,
    dto: CreateTicketDto,
  ) {
    if (!dto.documentKey.startsWith(`${organizationId}/tickets/`)) {
      throw new BadRequestException('El ticket no pertenece a este negocio');
    }

    if (dto.supplierId) {
      await this.assertSupplier(organizationId, dto.supplierId);
    }

    const purchasedAt = dto.purchasedAt
      ? new Date(dto.purchasedAt)
      : new Date();

    if (Number.isNaN(purchasedAt.getTime())) {
      throw new BadRequestException('La fecha del ticket no es válida');
    }

    const purchase = await this.prisma.purchase.create({
      data: {
        organizationId,
        branchId,
        supplierId: dto.supplierId ?? null,
        purchasedAt,
        total:
          dto.total === undefined
            ? new Prisma.Decimal(0)
            : new Prisma.Decimal(dto.total),
        status: PurchaseStatus.PROCESSING,
        documentKey: dto.documentKey,
        documentMime: dto.documentMime ?? 'image/jpeg',
        createdBy: userId,
      },
    });

    await this.prisma.aiDocument.create({
      data: {
        organizationId,
        purchaseId: purchase.id,
        r2Key: dto.documentKey,
        mimeType: dto.documentMime ?? 'image/jpeg',
        status: AiDocumentStatus.UPLOADED,
      },
    });

    await this.audit(organizationId, userId, 'PURCHASE_TICKET_CREATED', purchase.id, {
      documentKey: dto.documentKey,
    });

    const queued = await this.queue.enqueue(purchase.id, organizationId);

    if (!queued) {
      // Si pg-boss no está disponible, no dejamos el ticket colgado en
      // PROCESSING: la extracción de respaldo corre en este proceso.
      void this.extraction.extract(organizationId, purchase.id).catch((error) => {
        this.logger.warn(
          `Extracción de respaldo falló para ${purchase.id}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
      });
    }

    return this.get(organizationId, purchase.id);
  }

  async list(
    organizationId: string,
    branchId: string | null,
    filters: PurchaseFilters,
  ) {
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;
    const search = filters.search?.trim();

    if (to) to.setHours(23, 59, 59, 999);

    return this.prisma.purchase.findMany({
      where: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(from || to
          ? {
              purchasedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { folio: { contains: search, mode: 'insensitive' } },
                {
                  supplier: {
                    name: { contains: search, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ purchasedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });
  }

  /**
   * Métricas de auto-mapeo y estado de compras.
   *
   * Sirve para vigilar la calidad de la extracción sin abrir ticket por ticket:
   * cuántas líneas se mapearon por alias exacto, por similitud o quedaron para
   * revisión humana.
   */
  async metrics(organizationId: string, branchId: string | null) {
    const scope = {
      organizationId,
      ...(branchId ? { branchId } : {}),
    };

    const [byStatus, byMappingSource, approved] = await Promise.all([
      this.prisma.purchase.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
      this.prisma.purchaseItem.groupBy({
        by: ['mappingSource'],
        where: { purchase: scope },
        _count: { _all: true },
      }),
      this.prisma.purchase.aggregate({
        where: { ...scope, status: PurchaseStatus.APPROVED },
        _count: { _all: true },
        _sum: { total: true },
      }),
    ]);

    return {
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all]),
      ),
      byMappingSource: Object.fromEntries(
        byMappingSource.map((row) => [
          row.mappingSource ?? 'UNKNOWN',
          row._count._all,
        ]),
      ),
      approved: {
        count: approved._count._all,
        total: approved._sum.total ?? 0,
      },
    };
  }

  async get(organizationId: string, id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, organizationId },
      include: {
        supplier: true,
        branch: { select: { id: true, name: true } },
        items: { orderBy: { rawDescription: 'asc' } },
      },
    });

    if (!purchase) {
      throw new NotFoundException('Compra no encontrada');
    }

    return {
      ...purchase,
      documentUrl: purchase.documentKey
        ? await presignGetUrl(purchase.documentKey)
        : null,
    };
  }

  async updateDraft(
    organizationId: string,
    userId: string,
    id: string,
    dto: ReviewPurchaseDto,
  ) {
    const current = await this.get(organizationId, id);

    if (CLOSED.has(current.status)) {
      throw new ConflictException('La compra ya está cerrada');
    }

    if (dto.supplierId) {
      await this.assertSupplier(organizationId, dto.supplierId);
    }

    if (dto.items && dto.items.length > 0) {
      const ingredientIds = [
        ...new Set(
          dto.items
            .map((item) => item.ingredientId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];

      if (ingredientIds.length > 0) {
        const found = await this.prisma.ingredient.count({
          where: { id: { in: ingredientIds }, organizationId },
        });

        if (found !== ingredientIds.length) {
          throw new BadRequestException('Hay ingredientes que no pertenecen al negocio');
        }
      }
    }

    const data: Prisma.PurchaseUpdateInput = {};

    if (dto.supplierId !== undefined) {
      const supplierId = dto.supplierId || null;
      if (supplierId !== current.supplierId) {
        data.supplier = supplierId
          ? { connect: { id: supplierId } }
          : { disconnect: true };
      }
    }

    if (dto.folio !== undefined) {
      const folio = dto.folio?.trim() || null;
      if (folio !== current.folio) data.folio = folio;
    }

    if (dto.purchasedAt !== undefined) {
      const purchasedAt = new Date(dto.purchasedAt);
      if (Number.isNaN(purchasedAt.getTime())) {
        throw new BadRequestException('La fecha del ticket no es válida');
      }
      if (purchasedAt.getTime() !== current.purchasedAt.getTime()) {
        data.purchasedAt = purchasedAt;
      }
    }

    if (dto.total !== undefined) {
      const total = new Prisma.Decimal(dto.total);
      if (!total.equals(current.total)) data.total = total;
    }

    if (dto.notes !== undefined) {
      const notes = dto.notes?.trim() || null;
      if (notes !== current.notes) data.notes = notes;
    }

    const hasItems = Boolean(dto.items && dto.items.length > 0);
    const hasData = Object.keys(data).length > 0;

    if (!hasData && !hasItems) {
      return current;
    }

    await this.prisma.$transaction(async (tx) => {
      if (hasData) {
        await tx.purchase.update({
          where: { id: current.id },
          data: {
            ...data,
            status: PurchaseStatus.NEEDS_REVIEW,
          },
        });
      }

      if (hasItems) {
        await tx.purchaseItem.deleteMany({ where: { purchaseId: current.id } });

        for (const item of dto.items ?? []) {
          await tx.purchaseItem.create({
            data: {
              purchaseId: current.id,
              rawDescription: item.rawDescription.trim(),
              ingredientId: item.ingredientId ?? null,
              quantity: new Prisma.Decimal(item.quantity),
              unit: item.unit,
              unitCostGross: new Prisma.Decimal(item.unitCostGross),
              lineTotalGross: new Prisma.Decimal(item.lineTotalGross),
              confidence:
                item.confidence === undefined
                  ? null
                  : new Prisma.Decimal(item.confidence),
              mappingSource: item.mappingSource ?? 'MANUAL',
              taxRate:
                item.taxRate === undefined
                  ? null
                  : new Prisma.Decimal(item.taxRate),
              taxAmount:
                item.taxAmount === undefined
                  ? null
                  : new Prisma.Decimal(item.taxAmount),
            },
          });
        }

        if (!hasData) {
          await tx.purchase.update({
            where: { id: current.id },
            data: { status: PurchaseStatus.NEEDS_REVIEW },
          });
        }
      }

      await this.syncDuplicateState(tx, organizationId, {
        id: current.id,
        supplierId:
          dto.supplierId !== undefined
            ? dto.supplierId || null
            : current.supplierId,
        folio: dto.folio !== undefined ? dto.folio?.trim() || null : current.folio,
        extractedJson: current.extractedJson,
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'PURCHASE_REVIEWED',
          entity: 'Purchase',
          entityId: current.id,
          newValues: {
            ...(dto.items ? { items: dto.items.length } : {}),
            ...(dto.total !== undefined ? { total: dto.total } : {}),
          },
        },
      });
    });

    return this.get(organizationId, current.id);
  }

  async extract(organizationId: string, userId: string, id: string) {
    const purchase = await this.get(organizationId, id);

    if (CLOSED.has(purchase.status)) {
      throw new ConflictException('La compra ya está cerrada');
    }

    const result = await this.extraction.extract(organizationId, id);

    await this.audit(organizationId, userId, 'PURCHASE_EXTRACTED', id, {
      items: result.items.length,
      status: result.status,
    });

    return result;
  }

  async approve(organizationId: string, userId: string, id: string) {
    const purchase = await this.get(organizationId, id);

    if (purchase.status === PurchaseStatus.APPROVED) {
      return purchase;
    }

    if (purchase.status !== PurchaseStatus.NEEDS_REVIEW) {
      throw new ConflictException('El ticket aún no está listo para aprobar');
    }

    if (purchase.items.length === 0) {
      throw new BadRequestException('El ticket no tiene líneas');
    }

    if (duplicateOf(purchase)) {
      throw new ConflictException(
        'Este ticket está marcado como duplicado de otra compra. Corrige el folio o el proveedor, o recházalo.',
      );
    }

    const linesTotal = purchase.items.reduce(
      (sum, item) => sum.plus(item.lineTotalGross),
      new Prisma.Decimal(0),
    );

    if (purchase.total.lessThanOrEqualTo(0)) {
      throw new BadRequestException('El total del ticket debe ser mayor a cero');
    }

    if (linesTotal.minus(purchase.total).abs().greaterThan(0.5)) {
      throw new BadRequestException(
        `La suma de las líneas ($${linesTotal.toFixed(2)}) no coincide con el total del ticket ($${purchase.total.toFixed(2)}). Ajusta las líneas o el total antes de aprobar.`,
      );
    }

    const prepared: Array<{
      item: (typeof purchase.items)[number];
      ingredient: {
        id: string;
        name: string;
        baseUnit: string;
        displayUnit: string;
      };
      quantityBase: Prisma.Decimal;
      unitCostBase: Prisma.Decimal;
    }> = [];

    for (const item of purchase.items) {
      if (!item.ingredientId) {
        throw new BadRequestException(
          `Mapea el ingrediente de la línea "${item.rawDescription}" antes de aprobar`,
        );
      }

      const ingredient = await this.prisma.ingredient.findFirst({
        where: {
          id: item.ingredientId,
          organizationId,
          isActive: true,
        },
      });

      if (!ingredient) {
        throw new BadRequestException(
          `El ingrediente de "${item.rawDescription}" no está activo`,
        );
      }

      const quantityBase = await this.quantities.toBaseUnit(
        ingredient,
        item.quantity,
        item.unit,
      );

      prepared.push({
        item,
        ingredient,
        quantityBase,
        unitCostBase: toCanonicalCost(item.unitCostGross, item.unit),
      });
    }

    await this.prisma.$transaction(async (tx) => {
      for (const row of prepared) {
        const cost = row.unitCostBase.greaterThan(0)
          ? { unitCost: row.unitCostBase }
          : {};
        let stockAfter: Prisma.Decimal;

        if (purchase.branchId) {
          const branchStock = await tx.branchStock.upsert({
            where: {
              branchId_ingredientId: {
                branchId: purchase.branchId,
                ingredientId: row.ingredient.id,
              },
            },
            create: {
              branchId: purchase.branchId,
              ingredientId: row.ingredient.id,
              quantity: row.quantityBase,
            },
            update: { quantity: { increment: row.quantityBase } },
          });

          stockAfter = branchStock.quantity;

          await tx.ingredient.update({
            where: { id: row.ingredient.id },
            data: {
              currentStock: { increment: row.quantityBase },
              ...cost,
            },
          });
        } else {
          const updated = await tx.ingredient.update({
            where: { id: row.ingredient.id },
            data: {
              currentStock: { increment: row.quantityBase },
              ...cost,
            },
          });

          stockAfter = updated.currentStock;
        }

        await tx.inventoryMovement.create({
          data: {
            organizationId,
            branchId: purchase.branchId,
            ingredientId: row.ingredient.id,
            ingredientName: row.ingredient.name,
            displayUnit: row.ingredient.displayUnit as never,
            userId,
            type: InventoryMovementType.PURCHASE,
            quantity: row.quantityBase,
            stockAfter,
            unitCost: row.unitCostBase,
            reason: `Compra ${purchase.folio ?? purchase.id}`,
            referenceId: purchase.id,
            referenceType: 'PURCHASE',
            dedupeKey: `${purchase.id}:${row.item.id}`,
          },
        });
      }

      if (purchase.supplierId) {
        for (const row of prepared) {
          if (row.item.mappingSource !== 'AI') continue;

          const normalizedName = normalizeName(row.item.rawDescription);

          if (!normalizedName) continue;

          await tx.supplierProduct.upsert({
            where: {
              supplierId_normalizedName: {
                supplierId: purchase.supplierId,
                normalizedName,
              },
            },
            create: {
              supplierId: purchase.supplierId,
              rawName: row.item.rawDescription,
              normalizedName,
              ingredientId: row.ingredient.id,
              quantity: row.item.quantity,
              unit: row.item.unit,
              lastUnitCostGross: row.item.unitCostGross,
              timesSeen: 1,
              lastSeenAt: new Date(),
            },
            update: {
              ingredientId: row.ingredient.id,
              lastUnitCostGross: row.item.unitCostGross,
              timesSeen: { increment: 1 },
              lastSeenAt: new Date(),
            },
          });
        }
      }

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: PurchaseStatus.APPROVED,
          approvedBy: userId,
          approvedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'PURCHASE_APPROVED',
          entity: 'Purchase',
          entityId: purchase.id,
          newValues: {
            items: prepared.length,
            total: Number(purchase.total),
          },
        },
      });
    });

    return this.get(organizationId, purchase.id);
  }

  async reject(
    organizationId: string,
    userId: string,
    id: string,
    dto: RejectPurchaseDto,
  ) {
    const purchase = await this.get(organizationId, id);

    if (purchase.status === PurchaseStatus.APPROVED) {
      throw new ConflictException('Una compra aprobada no se puede rechazar');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: PurchaseStatus.REJECTED,
          notes: dto.reason?.trim() || purchase.notes,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'PURCHASE_REJECTED',
          entity: 'Purchase',
          entityId: purchase.id,
          newValues: { reason: dto.reason ?? null },
        },
      });
    });

    return this.get(organizationId, purchase.id);
  }

  private async assertSupplier(organizationId: string, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, organizationId, isActive: true },
      select: { id: true },
    });

    if (!supplier) {
      throw new NotFoundException('Proveedor no encontrado');
    }
  }

  /**
   * Recalcula la huella del ticket y marca si ya existe otra compra con el
   * mismo proveedor y folio. Solo la primera conserva `dedupeKey` (columna
   * única); las siguientes quedan con `duplicateOf` para que la revisión lo
   * muestre y la aprobación lo bloquee.
   */
  private async syncDuplicateState(
    tx: Prisma.TransactionClient,
    organizationId: string,
    purchase: {
      id: string;
      supplierId: string | null;
      folio: string | null;
      extractedJson: unknown;
    },
  ) {
    const fingerprint = purchaseFingerprint(purchase);

    const existing = fingerprint
      ? await tx.purchase.findFirst({
          where: {
            organizationId,
            dedupeKey: fingerprint,
            id: { not: purchase.id },
          },
          select: { id: true },
        })
      : null;

    const meta = metaObject(purchase.extractedJson);

    if (existing) {
      meta.duplicateOf = existing.id;
    } else {
      delete meta.duplicateOf;
    }

    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        dedupeKey: existing ? null : fingerprint,
        extractedJson: meta as Prisma.InputJsonValue,
      },
    });
  }

  private async audit(
    organizationId: string,
    userId: string,
    action: string,
    entityId: string,
    newValues: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action,
        entity: 'Purchase',
        entityId,
        newValues,
      },
    });
  }
}
