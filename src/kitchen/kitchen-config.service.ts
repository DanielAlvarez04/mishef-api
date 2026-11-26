import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KitchenMode,
  KitchenPositionLevel,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch, sameStringSet } from '../common/patch';
import {
  CreateKitchenCourseDto,
  CreateKitchenPositionDto,
  CreateKitchenRoutingDto,
  CreateKitchenStationDto,
  UpdateKitchenAssignmentDto,
  UpdateKitchenCourseDto,
  UpdateKitchenPositionDto,
  UpdateKitchenRoutingDto,
  UpdateKitchenStationDto,
} from './dto/kitchen-config.dto';

const ALL_PERMISSIONS = [
  'kitchen.view.all',
  'kitchen.view.station',
  'kitchen.transition.start',
  'kitchen.transition.ready',
  'kitchen.expo',
  'kitchen.void',
  'kitchen.refire',
  'kitchen.assign',
  'kitchen.settings',
  'kitchen.reports',
] as const;

const CHEF_PERMISSIONS = [...ALL_PERMISSIONS];
const SOUS_PERMISSIONS = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== 'kitchen.settings' && permission !== 'kitchen.assign',
);
const PARTIE_PERMISSIONS = [
  'kitchen.view.station',
  'kitchen.transition.start',
  'kitchen.transition.ready',
  'kitchen.reports',
];
const COOK_PERMISSIONS = [
  'kitchen.view.station',
  'kitchen.transition.start',
  'kitchen.transition.ready',
];
const COMMIS_PERMISSIONS = [
  'kitchen.view.station',
  'kitchen.transition.start',
  'kitchen.transition.ready',
];
const EXPO_PERMISSIONS = [
  'kitchen.view.all',
  'kitchen.expo',
  'kitchen.reports',
];
const TOURNANT_PERMISSIONS = [
  'kitchen.view.all',
  'kitchen.transition.start',
  'kitchen.transition.ready',
];

/**
 * Presets de puestos de cocina. Los nombres visibles van en español; los
 * códigos se conservan como identificadores internos y para no romper datos.
 */
const PRESETS: Array<{
  code: string;
  name: string;
  level: KitchenPositionLevel;
  permissions: string[];
}> = [
  {
    code: 'CHEF_DE_CUISINE',
    name: 'Jefe de cocina',
    level: KitchenPositionLevel.MANAGEMENT,
    permissions: CHEF_PERMISSIONS,
  },
  {
    code: 'SOUS_CHEF',
    name: 'Subjefe de cocina',
    level: KitchenPositionLevel.MANAGEMENT,
    permissions: SOUS_PERMISSIONS,
  },
  {
    code: 'CHEF_DE_PARTIE',
    name: 'Jefe de partida',
    level: KitchenPositionLevel.CHEF_DE_PARTIE,
    permissions: PARTIE_PERMISSIONS,
  },
  {
    code: 'CUISINIER',
    name: 'Cocinero',
    level: KitchenPositionLevel.COOK,
    permissions: COOK_PERMISSIONS,
  },
  {
    code: 'COMMIS',
    name: 'Asistente de cocina',
    level: KitchenPositionLevel.ASSISTANT,
    permissions: COMMIS_PERMISSIONS,
  },
  {
    code: 'TOURNANT',
    name: 'Rondador',
    level: KitchenPositionLevel.COOK,
    permissions: TOURNANT_PERMISSIONS,
  },
  {
    code: 'ABOYEUR',
    name: 'Camarero de pase',
    level: KitchenPositionLevel.EXPO,
    permissions: EXPO_PERMISSIONS,
  },
];

