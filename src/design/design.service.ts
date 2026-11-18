import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const TOKENS_ID = 'default';

/** Tokens visuales globales editados desde `/styles`. */
@Injectable()
export class DesignService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const row = await this.prisma.designTokens.findUnique({
      where: { id: TOKENS_ID },
    });

    return { tokens: row?.tokens ?? null };
  }

  async save(tokens: Record<string, unknown>) {
    const row = await this.prisma.designTokens.upsert({
      where: { id: TOKENS_ID },
      create: { id: TOKENS_ID, tokens: tokens as Prisma.InputJsonValue },
      update: { tokens: tokens as Prisma.InputJsonValue },
    });

    return { tokens: row.tokens };
  }

  async reset() {
    await this.prisma.designTokens.deleteMany({ where: { id: TOKENS_ID } });
    return { tokens: null };
  }
}
