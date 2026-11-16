import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PRACTICE_WINDOW_MS } from '../common/practice';
import { isEmptyPatch, sameDecimal, sameStringSet } from '../common/patch';
import {
  isValidDomain,
  normalizeDomain,
} from '../common/usernames';
import {
  MAX_SLUG_LENGTH,
  RESERVED_SLUGS,
  isValidSlug,
  normalizeSlug,
} from '../common/slug';
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
      currency: organization.currency ?? 'MXN',
      brandColor: organization.brandColor ?? null,
      logoUrl: organization.logoUrl ?? null,
      address: organization.address ?? null,
      latitude: organization.latitude?.toString() ?? null,
      longitude: organization.longitude?.toString() ?? null,
      isActive: organization.isActive,
      useCoreSuggestions: organization.useCoreSuggestions ?? true,
      practiceMode: organization.practiceMode,
      practiceUntil: organization.practiceUntil?.toISOString() ?? null,
      practiceActive:
        organization.practiceMode &&
        (!organization.practiceUntil || organization.practiceUntil > new Date()),
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

  /**
   * Comprueba si una dirección (`micafeteria`) puede usarse como subdominio.
   *
   * Es única global porque se resuelve por host: dos negocios con el mismo
   * slug harían imposible saber a cuál pertenece la petición.
   */
  async slugAvailable(rawSlug: string) {
    const slug = normalizeSlug(rawSlug ?? '');

    if (!isValidSlug(slug)) {
      return {
        slug,
        available: false,
        reason: RESERVED_SLUGS.has(slug) ? ('reserved' as const) : ('invalid' as const),
      };
    }

    const existing = await this.prisma.organization.findUnique({
      where: { slug },
    });

    if (existing) {
      return { slug, available: false, reason: 'taken' as const };
    }

    return { slug, available: true };
  }

  /**
   * Sugiere una dirección a partir del nombre del negocio.
   *
   * Si la ideal está ocupada, prueba sufijos cortos (`-2`, `-3`…) para que el
   * usuario no tenga que inventar. Devuelve siempre un slug válido.
   */
  async slugSuggestion(rawName: string) {
    const base = normalizeSlug(rawName ?? '') || 'mi-negocio';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate =
        attempt === 0 ? base : `${base.slice(0, MAX_SLUG_LENGTH - 4)}-${attempt + 1}`;

      if (!isValidSlug(candidate)) continue;

      const existing = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!existing) {
        return { slug: candidate, available: true as const };
      }
    }

    return { slug: base, available: false as const };
  }

  /**
   * Datos públicos de un negocio a partir de su dirección.
   *
   * Lo usa el middleware del frontend para resolver `micafeteria.mishef.co`
   * antes de que exista una sesión. Nunca devuelve datos internos.
   */
  async tenant(rawSlug: string) {
    const slug = normalizeSlug(rawSlug ?? '');

    if (!isValidSlug(slug)) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      select: {
        name: true,
        slug: true,
        isActive: true,
        brandColor: true,
        logoUrl: true,
        address: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!organization || !organization.isActive) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return {
      name: organization.name,
      slug: organization.slug,
      brandColor: organization.brandColor ?? null,
      logoUrl: organization.logoUrl ?? null,
      address: organization.address ?? null,
      latitude: organization.latitude?.toString() ?? null,
      longitude: organization.longitude?.toString() ?? null,
    };
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
      currency?: string;
      brandColor?: string | null;
      logoUrl?: string | null;
      address?: string | null;
      latitude?: Prisma.Decimal | null;
      longitude?: Prisma.Decimal | null;
      businessType?: string;
      serviceTypes?: string[];
      goals?: string[];
      hasBranches?: boolean;
      useCoreSuggestions?: boolean;
      practiceMode?: boolean;
      practiceUntil?: Date | null;
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

    if (dto.currency !== undefined && dto.currency !== current.currency) {
      data.currency = dto.currency;
    }

    if (dto.businessType !== undefined && dto.businessType !== current.businessType) {
      data.businessType = dto.businessType;
    }

    if (dto.brandColor !== undefined) {
      const brandColor = dto.brandColor.trim().toLowerCase();
      if (brandColor !== (current.brandColor ?? null)) {
        data.brandColor = brandColor;
      }
    }

    if (dto.logoUrl !== undefined) {
      const logoUrl = dto.logoUrl.trim();
      if (logoUrl !== (current.logoUrl ?? null)) {
        data.logoUrl = logoUrl || null;
      }
    }

    if (dto.address !== undefined) {
      const address = dto.address.trim();
      if (address !== (current.address ?? null)) {
        data.address = address || null;
      }
    }

    if (dto.latitude !== undefined) {
      const latitude = new Prisma.Decimal(dto.latitude);
      if (!sameDecimal(latitude, current.latitude)) {
        data.latitude = latitude;
      }
    }

    if (dto.longitude !== undefined) {
      const longitude = new Prisma.Decimal(dto.longitude);
      if (!sameDecimal(longitude, current.longitude)) {
        data.longitude = longitude;
      }
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

    if (dto.practiceMode !== undefined) {
      const currentPracticeActive =
        current.practiceMode &&
        (!current.practiceUntil || current.practiceUntil > new Date())

      if (!dto.practiceMode) {
        if (current.practiceMode || current.practiceUntil) {
          data.practiceMode = false
          data.practiceUntil = null
        }
      } else if (!currentPracticeActive) {
        // Activar desde Configuración también abre una ventana de 48 horas.
        data.practiceMode = true
        data.practiceUntil = new Date(Date.now() + PRACTICE_WINDOW_MS)
      }
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
      currency: organization.currency ?? 'MXN',
      brandColor: organization.brandColor ?? null,
      logoUrl: organization.logoUrl ?? null,
      address: organization.address ?? null,
      latitude: organization.latitude?.toString() ?? null,
      longitude: organization.longitude?.toString() ?? null,
      isActive: organization.isActive,
      businessType: organization.businessType,
      serviceTypes: organization.serviceTypes,
      goals: organization.goals,
      hasBranches: organization.hasBranches,
      useCoreSuggestions: organization.useCoreSuggestions ?? true,
      practiceMode: organization.practiceMode,
      practiceUntil: organization.practiceUntil?.toISOString() ?? null,
      practiceActive:
        organization.practiceMode &&
        (!organization.practiceUntil || organization.practiceUntil > new Date()),
    };
  }

  /**
   * Cierra el modo práctica (idempotente).
   *
   * Lo puede llamar cualquier miembro autenticado: solo apaga la medición de
   * operación de la organización, no toca ventas ni inventario.
   */
  async endPractice(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    await this.prisma.organization.updateMany({
      where: { id: organizationId },
      data: { practiceMode: false, practiceUntil: null },
    });

    return { practiceMode: false, practiceUntil: null };
  }
}
