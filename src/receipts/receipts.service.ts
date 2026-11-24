import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { PointReceiptPrintService } from '../mercadopago/point-receipt-print.service';
import {
  defaultReceiptTemplate,
  parseReceiptTemplate,
  receiptTemplateOrDefault,
  receiptTemplateSchema,
  renderReceiptPreviewHtml,
  renderReceiptText,
  type ReceiptTemplate,
} from '../mercadopago/point-receipt';
import { sampleReceiptInput } from '../mercadopago/receipt-sample';
import { publicUrlForKey } from '../uploads/r2';

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receiptPrint: PointReceiptPrintService,
  ) {}

  async list() {
    const organizations = await this.prisma.organization.findMany({
      where: { slug: { not: 'mishef-platform' } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        currency: true,
        branches: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
            receiptTemplate: true,
            mercadoPagoTerminals: {
              where: { isActive: true, operatingMode: 'PDV' },
              orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
              select: { id: true, name: true, isDefault: true, model: true },
            },
          },
        },
      },
    });

    return {
      defaults: defaultReceiptTemplate(),
      organizations: organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        currency: organization.currency,
        branches: organization.branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
          receiptTemplate: this.storedTemplate(branch.receiptTemplate),
          terminals: branch.mercadoPagoTerminals,
        })),
      })),
    };
  }

  async save(branchId: string, template: unknown) {
    await this.assertBranch(branchId);

    if (template === undefined) {
      throw new BadRequestException('Falta la plantilla del ticket.');
    }

    if (template === null) {
      await this.prisma.branch.update({
        where: { id: branchId },
        data: { receiptTemplate: Prisma.DbNull },
      });

      return { template: defaultReceiptTemplate() };
    }

    const parsed = this.parse(template);

    await this.prisma.branch.update({
      where: { id: branchId },
      data: { receiptTemplate: parsed },
    });

    return { template: parsed };
  }

  async preview(branchId: string, template?: unknown) {
    const branch = await this.branchContext(branchId);
    const receipt = sampleReceiptInput({
      organizationName: branch.organization.name,
      organizationAddress: branch.organization.address,
      branchName: branch.name,
      branchAddress: branch.address,
      currency: branch.organization.currency,
    });
    const selected = this.templateFor(branch.receiptTemplate, template);
    const rendered = renderReceiptText(selected, receipt);

    return {
      template: selected,
      content: rendered.content,
      html: renderReceiptPreviewHtml(rendered.content),
      warnings: rendered.warnings,
      logoUrl: this.logoUrl(branch.organization.logoReceiptKey),
    };
  }

  async testPrint(branchId: string, template?: unknown) {
    const branch = await this.branchContext(branchId);
    const selected = this.templateFor(branch.receiptTemplate, template);
    const receipt = sampleReceiptInput({
      organizationName: branch.organization.name,
      organizationAddress: branch.organization.address,
      branchName: branch.name,
      branchAddress: branch.address,
      currency: branch.organization.currency,
    });

    return this.receiptPrint.print({
      organizationId: branch.organizationId,
      branchId: branch.id,
      template: selected,
      receipt,
      logoReceiptKey: branch.organization.logoReceiptKey,
      reference: `receipt-test-${branch.id}`,
    });
  }

  private templateFor(stored: unknown, draft: unknown): ReceiptTemplate {
    if (draft !== undefined && draft !== null) return this.parse(draft);

    return receiptTemplateOrDefault(stored);
  }

  private parse(value: unknown): ReceiptTemplate {
    try {
      return parseReceiptTemplate(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          message: 'La plantilla del ticket no es válida',
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      throw error;
    }
  }

  private async assertBranch(branchId: string) {
    const exists = await this.prisma.branch.count({ where: { id: branchId } });

    if (!exists) {
      throw new NotFoundException('Sucursal no encontrada');
    }
  }

  private async branchContext(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        organizationId: true,
        name: true,
        address: true,
        phone: true,
        receiptTemplate: true,
        organization: {
          select: {
            name: true,
            address: true,
            currency: true,
            logoReceiptKey: true,
          },
        },
      },
    });

    if (!branch) {
      throw new NotFoundException('Sucursal no encontrada');
    }

    return branch;
  }

  private logoUrl(key: string | null): string | null {
    return key ? publicUrlForKey(key) : null;
  }

  private storedTemplate(value: unknown): ReceiptTemplate | null {
    if (value === null || value === undefined) return null;

    const parsed = receiptTemplateSchema.safeParse(value);

    return parsed.success ? parsed.data : null;
  }
}
