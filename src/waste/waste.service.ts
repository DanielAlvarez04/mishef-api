import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WasteReason, type Waste } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  sameDimension,
  toCanonicalQuantity,
  toMoney,
} from '../common/units';
import {
  IMAGE_CONTENT_TYPES,
  buildTempObjectKey,
  deleteR2Object,
  getR2Object,
  isTempObjectKey,
  maxUploadBytes,
  presignPutUrl,
  type ImageContentType,
} from '../uploads/r2';
import { imageFallbackUrl } from '../uploads/image-assets';
import {
  storeOptimizedImage,
  type StoredImage,
} from '../uploads/image-storage';
import { StorageService } from '../storage/storage.service';
import { CreateWasteDto } from './dto/waste.dto';

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class WasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Firma la subida de la foto de la merma.
   *
   * El original va a `{org}/tmp/` y al registrar la merma se optimiza igual
   * que el resto de imágenes (AVIF/JPEG 640 y 1280): en el bucket nunca queda
   * la foto original. La cuota se comprueba aquí con el tamaño que manda el
   * navegador y otra vez al guardar, con los bytes reales de las variantes.
   */
  async presignPhoto(
    organizationId: string | null,
    contentType: string,
    size = 0,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    await this.storage.assertWithinLimit(organizationId, size);

    const type = contentType as ImageContentType;

    if (!IMAGE_CONTENT_TYPES[type]) {
      throw new BadRequestException('La foto debe ser JPEG, PNG o WebP');
    }

    const key = buildTempObjectKey(organizationId, type);

    return {
      key,
      uploadUrl: await presignPutUrl(key, type),
    };
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

    const photoInputKey = dto.photoKey?.trim() || null;
    let photo: StoredImage | null = null;
    let photoBytes = 0;

    if (photoInputKey) {
      if (!isTempObjectKey(organizationId, photoInputKey)) {
        throw new BadRequestException('La foto no pertenece a este negocio');
      }

      const buffer = await getR2Object(photoInputKey);

      if (!buffer) {
        throw new BadRequestException(
          'La foto no se subió o ya no está disponible. Vuelve a intentarlo.',
        );
      }

      const maxBytes = maxUploadBytes();

      if (buffer.length > maxBytes) {
        await deleteR2Object(photoInputKey);
        throw new BadRequestException(
          `La foto supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
        );
      }

      try {
        // Igual que el catálogo: se generan AVIF/JPEG 640 y 1280. El original
        // temporal se borra siempre, incluso si la optimización falla.
        photo = await storeOptimizedImage(`${organizationId}/waste`, buffer);
      } finally {
        await deleteR2Object(photoInputKey);
      }

      try {
        await this.storage.assertWithinLimit(organizationId, photo.bytes);
      } catch (error) {
        // La imagen recién escrita no se ha contado: se borra sin descontar.
        await this.storage.releaseImage(null, photo.key);
        throw error;
      }

      photoBytes = photo.bytes;
    }

    let waste: Waste;

    try {
      waste = await this.prisma.waste.create({
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
          photoKey: photo?.key ?? null,
          photoUrl: photo ? imageFallbackUrl(photo.assets) : null,
          userId,
        },
      });
    } catch (error) {
      // Sin registro no hay quien referencie la imagen: se borra.
      if (photo) await this.storage.releaseImage(null, photo.key);
      throw error;
    }

    await this.storage.add(organizationId, photoBytes);

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
