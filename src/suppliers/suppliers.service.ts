import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  isEmptyPatch,
  sameDecimal,
  sameStringSet,
} from '../common/patch';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeName } from '../uploads/r2';
import {
  CreateSupplierDto,
  CreateSupplierProductDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

function cleanAliases(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ).slice(0, 30);
}

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    organizationId: string,
    search?: string,
    includeInactive = false,
  ) {
    const term = search?.trim();

    return this.prisma.supplier.findMany({
      where: {
        organizationId,
        ...(includeInactive ? {} : { isActive: true }),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { rfc: { contains: term, mode: 'insensitive' } },
                { aliases: { has: term } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        rfc: true,
        aliases: true,
        defaultTaxRate: true,
        isActive: true,
        createdAt: true,
        _count: { select: { products: true, purchases: true } },
      },
    });
  }

  async create(organizationId: string, userId: string, dto: CreateSupplierDto) {
    const name = dto.name.trim();
    const aliases = cleanAliases(dto.aliases);

    try {
      const supplier = await this.prisma.supplier.create({
        data: {
          organizationId,
          name,
          rfc: dto.rfc?.trim().toUpperCase() || null,
          aliases,
          defaultTaxRate:
            dto.defaultTaxRate === undefined
              ? null
              : new Prisma.Decimal(dto.defaultTaxRate),
        },
      });

      await this.audit(organizationId, userId, 'SUPPLIER_CREATED', supplier.id, {
        name,
      });

      return supplier;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un proveedor con ese nombre');
      }

      throw error;
    }
  }

  async update(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdateSupplierDto,
  ) {
    const current = await this.getSupplier(organizationId, id);

    const data: Prisma.SupplierUpdateInput = {};

    if (dto.name !== undefined && dto.name.trim() !== current.name) {
      data.name = dto.name.trim();
    }

    if (dto.rfc !== undefined) {
      const rfc = dto.rfc?.trim().toUpperCase() || null;
      if (rfc !== current.rfc) data.rfc = rfc;
    }

    if (dto.aliases !== undefined) {
      const aliases = cleanAliases(dto.aliases);
      if (!sameStringSet(current.aliases, aliases)) data.aliases = aliases;
    }

    if (dto.defaultTaxRate !== undefined) {
      if (!sameDecimal(current.defaultTaxRate, dto.defaultTaxRate)) {
        data.defaultTaxRate =
          dto.defaultTaxRate === null
            ? null
            : new Prisma.Decimal(dto.defaultTaxRate);
      }
    }

    if (dto.isActive !== undefined && dto.isActive !== current.isActive) {
      data.isActive = dto.isActive;
    }

    if (isEmptyPatch(data)) {
      return current;
    }

    try {
      const supplier = await this.prisma.supplier.update({
        where: { id: current.id },
        data,
      });

      await this.audit(
        organizationId,
        userId,
        'SUPPLIER_UPDATED',
        supplier.id,
        JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue,
      );

      return supplier;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un proveedor con ese nombre');
      }

      throw error;
    }
  }

  async deactivate(organizationId: string, userId: string, id: string) {
    const current = await this.getSupplier(organizationId, id);

    if (!current.isActive) {
      return current;
    }

    const supplier = await this.prisma.supplier.update({
      where: { id: current.id },
      data: { isActive: false },
    });

    await this.audit(organizationId, userId, 'SUPPLIER_DEACTIVATED', supplier.id, {
      name: supplier.name,
    });

    return supplier;
  }

  async listProducts(organizationId: string, supplierId: string) {
    await this.getSupplier(organizationId, supplierId);

    return this.prisma.supplierProduct.findMany({
      where: { supplierId },
      orderBy: { rawName: 'asc' },
      include: {
        ingredient: {
          select: { id: true, name: true, displayUnit: true },
        },
      },
    });
  }

  async createProduct(
    organizationId: string,
    userId: string,
    supplierId: string,
    dto: CreateSupplierProductDto,
  ) {
    const supplier = await this.getSupplier(organizationId, supplierId);

    if (dto.ingredientId) {
      const ingredient = await this.prisma.ingredient.findFirst({
        where: {
          id: dto.ingredientId,
          organizationId: organizationId,
          isActive: true,
        },
        select: { id: true },
      });

      if (!ingredient) {
        throw new NotFoundException('Ingrediente no encontrado');
      }
    }

    const rawName = dto.rawName.trim();
    const normalizedName = normalizeName(rawName);

    const product = await this.prisma.supplierProduct.upsert({
      where: {
        supplierId_normalizedName: {
          supplierId: supplier.id,
          normalizedName,
        },
      },
      create: {
        supplierId: supplier.id,
        rawName,
        normalizedName,
        ingredientId: dto.ingredientId ?? null,
        quantity: new Prisma.Decimal(dto.quantity),
        unit: dto.unit,
        lastUnitCostGross:
          dto.lastUnitCostGross === undefined
            ? null
            : new Prisma.Decimal(dto.lastUnitCostGross),
      },
      update: {
        rawName,
        ingredientId: dto.ingredientId ?? null,
        quantity: new Prisma.Decimal(dto.quantity),
        unit: dto.unit,
        ...(dto.lastUnitCostGross === undefined
          ? {}
          : { lastUnitCostGross: new Prisma.Decimal(dto.lastUnitCostGross) }),
      },
    });

    await this.audit(
      organizationId,
      userId,
      'SUPPLIER_PRODUCT_MAPPED',
      supplier.id,
      {
        rawName,
        ingredientId: dto.ingredientId ?? null,
        quantity: dto.quantity,
        unit: dto.unit,
      },
    );

    return product;
  }

  async deleteProduct(
    organizationId: string,
    userId: string,
    supplierId: string,
    productId: string,
  ) {
    const supplier = await this.getSupplier(organizationId, supplierId);

    const product = await this.prisma.supplierProduct.findFirst({
      where: { id: productId, supplierId: supplier.id },
    });

    if (!product) {
      throw new NotFoundException('Producto del proveedor no encontrado');
    }

    await this.prisma.supplierProduct.delete({ where: { id: product.id } });

    await this.audit(
      organizationId,
      userId,
      'SUPPLIER_PRODUCT_DELETED',
      supplier.id,
      { rawName: product.rawName },
    );

    return { deleted: true };
  }

  private async getSupplier(organizationId: string, id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, organizationId },
    });

    if (!supplier) {
      throw new NotFoundException('Proveedor no encontrado');
    }

    return supplier;
  }

  private async audit(
    organizationId: string,
    userId: string,
    action: string,
    entityId: string,
    newValues: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action,
        entity: 'Supplier',
        entityId,
        newValues,
      },
    });
  }
}
