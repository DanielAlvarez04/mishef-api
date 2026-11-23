import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiDocumentStatus,
  Prisma,
  PurchaseStatus,
  UnitCode,
} from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';

import { readIntelSettings } from '../intel/intel.config';
import { OpenAiCompatibleClient } from '../intel/providers/openai-compatible.client';
import { PrismaService } from '../prisma/prisma.service';
import { getR2Object, normalizeName } from '../uploads/r2';
import { purchaseFingerprint } from './purchase-fingerprint';

/**
 * El modelo de visión suele devolver `null` en los campos que no encuentra.
 * `optional()` de zod solo acepta `undefined`, así que se normaliza antes de
 * validar para no perder un ticket completo por un RFC ausente.
 */
const optionalText = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value.trim() || undefined
      : value === null
        ? undefined
        : value,
  z.string().optional(),
);

const optionalNumber = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.coerce.number().nonnegative().optional(),
);

const optionalConfidence = z.preprocess(
  (value) => (value === null || value === '' ? undefined : value),
  z.coerce.number().min(0).max(1).optional(),
);

const lineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.coerce.number().positive(),
  unit: optionalText,
  unitPriceGross: optionalNumber,
  lineTotalGross: z.coerce.number().nonnegative(),
  confidence: optionalConfidence,
});

const receiptSchema = z.object({
  supplierName: optionalText,
  rfc: optionalText,
  folio: optionalText,
  purchasedAt: optionalText,
  currency: optionalText,
  lines: z.array(lineSchema).min(1),
  subtotal: optionalNumber,
  tax: optionalNumber,
  total: optionalNumber,
  confidence: optionalConfidence,
});

const UNIT_ALIASES: Record<string, UnitCode> = {
  pza: UnitCode.UNIT,
  pzas: UnitCode.UNIT,
  pieza: UnitCode.UNIT,
  piezas: UnitCode.UNIT,
  unidad: UnitCode.UNIT,
  unidades: UnitCode.UNIT,
  unit: UnitCode.UNIT,
  kg: UnitCode.KG,
  kilo: UnitCode.KG,
  kilos: UnitCode.KG,
  g: UnitCode.G,
  gr: UnitCode.G,
  gramo: UnitCode.G,
  gramos: UnitCode.G,
  l: UnitCode.L,
  lt: UnitCode.L,
  litro: UnitCode.L,
  litros: UnitCode.L,
  ml: UnitCode.ML,
  mililitro: UnitCode.ML,
  mililitros: UnitCode.ML,
};

function toUnitCode(value: string | undefined): UnitCode {
  return UNIT_ALIASES[(value ?? '').trim().toLowerCase()] ?? UnitCode.UNIT;
}

function stripJson(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');

  return start >= 0 && end > start
    ? content.slice(start, end + 1)
    : content.trim();
}

@Injectable()
export class TicketExtractionService {
  private readonly logger = new Logger(TicketExtractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: OpenAiCompatibleClient,
  ) {}

