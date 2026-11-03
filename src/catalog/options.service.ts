import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateOptionGroupDto,
  OptionValueInputDto,
  UpdateOptionGroupDto,
  UpdateOptionValueDto,
} from './dto/option.dto';
import { OPTION_GROUP_PRESETS, type OptionGroupPreset } from './option-presets';

const groupInclude = {
  values: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
  _count: { select: { itemGroups: true } },
} satisfies Prisma.OptionGroupInclude;

@Injectable()
export class OptionsService {
  constructor(private readonly prisma: PrismaService) {}

  presets(): OptionGroupPreset[] {
    return OPTION_GROUP_PRESETS;
  }

  /**
   * Activa/desactiva los grupos core sugeridos para la organización.
   *
   * Las plantillas siguen viviendo en código; el flag solo controla si se
   * ofrecen como sugerencia en el editor de artículos.
   */
  async setCoreActive(organizationId: string | null, isActive: boolean) {
    if (!organizationId) {
      return { ok: true, updated: 0 };
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { useCoreOptionGroups: true },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    if (organization.useCoreOptionGroups === isActive) {
      return { ok: true, updated: 0 };
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { useCoreOptionGroups: isActive },
    });

    return { ok: true, updated: 1 };
  }

  list(organizationId: string | null) {
    return this.prisma.optionGroup.findMany({
      where: { organizationId },
      include: groupInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(organizationId: string | null, dto: CreateOptionGroupDto) {
    const values = (dto.values ?? []).map((value, index) =>
      this.valueData(value, index),
    );

    this.assertUniqueNames(values.map((value) => value.name));

    try {
      return await this.prisma.optionGroup.create({
        data: {
          organizationId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          sortOrder: dto.sortOrder ?? 0,
          values: { create: values },
        },
        include: groupInclude,
      });
    } catch (error) {
      this.rethrowUnique(error, 'Ya existe un grupo de opciones con ese nombre');
    }
  }

  async update(
    organizationId: string | null,
    id: string,
    dto: UpdateOptionGroupDto,
  ) {
    await this.assertGroup(organizationId, id);

    const data: Prisma.OptionGroupUpdateInput = {};

    if (dto.name !== undefined && dto.name.trim()) data.name = dto.name.trim();
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.optionGroup.update({
        where: { id },
        data,
        include: groupInclude,
      });
    } catch (error) {
      this.rethrowUnique(error, 'Ya existe un grupo de opciones con ese nombre');
    }
  }

  async deactivate(organizationId: string | null, id: string) {
    await this.assertGroup(organizationId, id);

    return this.prisma.optionGroup.update({
      where: { id },
      data: { isActive: false },
      include: groupInclude,
    });
  }

  async createValue(
    organizationId: string | null,
    groupId: string,
    dto: OptionValueInputDto,
  ) {
    await this.assertGroup(organizationId, groupId);

    try {
      return await this.prisma.optionValue.create({
        data: { groupId, ...this.valueData(dto) },
      });
    } catch (error) {
      this.rethrowUnique(
        error,
        'Ya existe un valor con ese nombre en el grupo',
      );
    }
  }

  async updateValue(
    organizationId: string | null,
    groupId: string,
    valueId: string,
    dto: UpdateOptionValueDto,
  ) {
    await this.assertGroup(organizationId, groupId);
    await this.assertValue(groupId, valueId);

    const data: Prisma.OptionValueUpdateInput = {};

    if (dto.name !== undefined && dto.name.trim()) data.name = dto.name.trim();
    if (dto.kitchenLabel !== undefined) {
      data.kitchenLabel = dto.kitchenLabel?.trim() || null;
    }
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.optionValue.update({
        where: { id: valueId },
        data,
      });
    } catch (error) {
      this.rethrowUnique(
        error,
        'Ya existe un valor con ese nombre en el grupo',
      );
    }
  }

  async deactivateValue(
    organizationId: string | null,
    groupId: string,
    valueId: string,
  ) {
    await this.assertGroup(organizationId, groupId);
    await this.assertValue(groupId, valueId);

    return this.prisma.optionValue.update({
      where: { id: valueId },
      data: { isActive: false },
    });
  }

  private valueData(value: OptionValueInputDto, index?: number) {
    return {
      name: value.name.trim(),
      kitchenLabel: value.kitchenLabel?.trim() || null,
      sortOrder: value.sortOrder ?? index ?? 0,
    };
  }

  private assertUniqueNames(names: string[]) {
    const seen = new Set<string>();

    for (const name of names) {
      const key = name.toLowerCase();

      if (seen.has(key)) {
        throw new BadRequestException(
          'No puede haber dos valores con el mismo nombre en el grupo',
        );
      }

      seen.add(key);
    }
  }

  private async assertGroup(organizationId: string | null, id: string) {
    const group = await this.prisma.optionGroup.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });

    if (!group) {
      throw new NotFoundException('Grupo de opciones no encontrado');
    }

    return group;
  }

  private async assertValue(groupId: string, valueId: string) {
    const value = await this.prisma.optionValue.findFirst({
      where: { id: valueId, groupId },
      select: { id: true },
    });

    if (!value) {
      throw new NotFoundException('Valor de opción no encontrado');
    }

    return value;
  }

  private rethrowUnique(error: unknown, message: string): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }

    throw error;
  }
}
