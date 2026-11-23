import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiProposalStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { readIntelSettings } from '../intel.config';
import { OpenAiCompatibleClient } from '../providers/openai-compatible.client';
import {
  CATALOG_AI_FIELDS,
  type CatalogAiField,
} from './dto/catalog-ai.dto';

const translationSchema = z
  .object({
    en: z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().min(5).max(600).optional(),
      })
      .strict(),
  })
  .strict();

const proposalSchema = z
  .object({
    description: z.string().trim().min(10).max(600).optional(),
    allergens: z
      .array(z.string().trim().min(2).max(40))
      .max(20)
      .optional(),
    categoryName: z.string().trim().min(2).max(80).optional(),
    translations: translationSchema.optional(),
    marketingCopy: z.string().trim().min(10).max(600).optional(),
  })
  .strict();

/** Valores corregidos por una persona: se permiten textos más cortos. */
const editSchema = z
  .object({
    description: z.string().trim().min(1).max(600).optional(),
    allergens: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .optional(),
    categoryName: z.string().trim().min(1).max(80).optional(),
    translations: translationSchema.optional(),
    marketingCopy: z.string().trim().max(600).optional(),
  })
  .strict();

type ProposalFields = z.infer<typeof proposalSchema>;

function stripJson(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');

  return start >= 0 && end > start
    ? content.slice(start, end + 1)
    : content.trim();
}

function proposalHash(
  item: {
    id: string;
    name: string;
    description: string | null;
    categoryId: string | null;
  },
  fields: CatalogAiField[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: item.id,
        name: item.name,
        description: item.description,
        categoryId: item.categoryId,
        fields: [...fields].sort(),
        version: 1,
      }),
    )
    .digest('hex');
}

@Injectable()
export class CatalogAiService {
  private readonly logger = new Logger(CatalogAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: OpenAiCompatibleClient,
  ) {}