  async extract(organizationId: string, purchaseId: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id: purchaseId, organizationId },
      include: {
        supplier: true,
        items: true,
      },
    });

    if (!purchase) {
      throw new NotFoundException('Compra no encontrada');
    }

    if (
      purchase.status === PurchaseStatus.APPROVED ||
      purchase.status === PurchaseStatus.REJECTED
    ) {
      throw new ConflictException('La compra ya está cerrada');
    }

    const document = await this.prisma.aiDocument.findFirst({
      where: { organizationId, purchaseId },
      orderBy: { createdAt: 'desc' },
    });

    const key = purchase.documentKey ?? document?.r2Key;

    if (!key) {
      throw new BadRequestException('La compra no tiene un ticket adjunto');
    }

    const settings = readIntelSettings();
    const target = settings.targets[0];
    const visionModel =
      process.env.INTEL_VISION_MODEL?.trim() || target?.model || null;

    if (!target || !visionModel) {
      throw new ServiceUnavailableException(
        'Intel no tiene un modelo de visión configurado',
      );
    }

    try {
      const original = await getR2Object(key);

      if (!original) {
        throw new BadRequestException('No se pudo leer el ticket de R2');
      }

      const image = await sharp(original)
        .rotate()
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();

      const dataUri = `data:image/jpeg;base64,${image.toString('base64')}`;
      const visionRequest = {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: visionModel,
        imageDataUri: dataUri,
        prompt: [
          'Eres un extractor de tickets de compra mexicanos (Walmart, HEB, Soriana, proveedores locales).',
          'Devuelve SOLO un objeto JSON válido, sin Markdown ni explicaciones, con esta forma:',
          '{"supplierName":"...","rfc":"...","folio":"...","purchasedAt":"YYYY-MM-DD","lines":[{"description":"...","quantity":1,"unit":"UNIT|KG|G|L|ML","lineTotalGross":0}],"subtotal":0,"tax":0,"total":0,"confidence":0.9}',
          'Reglas: el precio del ticket ya incluye IVA, así que lineTotalGross es el total pagado de la línea.',
          'Si un dato no aparece, usa null u omítelo. No inventes líneas. Usa la unidad impresa (pza, kg, L, ml).',
          'La suma de las líneas debe acercarse al total; si no coincide, baja la confianza.',
        ].join(' '),
        maxTokens: 1600,
      };

      // Un fallo transitorio del proveedor no debe marcar el ticket como
      // ilegible: se reintenta una vez antes de rendirse.
      let completion: Awaited<
        ReturnType<OpenAiCompatibleClient['completeVision']>
      > | null = null;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          completion = await this.client.completeVision(visionRequest);
          break;
        } catch (error) {
          if (attempt === 2) throw error;

          this.logger.warn(
            `Visión falló (intento ${attempt}); se reintenta una vez.`,
          );

          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      if (!completion?.content) {
        throw new BadRequestException('El modelo no devolvió contenido');
      }

      const parsed = receiptSchema.parse(
        JSON.parse(stripJson(completion.content)),
      );

      const supplier = parsed.supplierName
        ? await this.prisma.supplier.findFirst({
            where: {
              organizationId,
              isActive: true,
              OR: [
                {
                  name: {
                    equals: parsed.supplierName,
                    mode: 'insensitive',
                  },
                },
                ...(parsed.rfc
                  ? [
                      {
                        rfc: {
                          equals: parsed.rfc,
                          mode: 'insensitive' as const,
                        },
                      },
                    ]
                  : []),
                { aliases: { has: parsed.supplierName } },
              ],
            },
          })
        : null;

      const mappings = supplier
        ? await this.prisma.supplierProduct.findMany({
            where: {
              supplierId: supplier.id,
              ingredientId: { not: null },
            },
            select: {
              normalizedName: true,
              ingredientId: true,
              quantity: true,
              unit: true,
            },
          })
        : [];

      const mappingMap = new Map(
        mappings.map((mapping) => [mapping.normalizedName, mapping]),
      );

      const items: Array<{
        rawDescription: string;
        ingredientId: string | null;
        quantity: Prisma.Decimal;
        unit: UnitCode;
        unitCostGross: Prisma.Decimal;
        lineTotalGross: Prisma.Decimal;
        confidence: Prisma.Decimal | null;
        mappingSource: string;
      }> = [];

      for (const line of parsed.lines) {
        const normalized = normalizeName(line.description);
        let mapping = mappingMap.get(normalized);
        let mappingSource = mapping ? 'ALIAS' : 'AI';

        if (!mapping && supplier && normalized) {
          const fuzzy = await this.fuzzyMapping(supplier.id, normalized);

          if (fuzzy) {
            mapping = {
              normalizedName: fuzzy.normalizedName,
              ingredientId: fuzzy.ingredientId,
              quantity: fuzzy.quantity,
              unit: fuzzy.unit,
            };
            mappingSource = 'FUZZY';
          }
        }

        const quantity = mapping
          ? new Prisma.Decimal(line.quantity).times(mapping.quantity)
          : new Prisma.Decimal(line.quantity);
        const unit = mapping?.unit ?? toUnitCode(line.unit);
        const unitCostGross = quantity.gt(0)
          ? new Prisma.Decimal(line.lineTotalGross).div(quantity)
          : new Prisma.Decimal(0);

        items.push({
          rawDescription: line.description,
          ingredientId: mapping?.ingredientId ?? null,
          quantity,
          unit,
          unitCostGross,
          lineTotalGross: new Prisma.Decimal(line.lineTotalGross),
          confidence:
            line.confidence === undefined
              ? parsed.confidence === undefined
                ? null
                : new Prisma.Decimal(parsed.confidence)
              : new Prisma.Decimal(line.confidence),
          mappingSource,
        });
      }

      const total = new Prisma.Decimal(
        parsed.total ??
          parsed.lines.reduce((sum, line) => sum + line.lineTotalGross, 0),
      );
      const purchasedAt = parsed.purchasedAt
        ? new Date(parsed.purchasedAt)
        : new Date();
      const date = Number.isNaN(purchasedAt.getTime())
        ? new Date()
        : purchasedAt;
      const extractedJson = JSON.parse(
        JSON.stringify(parsed),
      ) as Prisma.InputJsonValue;
      const confidence =
        parsed.confidence === undefined
          ? null
          : new Prisma.Decimal(parsed.confidence);

      const fingerprint = purchaseFingerprint({
        supplierId: supplier?.id,
        folio: parsed.folio,
      });
      const existing = fingerprint
        ? await this.prisma.purchase.findFirst({
            where: {
              organizationId,
              dedupeKey: fingerprint,
              id: { not: purchaseId },
            },
            select: { id: true },
          })
        : null;
      const meta = {
        ...parsed,
        ...(existing ? { duplicateOf: existing.id } : {}),
      } as Prisma.InputJsonValue;

      await this.prisma.$transaction(async (tx) => {
        await tx.purchaseItem.deleteMany({ where: { purchaseId } });

        for (const item of items) {
          await tx.purchaseItem.create({
            data: {
              purchaseId,
              ...item,
            },
          });
        }

        await tx.purchase.update({
          where: { id: purchaseId },
          data: {
            supplierId: supplier?.id ?? null,
            folio: parsed.folio || null,
            purchasedAt: date,
            total,
            status: PurchaseStatus.NEEDS_REVIEW,
            extractedJson: meta,
            confidence,
            dedupeKey: existing ? null : fingerprint,
          },
        });

        if (document) {
          await tx.aiDocument.update({
            where: { id: document.id },
            data: {
              status: AiDocumentStatus.EXTRACTED,
              extractedJson,
              model: visionModel,
              tokensIn: completion.tokensIn ?? null,
              tokensOut: completion.tokensOut ?? null,
              confidence,
              error: null,
            },
          });
        }
      });

      return this.prisma.purchase.findFirstOrThrow({
        where: { id: purchaseId },
        include: {
          supplier: true,
          items: { orderBy: { rawDescription: 'asc' } },
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'No se pudo leer el ticket';

      await this.prisma.$transaction(async (tx) => {
        await tx.purchase.update({
          where: { id: purchaseId },
          data: {
            status: PurchaseStatus.FAILED,
            extractedJson: { error: message },
          },
        });

        if (document) {
          await tx.aiDocument.update({
            where: { id: document.id },
            data: {
              status: AiDocumentStatus.FAILED,
              error: message,
            },
          });
        }
      });

      throw new BadRequestException(
        'No se pudo leer el ticket. Revisa la foto o captura las líneas manualmente.',
      );
    }
  }

  /**
   * Mapeo difuso contra los productos ya conocidos del proveedor.
   *
   * Se usa `pg_trgm` (índice GIN sobre `normalizedName`) para tolerar
   * diferencias de espaciado, abreviaturas o acentos que el nombre impreso
   * traiga de más. El umbral es conservador: si no hay una coincidencia clara,
   * la línea queda sin mapear para que la revise una persona.
   */
  private async fuzzyMapping(supplierId: string, normalizedName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        normalizedName: string;
        ingredientId: string | null;
        quantity: Prisma.Decimal;
        unit: UnitCode;
      }>
    >`
      SELECT
        sp."normalizedName" AS "normalizedName",
        sp."ingredientId" AS "ingredientId",
        sp."quantity" AS "quantity",
        sp."unit" AS "unit"
      FROM "SupplierProduct" sp
      WHERE sp."supplierId" = ${supplierId}
        AND sp."ingredientId" IS NOT NULL
        AND similarity(sp."normalizedName", ${normalizedName}) >= 0.45
      ORDER BY similarity(sp."normalizedName", ${normalizedName}) DESC
      LIMIT 1
    `;

    return rows[0] ?? null;
  }
}
