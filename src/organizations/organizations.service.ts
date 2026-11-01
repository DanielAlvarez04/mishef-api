import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch, sameDecimal, sameStringSet } from '../common/patch';
import {
  isValidDomain,
  normalizeDomain,
} from '../common/usernames';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async current(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      domain: organization.domain,
      taxRate: organization.taxRate?.toString() ?? '0.16',
      isActive: organization.isActive,
      useCoreSuggestions: organization.useCoreSuggestions ?? true,
    };
  }

  /** Comprueba si un dominio puede usarlo la organización (es único global). */
  async domainAvailable(rawDomain: string) {
    const domain = normalizeDomain(rawDomain ?? '');

    if (!isValidDomain(domain)) {
      return { domain, available: false, reason: 'invalid' as const };
    }

    const existing = await this.prisma.organization.findUnique({
      where: { domain },
    });

    if (existing) {
      return { domain, available: false, reason: 'taken' as const };
    }

    return { domain, available: true };
  }

  async update(organizationId: string | null, dto: UpdateOrganizationDto) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!current) {
      throw new NotFoundException('Organización no encontrada');
    }

    const data: {
      name?: string;
      domain?: string;
      taxRate?: Prisma.Decimal;
      businessType?: string;
      serviceTypes?: string[];
      goals?: string[];
      hasBranches?: boolean;
      useCoreSuggestions?: boolean;
    } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== current.name) data.name = name;
    }

    if (dto.domain !== undefined) {
      const domain = normalizeDomain(dto.domain);

      if (!isValidDomain(domain)) {
        throw new BadRequestException('El dominio no es válido');
      }

      if (domain !== current.domain) {
        const taken = await this.prisma.organization.findUnique({
          where: { domain },
        });

        if (taken && taken.id !== organizationId) {
          throw new ConflictException('Ese dominio ya está en uso');
        }

        data.domain = domain;
      }
    }

    if (dto.taxRate !== undefined) {
      if (dto.taxRate < 0 || dto.taxRate > 1) {
        throw new BadRequestException(
          'La tasa de IVA debe estar entre 0 y 1 (0.16 = 16 %)',
        );
      }

      const taxRate = new Prisma.Decimal(dto.taxRate);
      if (!sameDecimal(taxRate, current.taxRate)) data.taxRate = taxRate;
    }

    if (dto.businessType !== undefined && dto.businessType !== current.businessType) {
      data.businessType = dto.businessType;
    }

    if (
      dto.serviceTypes !== undefined &&
      !sameStringSet(current.serviceTypes, dto.serviceTypes)
    ) {
      data.serviceTypes = dto.serviceTypes;
    }

    if (dto.goals !== undefined && !sameStringSet(current.goals, dto.goals)) {
      data.goals = dto.goals;
    }

    if (
      dto.hasBranches !== undefined &&
      dto.hasBranches !== current.hasBranches
    ) {
      data.hasBranches = dto.hasBranches;
    }

    if (
      dto.useCoreSuggestions !== undefined &&
      dto.useCoreSuggestions !== (current.useCoreSuggestions ?? true)
    ) {
      data.useCoreSuggestions = dto.useCoreSuggestions;
    }

    const organization = isEmptyPatch(data)
      ? current
      : await this.prisma.organization.update({
          where: { id: organizationId },
          data,
        });

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      domain: organization.domain,
      taxRate: organization.taxRate?.toString() ?? '0.16',
      isActive: organization.isActive,
      businessType: organization.businessType,
      serviceTypes: organization.serviceTypes,
      goals: organization.goals,
      hasBranches: organization.hasBranches,
      useCoreSuggestions: organization.useCoreSuggestions ?? true,
    };
  }
}
