import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WasteReason } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma/prisma.service';
import {
  sameDimension,
  toCanonicalQuantity,
  toMoney,
} from '../common/units';
import {
  IMAGE_CONTENT_TYPES,
  publicUrlForKey,
  r2Bucket,
  r2Client,
} from '../uploads/r2';
import { CreateWasteDto } from './dto/waste.dto';

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class WasteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Firma la subida de la foto de la merma.
   *
   * Va a `{org}/waste/` en el bucket público, con el mismo formato que el resto
   * de imágenes: la clave se guarda y la URL se arma al leer.
   */
  async presignPhoto(organizationId: string | null, contentType: string) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const ext =
      IMAGE_CONTENT_TYPES[contentType as keyof typeof IMAGE_CONTENT_TYPES];

    if (!ext) {
      throw new BadRequestException(
        'La foto debe ser JPEG, PNG o WebP',
      );
    }

    const key = `${organizationId}/waste/${randomUUID()}.${ext}`;

    const uploadUrl = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({
        Bucket: r2Bucket(),
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 300 },
    );

    return { key, uploadUrl, publicUrl: publicUrlForKey(key) };
  }

  async create(
    organizationId: string | null,
    userId: string,
    branchId: string | null,
    dto: CreateWasteDto,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const rawQuantity = new Prisma.Decimal(dto.quantity);

    if (rawQuantity.isNegative() || rawQuantity.isZero()) {
      throw new BadRequestException('La cantidad debe ser mayor que cero');
    }

    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: dto.ingredientId, organizationId },
      select: {
        id: true,
        name: true,
        displayUnit: true,
        unitCost: true,
      },
    });

    if (!ingredient) {
      throw new NotFoundException('Insumo no encontrado');
    }

    const unit = dto.unit ?? ingredient.displayUnit;

    if (!sameDimension(unit, ingredient.displayUnit)) {
      throw new BadRequestException(
        'La unidad no corresponde al insumo (peso, volumen o pieza)',
      );
    }

    const quantity = toCanonicalQuantity(rawQuantity, unit);
    const unitCost = ingredient.unitCost ?? new Prisma.Decimal(0);
    const cost = toMoney(quantity.times(unitCost));

    const waste = await this.prisma.waste.create({
      data: {
        organizationId,
        branchId,
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        quantity,
        displayUnit: ingredient.displayUnit,
        reason: dto.reason,
        note: dto.note?.trim() || null,
        cost,
        photoKey: dto.photoKey?.trim() || null,
        photoUrl: dto.photoKey?.trim()
          ? publicUrlForKey(dto.photoKey.trim())
          : null,
        userId,
      },
    });

    return {
      ...waste,
      quantity: waste.quantity.toString(),
      cost: waste.cost.toString(),
    };
  }

  /**
   * Mermas del periodo con totales por motivo.
   *
   * El costo se congeló al registrar: si el insumo cambia de precio, el
   * histórico no se altera.
   */
  async list(
    organizationId: string | null,
    branchId: string | null,
    from?: string,
    to?: string,
  ) {
    if (!organizationId) {
      return { items: [], total: 0, byReason: [] };
    }

    const start = from ? new Date(from) : null;
    const end = to ? new Date(to) : null;

    if (end) end.setHours(23, 59, 59, 999);

    const wastes = await this.prisma.waste.findMany({
      where: {
        organizationId,
        ...(branchId ? { branchId } : {}),
        ...(start || end
          ? {
              createdAt: {
                ...(start ? { gte: start } : {}),
                ...(end ? { lte: end } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        ingredientName: true,
        quantity: true,
        displayUnit: true,
        reason: true,
        note: true,
        cost: true,
        photoUrl: true,
        createdAt: true,
        user: { select: { id: true, name: true, username: true } },
      },
    });

    const byReason = new Map<WasteReason, { count: number; cost: number }>();
    let total = 0;

    const items = wastes.map((waste) => {
      const cost = Number(waste.cost);
      total += cost;

      const row = byReason.get(waste.reason) ?? { count: 0, cost: 0 };
      row.count += 1;
      row.cost += cost;
      byReason.set(waste.reason, row);

      return {
        ...waste,
        quantity: waste.quantity.toString(),
        cost: round2(cost),
        createdAt: waste.createdAt.toISOString(),
      };
    });

    return {
      items,
      total: round2(total),
      byReason: [...byReason.entries()].map(([reason, row]) => ({
        reason,
        count: row.count,
        cost: round2(row.cost),
      })),
    };
  }
}
