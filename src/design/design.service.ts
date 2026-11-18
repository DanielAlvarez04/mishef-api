import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const TOKENS_ID = 'default';

/**
 * Tokens visuales globales.
 *
 * `draft` es lo que se edita en `/styles`; `tokens` es lo que la app aplica.
 * Guardar el borrador no cambia nada hasta que se publica con `apply`.
 */
@Injectable()
export class DesignService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const row = await this.prisma.designTokens.findUnique({
      where: { id: TOKENS_ID },
    });

    return {
      applied: row?.tokens ?? null,
      draft: row?.draft ?? null,
    };
  }

  async saveDraft(tokens: Record<string, unknown>) {
    const row = await this.prisma.designTokens.upsert({
      where: { id: TOKENS_ID },
      create: {
        id: TOKENS_ID,
        draft: tokens as Prisma.InputJsonValue,
      },
      update: { draft: tokens as Prisma.InputJsonValue },
    });

    return { draft: row.draft ?? null };
  }

  /** Publica el borrador: desde este momento lo usa toda la app. */
  async apply(tokens: Record<string, unknown>) {
    const value = tokens as Prisma.InputJsonValue;
    const row = await this.prisma.designTokens.upsert({
      where: { id: TOKENS_ID },
      create: { id: TOKENS_ID, tokens: value, draft: value },
      update: { tokens: value, draft: value },
    });

    return { applied: row.tokens ?? null };
  }

  async reset() {
    await this.prisma.designTokens.deleteMany({ where: { id: TOKENS_ID } });
    return { applied: null, draft: null };
  }
}
