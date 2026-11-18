import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UpsertFiscalProfileDto } from './dto/fiscal-profile.dto';

/** Datos fiscales del negocio (fase 0: captura, sin timbrado). */
@Injectable()
export class FiscalService {
  constructor(private readonly prisma: PrismaService) {}

  get(organizationId: string) {
    return this.prisma.fiscalProfile.findUnique({
      where: { organizationId },
    });
  }

  async upsert(organizationId: string, dto: UpsertFiscalProfileDto) {
    const data = {
      rfc: dto.rfc.trim().toUpperCase(),
      legalName: dto.legalName.trim(),
      taxRegime: dto.taxRegime,
      zipCode: dto.zipCode,
      cfdiUse: dto.cfdiUse ?? 'G03',
      email: dto.email?.trim().toLowerCase() || null,
    };

    const existing = await this.prisma.fiscalProfile.findUnique({
      where: { organizationId },
    });

    // Si nada cambió no se escribe: no se toca `updatedAt`.
    if (
      existing &&
      existing.rfc === data.rfc &&
      existing.legalName === data.legalName &&
      existing.taxRegime === data.taxRegime &&
      existing.zipCode === data.zipCode &&
      existing.cfdiUse === data.cfdiUse &&
      existing.email === data.email
    ) {
      return existing;
    }

    return this.prisma.fiscalProfile.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
  }
}
