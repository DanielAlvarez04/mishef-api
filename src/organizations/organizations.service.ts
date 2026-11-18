import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { CloudflareHostnamesService } from './cloudflare-hostnames.service';
import { StorageService } from '../storage/storage.service';

/** Resultado de una búsqueda de dirección (Nominatim/OpenStreetMap). */
export interface LocationSearchResult {
  label: string;
  latitude: number;
  longitude: number;
  type: string | null;
}

const LOCATION_CACHE_TTL_MS = 5 * 60 * 1000;
const locationCache = new Map<
  string,
  { expires: number; data: LocationSearchResult[] }
>();
let lastNominatimRequest = 0;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hostnames: CloudflareHostnamesService,
    private readonly storage: StorageService,
  ) {}

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
      customDomainEnabled: organization.customDomainEnabled ?? false,
      slugChanges: organization.slugChanges ?? 0,
      storage: await this.storage.usage(organizationId),
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

  /**
   * Busca direcciones reales con OpenStreetMap (Nominatim).
   *
   * Se usa para que el dueño elija su local en un mapa en vez de teclear
   * coordenadas. Se limita a México, se cachea 5 minutos y se respeta el
   * límite de 1 petición por segundo de Nominatim. Si el servicio falla, la
   * búsqueda devuelve una lista vacía: nunca bloquea el guardado manual.
   */
  async searchLocation(rawQuery: string): Promise<LocationSearchResult[]> {
    const query = (rawQuery ?? '').trim().slice(0, 120);

    if (query.length < 3) return [];

    const cacheKey = query.toLowerCase();
    const cached = locationCache.get(cacheKey);

    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    const wait = Math.max(0, 1000 - (Date.now() - lastNominatimRequest));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastNominatimRequest = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '5');
    url.searchParams.set('countrycodes', 'mx');
    url.searchParams.set('addressdetails', '1');

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mishef/1.0 (https://mishef.co)',
          'Accept-Language': 'es',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return [];

      const rows = (await response.json()) as Array<{
        display_name?: string;
        lat?: string;
        lon?: string;
        type?: string;
      }>;

      const data = rows
        .map((row) => ({
          label: row.display_name?.trim() ?? '',
          latitude: Number(row.lat),
          longitude: Number(row.lon),
          type: row.type ?? null,
        }))
        .filter(
          (row) =>
            row.label.length > 0 &&
            Number.isFinite(row.latitude) &&
            Number.isFinite(row.longitude),
        );

      if (locationCache.size > 200) locationCache.clear();
      locationCache.set(cacheKey, {
        expires: Date.now() + LOCATION_CACHE_TTL_MS,
        data,
      });

      return data;
    } catch {
      return [];
    }
  }

  /** Comprueba si un dominio puede usarlo la organización (es único global). */
  async domainAvailable(rawDomain: string) {    const domain = normalizeDomain(rawDomain ?? '');

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

    const [existing, alias] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
      }),
      this.prisma.slugAlias.findUnique({
        where: { slug },
        select: { organizationId: true },
      }),
    ]);

    if (existing || alias) {
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

      const [existing, alias] = await Promise.all([
        this.prisma.organization.findUnique({
          where: { slug: candidate },
          select: { id: true },
        }),
        this.prisma.slugAlias.findUnique({
          where: { slug: candidate },
          select: { slug: true },
        }),
      ]);

      if (!existing && !alias) {
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

    const select = {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      brandColor: true,
      logoUrl: true,
      address: true,
      latitude: true,
      longitude: true,
    } as const;

    let organization = await this.prisma.organization.findUnique({
      where: { slug },
      select,
    });

    // Dirección anterior: se resuelve igual y la web redirige 301 a la nueva.
    if (!organization) {
      const alias = await this.prisma.slugAlias.findUnique({
        where: { slug },
        select: { organizationId: true },
      });

      if (alias) {
        organization = await this.prisma.organization.findUnique({
          where: { id: alias.organizationId },
          select,
        });
      }
    }

    if (!organization || !organization.isActive) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return {
      name: organization.name,
      slug: organization.slug,
      /** Dirección usada en la petición; si difiere, hay que redirigir. */
      requestedSlug: slug,
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

  /** Hostname público del fallback origin de Cloudflare for SaaS. */
  private get saasOrigin(): string {
    return (process.env.SAAS_FALLBACK_ORIGIN ?? 'saas.mishef.co')
      .trim()
      .toLowerCase();
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
      cname: { name: domain, value: this.saasOrigin },
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
        customDomainEnabled: true,
        subscription: { include: { plan: true } },
      },
    });

    if (!current) {
      throw new NotFoundException('Organización no encontrada');
    }

    if (
      !current.customDomainEnabled &&
      !current.subscription?.plan.customDomain
    ) {
      throw new ForbiddenException(
        'Tu plan no incluye dominio propio. Actualiza el plan para conectarlo.',
      );
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

    const expectedCname = this.saasOrigin;
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

      // Cloudflare for SaaS: al verificar, se registra el hostname para que el
      // certificado del dominio del cliente se emita solo.
      const providerId = await this.hostnames.create(organization.domain);

      await this.prisma.organization.update({
        where: { id: organizationId },
        data: {
          domainVerifiedAt: verifiedAt,
          ...(providerId ? { domainProviderId: providerId } : {}),
        },
      });

      return {
        verified: true as const,
        checks: { txt: true, cname: true },
        provider: providerId ? ('cloudflare' as const) : null,
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

    const current = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { domainProviderId: true },
    });

    if (current?.domainProviderId) {
      await this.hostnames.remove(current.domainProviderId);
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        domain: null,
        domainToken: null,
        domainVerifiedAt: null,
        domainProviderId: null,
      },
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

  /**
   * Cambia la dirección del negocio.
   *
   * Durante el onboarding (primera configuración) es libre; después solo se
   * permite **un** cambio. El slug anterior queda como alias para que los
   * enlaces y QR ya impresos sigan funcionando con un 301.
   */
  async changeSlug(
    organizationId: string | null,
    userId: string,
    rawSlug: string,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const [current, user] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          slug: true,
          slugChanges: true,
        },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { onboardedAt: true },
      }),
    ]);

    if (!current) {
      throw new NotFoundException('Organización no encontrada');
    }

    const slug = normalizeSlug(rawSlug ?? '');

    if (!isValidSlug(slug)) {
      throw new BadRequestException(
        'La dirección no es válida o está reservada',
      );
    }

    if (slug === current.slug) {
      throw new BadRequestException('Es la misma dirección que ya tienes');
    }

    // Primera configuración: el onboarding puede fijarla sin gastar el cambio.
    const isInitialSetup = !user?.onboardedAt;

    if (!isInitialSetup && current.slugChanges >= 1) {
      throw new ForbiddenException('Ya usaste tu cambio de dirección');
    }

    const [takenOrg, takenAlias] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
      }),
      this.prisma.slugAlias.findUnique({
        where: { slug },
        select: { organizationId: true },
      }),
    ]);

    if (takenOrg && takenOrg.id !== organizationId) {
      throw new ConflictException('Esa dirección ya está en uso');
    }

    if (takenAlias && takenAlias.organizationId !== organizationId) {
      throw new ConflictException('Esa dirección ya está en uso');
    }

    return this.prisma.$transaction(async (tx) => {
      // Volver a una dirección propia anterior: se borra el alias para no
      // crear un bucle de redirecciones.
      if (takenAlias?.organizationId === organizationId) {
        await tx.slugAlias.delete({ where: { slug } });
      }

      await tx.slugAlias.upsert({
        where: { slug: current.slug },
        create: { slug: current.slug, organizationId },
        update: {},
      });

      const updated = await tx.organization.update({
        where: { id: organizationId },
        data: {
          slug,
          ...(isInitialSetup ? {} : { slugChanges: { increment: 1 } }),
        },
        select: { slug: true, slugChanges: true },
      });

      await tx.auditLog.create({
        data: {
          organizationId,
          action: 'organization.slug_changed',
          entity: 'Organization',
          entityId: organizationId,
          oldValues: { slug: current.slug },
          newValues: { slug },
        },
      });

      return updated;
    });
  }

  async update(organizationId: string | null, dto: UpdateOrganizationDto) {    if (!organizationId) {
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
      customDomainEnabled: organization.customDomainEnabled ?? false,
      slugChanges: organization.slugChanges ?? 0,
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