@Injectable()
export class KitchenConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async config(organizationId: string | null, branchId: string | null) {
    const orgId = this.requireOrganization(organizationId);
    const branch = branchId
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, organizationId: orgId },
          select: { id: true, name: true, kitchenMode: true },
        })
      : null;

    if (branchId && !branch) {
      throw new NotFoundException('Sucursal no encontrada');
    }

    const effectiveBranchId = branch?.id ?? null;
    const [stations, positions, members, routing, courses] = await Promise.all([
      this.prisma.kitchenStation.findMany({
        where: { organizationId: orgId, branchId: effectiveBranchId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.kitchenPosition.findMany({
        where: { organizationId: orgId },
        orderBy: [{ level: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.membership.findMany({
        where: { organizationId: orgId, isActive: true },
        orderBy: [{ isOwner: 'desc' }, { username: 'asc' }],
        select: {
          id: true,
          username: true,
          roles: true,
          kitchenPositionId: true,
          user: { select: { name: true, email: true } },
          kitchenAssignments: {
            select: { stationId: true, isPrimary: true },
          },
        },
      }),
      this.prisma.kitchenStationRule.findMany({
        where: { organizationId: orgId, branchId: effectiveBranchId },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        include: {
          station: { select: { id: true, name: true, code: true, color: true } },
          item: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          menu: { select: { id: true, name: true } },
        },
      }),
      this.prisma.kitchenCourse.findMany({
        where: { organizationId: orgId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      mode: branch?.kitchenMode ?? KitchenMode.GENERAL,
      branch: branch ? { id: branch.id, name: branch.name } : null,
      stations,
      positions,
      members: members.map((member) => ({
        id: member.id,
        username: member.username,
        name: member.user.name,
        email: member.user.email,
        roles: member.roles,
        kitchenPositionId: member.kitchenPositionId,
        stationIds: member.kitchenAssignments.map(
          (assignment) => assignment.stationId,
        ),
      })),
      routing,
      courses,
    };
  }

  async updateMode(
    organizationId: string | null,
    branchId: string | null,
    mode: KitchenMode,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const branch = await this.requireBranch(orgId, branchId);

    if (branch.kitchenMode === mode) {
      return { mode, branchId: branch.id };
    }

    await this.prisma.branch.update({
      where: { id: branch.id },
      data: { kitchenMode: mode },
    });

    if (mode === KitchenMode.ADVANCED) {
      await this.seedPresets(orgId);

      const stationCount = await this.prisma.kitchenStation.count({
        where: { organizationId: orgId, branchId: branch.id },
      });

      if (stationCount === 0) {
        await this.prisma.kitchenStation.create({
          data: {
            organizationId: orgId,
            branchId: branch.id,
            name: 'Cocina',
            code: 'COCINA',
            sortOrder: 0,
          },
        });
      }
    }

    return { mode, branchId: branch.id };
  }

  async seedPresets(organizationId: string | null) {
    const orgId = this.requireOrganization(organizationId);

    await this.prisma.kitchenPosition.createMany({
      data: PRESETS.map((preset) => ({
        organizationId: orgId,
        code: preset.code,
        name: preset.name,
        level: preset.level,
        permissions: preset.permissions,
        isSystemPreset: true,
      })),
      skipDuplicates: true,
    });

    return this.prisma.kitchenPosition.findMany({
      where: { organizationId: orgId },
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
    });
  }

  // --------------------------------------------------------------------------
  // Estaciones
  // --------------------------------------------------------------------------

  async createStation(
    organizationId: string | null,
    branchId: string | null,
    dto: CreateKitchenStationDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const resolvedBranchId = branchId
      ? (await this.requireBranch(orgId, branchId)).id
      : null;
    const name = dto.name.trim();
    const code = this.normalizeCode(dto.code ?? name);

    const duplicate = await this.prisma.kitchenStation.findFirst({
      where: {
        organizationId: orgId,
        branchId: resolvedBranchId,
        code,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException('Ya existe una estación con ese código');
    }

    return this.prisma.kitchenStation.create({
      data: {
        organizationId: orgId,
        branchId: resolvedBranchId,
        name,
        code,
        color: dto.color?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
        slaMinutes: dto.slaMinutes ?? null,
      },
    });
  }

  async updateStation(
    organizationId: string | null,
    id: string,
    dto: UpdateKitchenStationDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const station = await this.prisma.kitchenStation.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!station) throw new NotFoundException('Estación no encontrada');

    const data: Prisma.KitchenStationUpdateInput = {};
    const name = dto.name?.trim();
    const code = dto.code ? this.normalizeCode(dto.code) : undefined;

    if (name !== undefined && name !== station.name) data.name = name;
    if (code !== undefined && code !== station.code) data.code = code;
    if (dto.color !== undefined) {
      const color = dto.color?.trim() || null;
      if (color !== station.color) data.color = color;
    }
    if (
      dto.sortOrder !== undefined &&
      dto.sortOrder !== station.sortOrder
    ) {
      data.sortOrder = dto.sortOrder;
    }
    if (
      dto.slaMinutes !== undefined &&
      dto.slaMinutes !== station.slaMinutes
    ) {
      data.slaMinutes = dto.slaMinutes;
    }
    if (dto.isActive !== undefined && dto.isActive !== station.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) return station;

    if (data.code) {
      const duplicate = await this.prisma.kitchenStation.findFirst({
        where: {
          organizationId: orgId,
          branchId: station.branchId,
          code: String(data.code),
          NOT: { id },
        },
        select: { id: true },
      });

      if (duplicate) {
        throw new ConflictException('Ya existe una estación con ese código');
      }
    }

    return this.prisma.kitchenStation.update({
      where: { id },
      data,
    });
  }

  async deactivateStation(organizationId: string | null, id: string) {
    const orgId = this.requireOrganization(organizationId);
    const station = await this.prisma.kitchenStation.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!station) throw new NotFoundException('Estación no encontrada');
    if (!station.isActive) return station;

    return this.prisma.kitchenStation.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // --------------------------------------------------------------------------
  // Puestos
  // --------------------------------------------------------------------------

  async createPosition(
    organizationId: string | null,
    dto: CreateKitchenPositionDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const name = dto.name.trim();
    const code = this.normalizeCode(dto.code ?? name);

    const duplicate = await this.prisma.kitchenPosition.findFirst({
      where: { organizationId: orgId, code },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException('Ya existe un puesto con ese código');
    }

    return this.prisma.kitchenPosition.create({
      data: {
        organizationId: orgId,
        name,
        code,
        level: dto.level ?? KitchenPositionLevel.COOK,
        permissions: dto.permissions ?? [],
        isSystemPreset: false,
      },
    });
  }

  async updatePosition(
    organizationId: string | null,
    id: string,
    dto: UpdateKitchenPositionDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const position = await this.prisma.kitchenPosition.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!position) throw new NotFoundException('Puesto no encontrado');

    const data: Prisma.KitchenPositionUpdateInput = {};
    const name = dto.name?.trim();
    const code = dto.code ? this.normalizeCode(dto.code) : undefined;

    if (name !== undefined && name !== position.name) data.name = name;
    if (code !== undefined && code !== position.code) data.code = code;
    if (dto.level !== undefined && dto.level !== position.level) {
      data.level = dto.level;
    }
    if (
      dto.permissions !== undefined &&
      !sameStringSet(dto.permissions, position.permissions)
    ) {
      data.permissions = dto.permissions;
    }
    if (dto.isActive !== undefined && dto.isActive !== position.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) return position;

    return this.prisma.kitchenPosition.update({
      where: { id },
      data,
    });
  }

  async deactivatePosition(organizationId: string | null, id: string) {
    const orgId = this.requireOrganization(organizationId);
    const position = await this.prisma.kitchenPosition.findFirst({
      where: { id, organizationId: orgId },
      include: { _count: { select: { memberships: true } } },
    });

    if (!position) throw new NotFoundException('Puesto no encontrado');
    if (position._count.memberships > 0) {
      throw new ConflictException(
        'El puesto tiene miembros asignados; reasígnalos antes de desactivarlo',
      );
    }
    if (!position.isActive) return position;

    return this.prisma.kitchenPosition.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // --------------------------------------------------------------------------
  // Asignaciones
  // --------------------------------------------------------------------------

  async updateAssignment(
    organizationId: string | null,
    branchId: string | null,
    membershipId: string,
    dto: UpdateKitchenAssignmentDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: orgId, isActive: true },
      select: { id: true, kitchenPositionId: true },
    });

    if (!membership) throw new NotFoundException('Miembro no encontrado');

    if (dto.kitchenPositionId !== undefined && dto.kitchenPositionId) {
      const position = await this.prisma.kitchenPosition.findFirst({
        where: {
          id: dto.kitchenPositionId,
          organizationId: orgId,
          isActive: true,
        },
        select: { id: true },
      });

      if (!position) throw new NotFoundException('Puesto no encontrado');
    }

    const stationIds = [...new Set(dto.stationIds)];

    if (stationIds.length > 0) {
      const stations = await this.prisma.kitchenStation.findMany({
        where: {
          id: { in: stationIds },
          organizationId: orgId,
          isActive: true,
        },
        select: { id: true },
      });

      if (stations.length !== stationIds.length) {
        throw new BadRequestException(
          'Alguna estación no pertenece al negocio o está inactiva',
        );
      }
    }

    const nextPositionId = dto.kitchenPositionId ?? null;

    await this.prisma.$transaction(async (tx) => {
      if (nextPositionId !== membership.kitchenPositionId) {
        await tx.membership.update({
          where: { id: membershipId },
          data: { kitchenPositionId: nextPositionId },
        });
      }

      await tx.kitchenAssignment.deleteMany({
        where: { membershipId, organizationId: orgId },
      });

      if (stationIds.length > 0) {
        await tx.kitchenAssignment.createMany({
          data: stationIds.map((stationId, index) => ({
            organizationId: orgId,
            membershipId,
            stationId,
            isPrimary: index === 0,
          })),
        });
      }
    });

    return this.config(orgId, branchId);
  }

  // --------------------------------------------------------------------------
  // Ruteo
  // --------------------------------------------------------------------------

  async createRouting(
    organizationId: string | null,
    branchId: string | null,
    dto: CreateKitchenRoutingDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    await this.assertRoutingTarget(orgId, dto);
    const station = await this.assertStation(orgId, branchId, dto.stationId);

    return this.prisma.kitchenStationRule.create({
      data: {
        organizationId: orgId,
        branchId: station.branchId,
        stationId: station.id,
        itemId: dto.itemId ?? null,
        categoryId: dto.categoryId ?? null,
        menuId: dto.menuId ?? null,
        priority: dto.priority ?? 0,
      },
    });
  }

  async updateRouting(
    organizationId: string | null,
    id: string,
    dto: UpdateKitchenRoutingDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const rule = await this.prisma.kitchenStationRule.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!rule) throw new NotFoundException('Regla de ruteo no encontrada');

    const next = {
      stationId: dto.stationId ?? rule.stationId,
      itemId: dto.itemId !== undefined ? dto.itemId : rule.itemId,
      categoryId:
        dto.categoryId !== undefined ? dto.categoryId : rule.categoryId,
      menuId: dto.menuId !== undefined ? dto.menuId : rule.menuId,
      priority: dto.priority ?? rule.priority,
    };

    await this.assertRoutingTarget(orgId, next);
    const station = await this.assertStation(orgId, rule.branchId, next.stationId);

    const data: Prisma.KitchenStationRuleUpdateInput = {};
    if (station.id !== rule.stationId) {
      data.station = { connect: { id: station.id } };
    }
    if (next.itemId !== rule.itemId) {
      data.item = next.itemId
        ? { connect: { id: next.itemId } }
        : { disconnect: true };
    }
    if (next.categoryId !== rule.categoryId) {
      data.category = next.categoryId
        ? { connect: { id: next.categoryId } }
        : { disconnect: true };
    }
    if (next.menuId !== rule.menuId) {
      data.menu = next.menuId
        ? { connect: { id: next.menuId } }
        : { disconnect: true };
    }
    if (next.priority !== rule.priority) data.priority = next.priority;
    if (station.branchId !== rule.branchId) data.branchId = station.branchId;

    if (isEmptyPatch(data)) return rule;

    return this.prisma.kitchenStationRule.update({
      where: { id },
      data,
    });
  }

  async deleteRouting(organizationId: string | null, id: string) {
    const orgId = this.requireOrganization(organizationId);
    const rule = await this.prisma.kitchenStationRule.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });

    if (!rule) throw new NotFoundException('Regla de ruteo no encontrada');

    await this.prisma.kitchenStationRule.delete({ where: { id } });
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Cursos
  // --------------------------------------------------------------------------

  async createCourse(
    organizationId: string | null,
    dto: CreateKitchenCourseDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const name = dto.name.trim();

    const duplicate = await this.prisma.kitchenCourse.findFirst({
      where: { organizationId: orgId, name },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException('Ya existe un curso con ese nombre');
    }

    return this.prisma.kitchenCourse.create({
      data: {
        organizationId: orgId,
        name,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateCourse(
    organizationId: string | null,
    id: string,
    dto: UpdateKitchenCourseDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const course = await this.prisma.kitchenCourse.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!course) throw new NotFoundException('Curso no encontrado');

    const data: Prisma.KitchenCourseUpdateInput = {};
    const name = dto.name?.trim();

    if (name !== undefined && name !== course.name) data.name = name;
    if (
      dto.sortOrder !== undefined &&
      dto.sortOrder !== course.sortOrder
    ) {
      data.sortOrder = dto.sortOrder;
    }
    if (dto.isActive !== undefined && dto.isActive !== course.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) return course;

    return this.prisma.kitchenCourse.update({
      where: { id },
      data,
    });
  }

  async deactivateCourse(organizationId: string | null, id: string) {
    const orgId = this.requireOrganization(organizationId);
    const course = await this.prisma.kitchenCourse.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!course) throw new NotFoundException('Curso no encontrado');
    if (!course.isActive) return course;

    return this.prisma.kitchenCourse.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private requireOrganization(organizationId: string | null): string {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }
    return organizationId;
  }

  private async requireBranch(organizationId: string, branchId: string | null) {
    if (!branchId) {
      throw new BadRequestException('Selecciona una sucursal');
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId },
      select: { id: true, kitchenMode: true },
    });

    if (!branch) throw new NotFoundException('Sucursal no encontrada');
    return branch;
  }

  private normalizeCode(value: string): string {
    const normalized = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);

    if (!normalized) {
      throw new BadRequestException('El código no es válido');
    }

    return normalized;
  }

  private async assertStation(
    organizationId: string,
    branchId: string | null,
    stationId: string,
  ) {
    const station = await this.prisma.kitchenStation.findFirst({
      where: { id: stationId, organizationId, isActive: true },
      select: { id: true, branchId: true },
    });

    if (!station) {
      throw new NotFoundException('Estación no encontrada o inactiva');
    }

    if (branchId && station.branchId && station.branchId !== branchId) {
      throw new BadRequestException('La estación pertenece a otra sucursal');
    }

    return station;
  }

  private async assertRoutingTarget(
    organizationId: string,
    target: {
      itemId?: string | null;
      categoryId?: string | null;
      menuId?: string | null;
    },
  ) {
    const selected = [target.itemId, target.categoryId, target.menuId].filter(
      Boolean,
    );

    if (selected.length !== 1) {
      throw new BadRequestException(
        'La regla debe apuntar a un artículo, una categoría o un menú',
      );
    }

    if (target.itemId) {
      const item = await this.prisma.item.findFirst({
        where: { id: target.itemId, organizationId },
        select: { id: true },
      });
      if (!item) throw new NotFoundException('Artículo no encontrado');
    }

    if (target.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: target.categoryId, organizationId },
        select: { id: true },
      });
      if (!category) throw new NotFoundException('Categoría no encontrada');
    }

    if (target.menuId) {
      const menu = await this.prisma.menu.findFirst({
        where: { id: target.menuId, organizationId },
        select: { id: true },
      });
      if (!menu) throw new NotFoundException('Menú no encontrado');
    }
  }
}
