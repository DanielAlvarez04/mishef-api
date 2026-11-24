import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { PointReceiptPrintService } from '../mercadopago/point-receipt-print.service';
import { ReceiptTemplateSettingsService } from '../mercadopago/receipt-template-settings.service';
import {
  parseReceiptTemplate,
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
    private readonly settings: ReceiptTemplateSettingsService,
  ) {}

  /** Datos del editor de plataforma: global + todos los negocios. */
  async list() {
    const [globalTemplate, organizations] = await Promise.all([
      this.settings.getGlobal(),
      this.prisma.organization.findMany({
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
      }),
    ]);

    return {
      globalTemplate,
      defaults: globalTemplate,
      organizations: organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        currency: organization.currency,
        branches: organization.branches.map((branch) =>
          this.branchView(branch),
        ),
      })),
    };
  }

  /** Datos del editor de una organización concreta. */
  async listForOrganization(organizationId: string) {
    const [globalTemplate, organization] = await Promise.all([
      this.settings.getGlobal(),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
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
      }),
    ]);

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    return {
      globalTemplate,
      defaults: globalTemplate,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        currency: organization.currency,
        branches: organization.branches.map((branch) =>
          this.branchView(branch),
        ),
      },
    };
  }

  /** Guarda la plantilla global de la plataforma. `null` la restablece. */
  async saveGlobal(template: unknown, userId: string) {
    if (template === undefined) {
      throw new BadRequestException('Falta la plantilla del ticket.');
    }

    if (template === null) {
      const saved = await this.settings.saveGlobal(null, userId);
      return { template: saved };
    }

    const parsed = this.parse(template);
    const saved = await this.settings.saveGlobal(parsed, userId);

    return { template: saved };
  }

  /** Quita todos los overrides de sucursal para que aplique la global. */
  async clearOverrides() {
    const cleared = await this.settings.clearBranchOverrides();

    return { cleared };
  }

  /** Guarda el override de una sucursal. `null` vuelve a la global. */
  async save(branchId: string, template: unknown, organizationId?: string) {
    await this.assertBranch(branchId, organizationId);

    if (template === undefined) {
      throw new BadRequestException('Falta la plantilla del ticket.');
    }

    if (template === null) {
      await this.prisma.branch.update({
        where: { id: branchId },
        data: { receiptTemplate: Prisma.DbNull },
      });

      return { template: await this.settings.getGlobal() };
    }

    const parsed = this.parse(template);

    await this.prisma.branch.update({
      where: { id: branchId },
      data: { receiptTemplate: parsed },
    });

    return { template: parsed };
  }

  async preview(
    branchId: string,
    template?: unknown,
    organizationId?: string,
  ) {
    const branch = await this.branchContext(branchId, organizationId);
    const receipt = sampleReceiptInput({
      organizationName: branch.organization.name,
      organizationAddress: branch.organization.address,
      branchName: branch.name,
      branchAddress: branch.address,
      currency: branch.organization.currency,
    });
    const selected = await this.templateFor(branch.receiptTemplate, template);
    const rendered = renderReceiptText(selected, receipt);

    return {
      template: selected,
      content: rendered.content,
      html: renderReceiptPreviewHtml(rendered.content),
      warnings: rendered.warnings,
      logoUrl: this.logoUrl(branch.organization.logoReceiptKey),
    };
  }

  async testPrint(
    branchId: string,
    template?: unknown,
    organizationId?: string,
  ) {
    const branch = await this.branchContext(branchId, organizationId);
    const selected = await this.templateFor(branch.receiptTemplate, template);
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

  private async templateFor(
    stored: unknown,
    draft: unknown,
  ): Promise<ReceiptTemplate> {
    if (draft !== undefined && draft !== null) return this.parse(draft);

    return this.settings.getForBranch(stored);
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

  private async assertBranch(branchId: string, organizationId?: string) {
    const exists = await this.prisma.branch.count({
      where: organizationId ? { id: branchId, organizationId } : { id: branchId },
    });

    if (!exists) {
      throw new NotFoundException('Sucursal no encontrada');
    }
  }

  private async branchContext(branchId: string, organizationId?: string) {
    const branch = await this.prisma.branch.findFirst({
      where: organizationId ? { id: branchId, organizationId } : { id: branchId },
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

  private branchView(branch: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    receiptTemplate: unknown;
    mercadoPagoTerminals: Array<{
      id: string;
      name: string | null;
      isDefault: boolean;
      model: string | null;
    }>;
  }) {
    return {
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      receiptTemplate: this.storedTemplate(branch.receiptTemplate),
      terminals: branch.mercadoPagoTerminals,
    };
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
