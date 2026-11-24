import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  defaultReceiptTemplate,
  receiptTemplateSchema,
  type ReceiptTemplate,
} from './point-receipt';

const GLOBAL_TEMPLATE_KEY = 'receipt.template.global';

/**
 * Resuelve la plantilla efectiva del ticket.
 *
 * Orden: override de sucursal → plantilla global guardada por el superadmin →
 * plantilla del código. La plantilla global es solo estructura; los datos de
 * la sucursal se inyectan al renderizar.
 */
@Injectable()
export class ReceiptTemplateSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getGlobal(): Promise<ReceiptTemplate> {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key: GLOBAL_TEMPLATE_KEY },
      select: { value: true },
    });

    if (!setting) return defaultReceiptTemplate();

    const parsed = receiptTemplateSchema.safeParse(setting.value);

    return parsed.success ? parsed.data : defaultReceiptTemplate();
  }

  async getForBranch(branchTemplate: unknown): Promise<ReceiptTemplate> {
    if (branchTemplate !== null && branchTemplate !== undefined) {
      const parsed = receiptTemplateSchema.safeParse(branchTemplate);

      if (parsed.success) return parsed.data;
    }

    return this.getGlobal();
  }

  /** Guarda la plantilla global. `null` restablece la del código. */
  async saveGlobal(
    template: ReceiptTemplate | null,
    userId?: string,
  ): Promise<ReceiptTemplate> {
    if (template === null) {
      await this.prisma.platformSetting.deleteMany({
        where: { key: GLOBAL_TEMPLATE_KEY },
      });

      return defaultReceiptTemplate();
    }

    await this.prisma.platformSetting.upsert({
      where: { key: GLOBAL_TEMPLATE_KEY },
      create: {
        key: GLOBAL_TEMPLATE_KEY,
        value: template,
        updatedById: userId ?? null,
      },
      update: {
        value: template,
        updatedById: userId ?? null,
      },
    });

    return template;
  }

  /** Quita los overrides de todas las sucursales para que usen la global. */
  async clearBranchOverrides(): Promise<number> {
    const result = await this.prisma.branch.updateMany({
      data: { receiptTemplate: Prisma.DbNull },
    });

    return result.count;
  }
}
