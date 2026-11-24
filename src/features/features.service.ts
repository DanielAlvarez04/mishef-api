import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  DEFAULT_FEATURES,
  FEATURE_KEYS,
  isFeatureEnabled,
  normalizeFeatureOverrides,
} from '../common/features';
import { PrismaService } from '../prisma/prisma.service';

/** Vigencia corta: el interceptor consulta en cada petición autenticada. */
const CACHE_TTL_MS = 30_000;

interface FeatureCacheEntry {
  at: number;
  features: Record<string, boolean>;
}

/** Los overrides son un mapa: el orden de las claves no cuenta como cambio. */
function sameOverrides(
  current: Record<string, boolean>,
  next: Record<string, boolean>,
): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  return [...keys].every((key) => current[key] === next[key]);
}

@Injectable()
export class FeaturesService {
  private readonly cache = new Map<string, FeatureCacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Funciones efectivas de una organización.
   *
   * Precedencia: override de la organización > default global.
   */
  async getEffective(organizationId: string): Promise<Record<string, boolean>> {
    const cached = this.cache.get(organizationId);

    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.features;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { featureOverrides: true },
    });

    if (!organization) return { ...DEFAULT_FEATURES };

    const overrides = normalizeFeatureOverrides(organization.featureOverrides);
    const features = { ...DEFAULT_FEATURES, ...overrides };

    this.cache.set(organizationId, { at: Date.now(), features });

    return features;
  }

  async isEnabled(
    organizationId: string,
    feature: string,
  ): Promise<boolean> {
    if (!FEATURE_KEYS.has(feature)) return true;

    const features = await this.getEffective(organizationId);
    return isFeatureEnabled(features, feature);
  }

  async getOverrides(organizationId: string): Promise<Record<string, boolean>> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { featureOverrides: true },
    });

    return normalizeFeatureOverrides(organization?.featureOverrides);
  }

  async listOrganizations() {
    const organizations = await this.prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        featureOverrides: true,
      },
      orderBy: { name: 'asc' },
      take: 500,
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      overrides: normalizeFeatureOverrides(organization.featureOverrides),
    }));
  }

  async setOverrides(
    organizationId: string,
    input: unknown,
    actorUserId: string,
  ): Promise<Record<string, boolean>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Los overrides deben ser un objeto');
    }

    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (!FEATURE_KEYS.has(key)) {
        throw new BadRequestException(`Función desconocida: ${key}`);
      }

      if (typeof value !== 'boolean') {
        throw new BadRequestException(`El valor de ${key} debe ser booleano`);
      }
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, featureOverrides: true },
    });

    if (!organization) {
      throw new BadRequestException('Organización no encontrada');
    }

    const overrides = normalizeFeatureOverrides(input);
    const current = normalizeFeatureOverrides(organization.featureOverrides);

    // Sin cambios reales no se toca `updatedAt` ni se ensucia la auditoría.
    if (sameOverrides(current, overrides)) {
      return this.getEffective(organizationId);
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        featureOverrides: overrides as Prisma.InputJsonValue,
      },
    });

    this.cache.delete(organizationId);

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: actorUserId,
        action: 'organization.features.updated',
        entity: 'Organization',
        entityId: organizationId,
        oldValues: current as Prisma.InputJsonValue,
        newValues: overrides as Prisma.InputJsonValue,
      },
    });

    return this.getEffective(organizationId);
  }
}
