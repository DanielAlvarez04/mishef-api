import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { resolveCname, resolveTxt } from 'node:dns/promises';
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
      domainToken: organization.domainToken ?? null,
      domainVerifiedAt: organization.domainVerifiedAt?.toISOString() ?? null,
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

  /** Nombre del TXT donde el negocio publica el token de verificación. */
  private domainTxtName(domain: string): string {
    return `_mishef.${domain}`;
  }

  private get tenantBaseDomain(): string {
    return (process.env.TENANT_DOMAIN ?? 'mishef.co').trim().toLowerCase();
  }

  private domainInstructions(
    slug: string,
    domain: string,
    token: string,
    verifiedAt: Date | null,
  ) {
    return {
      domain,
      status: verifiedAt ? ('verified' as const) : ('pending' as const),
      verifiedAt: verifiedAt?.toISOString() ?? null,
      /** Registro CNAME que apunta al subdominio del negocio. */
      cname: { name: domain, value: `${slug}.${this.tenantBaseDomain}` },
      /** Registro TXT que demuestra el control del dominio. */
      txt: { name: this.domainTxtName(domain), value: token },
    };
  }

  /**
   * Conecta un dominio propio. Queda **pendiente** hasta que el DNS responda:
   * un dominio escrito a mano sin verificar no debe servir tráfico, porque
   * cualquiera podría reclamar el de otro.
   */
  async setDomain(organizationId: string | null, rawDomain: string) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        slug: true,
        domain: true,
        domainToken: true,
        domainVerifiedAt: true,
      },
    });

    if (!current) {
      throw new NotFoundException('Organización no encontrada');
    }

    const domain = normalizeDomain(rawDomain ?? '');

    if (!isValidDomain(domain)) {
      throw new BadRequestException('El dominio no es válido');
    }

    // Volver a enviar el mismo dominio no rota el token: si el DNS ya estaba
    // publicado, el negocio no tiene que volver a tocar su proveedor.
    if (domain === current.domain && current.domainToken) {
      return this.domainInstructions(
        current.slug,
        domain,
        current.domainToken,
        current.domainVerifiedAt,
      );
    }

    const taken = await this.prisma.organization.findUnique({
      where: { domain },
      select: { id: true },
    });

    if (taken && taken.id !== organizationId) {
      throw new ConflictException('Ese dominio ya está en uso');
    }

    const token = `mishef-verify=${randomBytes(16).toString('hex')}`;

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { domain, domainToken: token, domainVerifiedAt: null },
    });

    return this.domainInstructions(current.slug, domain, token, null);
  }

  /**
   * Comprueba el CNAME y el TXT contra el DNS real.
   *
   * Devuelve qué falló en lugar de lanzar: el panel muestra dos palomitas y el
   * usuario entiende qué registro le falta.
   */
  async verifyDomain(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        slug: true,
        domain: true,
        domainToken: true,
        domainVerifiedAt: true,
      },
    });

    if (!organization?.domain || !organization.domainToken) {
      throw new BadRequestException('Primero conecta un dominio');
    }

    const expectedCname = `${organization.slug}.${this.tenantBaseDomain}`;
    let txt = false;
    let cname = false;

    try {
      const records = await resolveTxt(
        this.domainTxtName(organization.domain),
      );
      txt = records
        .map((parts) => parts.join(''))
        .some((value) => value.trim() === organization.domainToken);
    } catch {
      txt = false;
    }

    try {
      const records = await resolveCname(organization.domain);
      cname = records.some(
        (value) => value.replace(/\.$/, '').toLowerCase() === expectedCname,
      );
    } catch {
      cname = false;
    }

    if (txt && cname) {
      const verifiedAt = new Date();

      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { domainVerifiedAt: verifiedAt },
      });

      return {
        verified: true as const,
        checks: { txt: true, cname: true },
        ...this.domainInstructions(
          organization.slug,
          organization.domain,
          organization.domainToken,
          verifiedAt,
        ),
      };
    }

    return {
      verified: false as const,
      checks: { txt, cname },
      ...this.domainInstructions(
        organization.slug,
        organization.domain,
        organization.domainToken,
        null,
      ),
    };
  }

  /** Desconecta el dominio y borra el token. */
  async removeDomain(organizationId: string | null) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { domain: null, domainToken: null, domainVerifiedAt: null },
    });

    return { ok: true };
  }

  /**
   * Resuelve un negocio por su dominio propio **verificado**.
   *
   * Solo devuelve datos públicos. Un dominio pendiente no resuelve: si no, se
   * podría reclamar el de otra persona y recibir su tráfico.
   */
  async tenantByDomain(rawHost: string) {
    const host = (rawHost ?? '')
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '')
      .replace(/\.$/, '');

    if (!isValidDomain(host)) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const organization = await this.prisma.organization.findFirst({
      where: {
        domain: host,
        domainVerifiedAt: { not: null },
        isActive: true,
      },
      select: {
        name: true,
        slug: true,
        brandColor: true,
        logoUrl: true,
        address: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!organization) {
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
      domainToken: organization.domainToken ?? null,
      domainVerifiedAt: organization.domainVerifiedAt?.toISOString() ?? null,
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
