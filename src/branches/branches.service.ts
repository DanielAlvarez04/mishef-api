import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isEmptyPatch } from '../common/patch';
import { BRANCH_LIMITS } from './branch-limits';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string | null, userId: string | null = null) {
    if (!organizationId) {
      return [];
    }

    // Un miembro asignado a una sucursal sólo ve la suya; el resto ve todas.
    const membership = userId
      ? await this.prisma.membership.findUnique({
          where: {
            userId_organizationId: { userId, organizationId },
          },
          select: { branchId: true },
        })
      : null;

    const branches = await this.prisma.branch.findMany({
      where: {
        organizationId,
        ...(membership?.branchId ? { id: membership.branchId } : {}),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { memberships: { where: { isActive: true } } },
        },
      },
    });

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      isActive: branch.isActive,
      userCount: branch._count.memberships,
      createdAt: branch.createdAt,
    }));
  }

  async create(organizationId: string | null, dto: CreateBranchDto) {
    const orgId = this.requireOrganization(organizationId);
    const name = dto.name.trim();

    const existing = await this.prisma.branch.findUnique({
      where: { organizationId_name: { organizationId: orgId, name } },
    });

    if (existing) {
      throw new ConflictException('Ya existe una sucursal con ese nombre');
    }

    await this.assertWithinLimit(orgId);

    const branch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.branch.create({
        data: {
          organizationId: orgId,
          name,
          address: dto.address?.trim() || null,
          phone: dto.phone?.trim() || null,
        },
      });

      // La intención del onboarding y la realidad de la base quedan alineadas.
      await tx.organization.update({
        where: { id: orgId },
        data: { hasBranches: true },
      });

      return created;
    });

    return this.serialize(branch);
  }

  async update(
    organizationId: string | null,
    id: string,
    dto: UpdateBranchDto,
  ) {
    const orgId = this.requireOrganization(organizationId);
    const branch = await this.getBranch(orgId, id);

    const data: {
      name?: string;
      address?: string | null;
      phone?: string | null;
      isActive?: boolean;
    } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();

      if (name !== branch.name) {
        const existing = await this.prisma.branch.findUnique({
          where: { organizationId_name: { organizationId: orgId, name } },
        });

        if (existing && existing.id !== branch.id) {
          throw new ConflictException('Ya existe una sucursal con ese nombre');
        }

        data.name = name;
      }
    }

    if (dto.address !== undefined) {
      const address = dto.address.trim() || null;
      if (address !== branch.address) data.address = address;
    }

    if (dto.phone !== undefined) {
      const phone = dto.phone.trim() || null;
      if (phone !== branch.phone) data.phone = phone;
    }

    if (dto.isActive !== undefined && dto.isActive !== branch.isActive) {
      if (dto.isActive && !branch.isActive) {
        await this.assertWithinLimit(orgId, branch.id);
      }
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) {
      return this.serialize(branch);
    }

    const updated = await this.prisma.branch.update({
      where: { id: branch.id },
      data,
    });

    return this.serialize(updated);
  }

  /** Las sucursales no se borran: se desactivan para conservar su historial. */
  async deactivate(organizationId: string | null, id: string) {
    const orgId = this.requireOrganization(organizationId);
    const branch = await this.getBranch(orgId, id);

    const updated = await this.prisma.branch.update({
      where: { id: branch.id },
      data: { isActive: false },
    });

    return this.serialize(updated);
  }

  private requireOrganization(organizationId: string | null): string {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }
    return organizationId;
  }

  private async getBranch(organizationId: string, id: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId },
    });

    if (!branch) {
      throw new NotFoundException('Sucursal no encontrada');
    }

    return branch;
  }

  private async assertWithinLimit(organizationId: string, exceptId?: string) {
    const active = await this.prisma.branch.count({
      where: {
        organizationId,
        isActive: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });

    if (active >= BRANCH_LIMITS.maxActiveBranches) {
      throw new BadRequestException(
        `Puedes tener hasta ${BRANCH_LIMITS.maxActiveBranches} sucursales activas. Desactiva una para crear otra.`,
      );
    }
  }

  private serialize(branch: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    isActive: boolean;
    createdAt: Date;
  }) {
    return {
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      isActive: branch.isActive,
      createdAt: branch.createdAt,
    };
  }
}