  async list(
    organizationId: string,
    status: AiProposalStatus = AiProposalStatus.PROPOSED,
  ) {
    return this.prisma.aiCatalogProposal.findMany({
      where: { organizationId, status },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        item: {
          select: {
            id: true,
            name: true,
            description: true,
            allergens: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  async generate(
    organizationId: string,
    userId: string,
    itemIds: string[],
    requestedFields?: CatalogAiField[],
  ) {
    const fields =
      requestedFields && requestedFields.length > 0
        ? [...new Set(requestedFields)]
        : [...CATALOG_AI_FIELDS];

    const settings = readIntelSettings();
    const target = settings.targets[0];

    if (!target) {
      throw new ServiceUnavailableException(
        'Intel no tiene un proveedor de texto configurado',
      );
    }

    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, organizationId },
      select: {
        id: true,
        name: true,
        description: true,
        categoryId: true,
        category: { select: { name: true } },
        allergens: true,
        translations: true,
        marketingCopy: true,
        recipes: {
          select: {
            ingredients: {
              select: { ingredient: { select: { name: true } } },
            },
          },
        },
      },
    });

    if (items.length !== itemIds.length) {
      throw new BadRequestException(
        'Hay artículos que no pertenecen a este negocio',
      );
    }

    const categories = await this.prisma.category.findMany({
      where: { organizationId, isActive: true, kind: 'ARTICLE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const proposals: Array<Record<string, unknown>> = [];
    const errors: Array<{ itemId: string; message: string }> = [];

    for (const item of items) {
      const hash = proposalHash(item, fields);
      const cached = await this.prisma.aiCatalogProposal.findUnique({
        where: { itemId_hash: { itemId: item.id, hash } },
        include: {
          item: { select: { id: true, name: true } },
        },
      });

      if (cached && cached.status !== AiProposalStatus.DISMISSED) {
        proposals.push(cached as unknown as Record<string, unknown>);
        continue;
      }

      try {
        const ingredientNames = [
          ...new Set(
            item.recipes.flatMap((recipe) =>
              recipe.ingredients.map((row) => row.ingredient.name),
            ),
          ),
        ].slice(0, 40);

        const completion = await this.client.completeChat({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          temperature: 0.2,
          maxTokens: 900,
          messages: [
            {
              role: 'system',
              content:
                'Eres un asistente de catálogo para restaurantes mexicanos. Respondes SOLO con un objeto JSON válido, sin Markdown ni explicaciones.',
            },
            {
              role: 'user',
              content: [
                `Artículo: ${item.name}`,
                `Descripción actual: ${item.description ?? '(sin descripción)'}`,
                `Categoría actual: ${item.category?.name ?? '(sin categoría)'}`,
                `Alérgenos actuales: ${item.allergens.join(', ') || '(ninguno)'}`,
                `Ingredientes de la receta: ${ingredientNames.join(', ') || '(sin receta)'}`,
                `Categorías disponibles: ${categories.map((category) => category.name).join(' | ')}`,
                `Campos solicitados: ${fields.join(', ')}`,
                'Devuelve solo los campos solicitados con esta forma:',
                '{"description":"...","allergens":["..."],"categoryName":"...","translations":{"en":{"name":"...","description":"..."}},"marketingCopy":"..."}',
                'Reglas: descripción breve y apetitosa (máx 240 caracteres); alérgenos comunes (gluten, lácteos, huevo, soya, cacahuate, nuez, pescado, mariscos, ajonjolí); categoría exacta de la lista; traducción al inglés fiel; copy de una línea para carta o redes. No inventes ingredientes que no aparezcan en la receta o el nombre.',
              ].join('\n'),
            },
          ],
        });

        if (!completion.content) {
          throw new Error('El modelo no devolvió contenido');
        }

        const parsed = proposalSchema.parse(
          JSON.parse(stripJson(completion.content)),
        );

        const selected: ProposalFields = {};

        if (fields.includes('description') && parsed.description) {
          selected.description = parsed.description;
        }

        if (fields.includes('allergens') && parsed.allergens) {
          selected.allergens = [...new Set(parsed.allergens)].slice(0, 20);
        }

        if (fields.includes('category') && parsed.categoryName) {
          const category = categories.find(
            (candidate) =>
              candidate.name.toLowerCase() ===
              parsed.categoryName!.toLowerCase(),
          );

          if (category) {
            selected.categoryName = category.name;
          }
        }

        if (fields.includes('translations') && parsed.translations) {
          selected.translations = parsed.translations;
        }

        if (fields.includes('marketingCopy') && parsed.marketingCopy) {
          selected.marketingCopy = parsed.marketingCopy;
        }

        if (Object.keys(selected).length === 0) {
          throw new Error('La propuesta no trajo campos útiles');
        }

        const proposal = await this.prisma.aiCatalogProposal.create({
          data: {
            organizationId,
            itemId: item.id,
            hash,
            fields: selected as Prisma.InputJsonValue,
            model: target.model,
            tokensIn: completion.tokensIn ?? null,
            tokensOut: completion.tokensOut ?? null,
            createdBy: userId,
          },
          include: {
            item: { select: { id: true, name: true } },
          },
        });

        proposals.push(proposal as unknown as Record<string, unknown>);
        await this.upsertUsage(
          organizationId,
          target.model,
          completion.tokensIn ?? 0,
          completion.tokensOut ?? 0,
        );
      } catch (error) {
        this.logger.warn(
          `Propuesta de catálogo falló para ${item.id}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
        errors.push({
          itemId: item.id,
          message: 'No se pudo generar la propuesta para este artículo',
        });
      }
    }

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: 'AI_CATALOG_PROPOSED',
        entity: 'Item',
        entityId: items[0]?.id ?? 'batch',
        newValues: {
          items: items.length,
          proposals: proposals.length,
          errors: errors.length,
          fields,
        },
      },
    });

    return { proposals, errors };
  }

  async apply(
    organizationId: string,
    userId: string,
    proposalId: string,
    fields: CatalogAiField[],
    edits?: Record<string, unknown>,
  ) {
    const proposal = await this.prisma.aiCatalogProposal.findFirst({
      where: { id: proposalId, organizationId },
      include: { item: true },
    });

    if (!proposal) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    const stored = proposal.fields as ProposalFields;
    let values = stored;

    if (edits && Object.keys(edits).length > 0) {
      const parsed = editSchema.safeParse(edits);

      if (!parsed.success) {
        throw new BadRequestException('Los valores editados no son válidos');
      }

      values = { ...stored, ...parsed.data };
    }

    const data: Prisma.ItemUpdateInput = {};

    if (fields.includes('description') && values.description) {
      data.description = values.description;
    }

    if (fields.includes('allergens') && values.allergens) {
      data.allergens = values.allergens;
    }

    if (fields.includes('translations') && values.translations) {
      data.translations = values.translations as Prisma.InputJsonValue;
    }

    if (fields.includes('marketingCopy') && values.marketingCopy) {
      data.marketingCopy = values.marketingCopy;
    }

    if (fields.includes('category') && values.categoryName) {
      const category = await this.prisma.category.findFirst({
        where: {
          organizationId,
          isActive: true,
          kind: 'ARTICLE',
          name: { equals: values.categoryName, mode: 'insensitive' },
        },
        select: { id: true },
      });

      if (category) {
        data.category = { connect: { id: category.id } };
      }
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'No hay campos aplicables en esta propuesta',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id: proposal.itemId }, data });

      await tx.aiCatalogProposal.update({
        where: { id: proposal.id },
        data: { status: AiProposalStatus.APPLIED, appliedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          userId,
          action: 'AI_CATALOG_APPLIED',
          entity: 'Item',
          entityId: proposal.itemId,
          newValues: {
            proposalId: proposal.id,
            fields,
          },
        },
      });
    });

    return { itemId: proposal.itemId, applied: fields };
  }

  async dismiss(organizationId: string, userId: string, proposalId: string) {
    const proposal = await this.prisma.aiCatalogProposal.findFirst({
      where: { id: proposalId, organizationId },
      select: { id: true, itemId: true },
    });

    if (!proposal) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    await this.prisma.aiCatalogProposal.update({
      where: { id: proposal.id },
      data: { status: AiProposalStatus.DISMISSED },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action: 'AI_CATALOG_DISMISSED',
        entity: 'Item',
        entityId: proposal.itemId,
        newValues: { proposalId: proposal.id },
      },
    });

    return { dismissed: true };
  }

  private async upsertUsage(
    organizationId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
  ) {
    const now = new Date();
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    await this.prisma.aiUsage.upsert({
      where: {
        organizationId_day_feature_model: {
          organizationId,
          day,
          feature: 'CATALOG',
          model,
        },
      },
      create: {
        organizationId,
        day,
        feature: 'CATALOG',
        model,
        requests: 1,
        tokensIn,
        tokensOut,
      },
      update: {
        requests: { increment: 1 },
        tokensIn: { increment: tokensIn },
        tokensOut: { increment: tokensOut },
      },
    });
  }
}
