import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MediaKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  deleteR2Object,
  objectSize,
  presignPutUrl,
  publicUrlForKey,
} from '../uploads/r2';
import {
  FinalizeMediaDto,
  MediaEntityDto,
  PresignMediaDto,
} from './dto/media.dto';

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export interface MediaLimits {
  maxImages: number;
  maxVideos: number;
}

export interface MediaAssetView {
  id: string;
  entityType: string;
  entityId: string;
  kind: MediaKind;
  url: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(organizationId: string, dto: MediaEntityDto) {
    const primary = await this.assertEntity(organizationId, dto);
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        organizationId,
        entityType: dto.entityType,
        entityId: dto.entityId,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return {
      assets: assets.map(toView),
      limits: await this.limits(organizationId),
      usage: {
        images:
          primary +
          assets.filter((asset) => asset.kind === MediaKind.IMAGE).length,
        videos: assets.filter((asset) => asset.kind === MediaKind.VIDEO).length,
      },
      primaryImageCount: primary,
    };
  }

  async presign(organizationId: string, dto: PresignMediaDto) {
    const primary = await this.assertEntity(organizationId, dto);
    const limits = await this.limits(organizationId);
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        organizationId,
        entityType: dto.entityType,
        entityId: dto.entityId,
      },
      select: { kind: true },
    });

    this.assertKindAllowed(dto.kind, dto.contentType, dto.size);
    this.assertLimit(dto.kind, primary, assets, limits);
    await this.storage.assertWithinLimit(organizationId, dto.size);

    const extension =
      dto.kind === MediaKind.IMAGE
        ? IMAGE_TYPES[dto.contentType]
        : VIDEO_TYPES[dto.contentType];
    const key = `${organizationId}/media/${dto.entityType.toLowerCase()}/${dto.entityId}/${randomUUID()}.${extension}`;
    const uploadUrl = await presignPutUrl(key, dto.contentType, 'public, max-age=31536000, immutable');

    return {
      uploadUrl,
      key,
      contentType: dto.contentType,
      kind: dto.kind,
    };
  }

  async finalize(organizationId: string, dto: FinalizeMediaDto) {
    const prefix = `${organizationId}/media/${dto.entityType.toLowerCase()}/${dto.entityId}/`;

    if (!dto.key.startsWith(prefix) || dto.key.includes('..')) {
      throw new BadRequestException('La clave del archivo no es válida');
    }

    const primary = await this.assertEntity(organizationId, dto);
    const limits = await this.limits(organizationId);
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        organizationId,
        entityType: dto.entityType,
        entityId: dto.entityId,
      },
      select: { kind: true },
    });

    this.assertKindAllowed(dto.kind, dto.contentType, 1);
    this.assertLimit(dto.kind, primary, assets, limits);

    const size = await objectSize(dto.key);

    if (size === null) {
      throw new NotFoundException('El archivo no se subió a R2');
    }

    const maxSize =
      dto.kind === MediaKind.IMAGE
        ? IMAGE_MAX_BYTES
        : this.videoMaxBytes();

    if (size > maxSize) {
      throw new PayloadTooLargeException(
        `El archivo supera el máximo permitido (${Math.round(maxSize / 1024 / 1024)} MB)`,
      );
    }

    await this.storage.assertWithinLimit(organizationId, size);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        organizationId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        kind: dto.kind,
        key: dto.key,
        url: publicUrlForKey(dto.key),
        name: dto.name?.trim() || null,
        mimeType: dto.contentType,
        sizeBytes: BigInt(size),
      },
    });

    await this.storage.add(organizationId, size);

    return toView(asset);
  }

  async remove(organizationId: string, id: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, organizationId },
    });

    if (!asset) throw new NotFoundException('Archivo no encontrado');

    await deleteR2Object(asset.key);

    if (asset.sizeBytes) {
      await this.storage.release(organizationId, Number(asset.sizeBytes));
    }

    await this.prisma.mediaAsset.delete({ where: { id: asset.id } });

    return { ok: true };
  }

  private async limits(organizationId: string): Promise<MediaLimits> {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    return {
      maxImages: subscription?.plan.maxImagesPerItem ?? 1,
      maxVideos: subscription?.plan.maxVideosPerItem ?? 0,
    };
  }

  /** Imagen principal existente (catálogo del artículo/receta). */
  private async assertEntity(
    organizationId: string,
    dto: MediaEntityDto,
  ): Promise<number> {
    if (dto.entityType === 'ITEM') {
      const item = await this.prisma.item.findFirst({
        where: { id: dto.entityId, organizationId },
        select: {
          catalogEntry: { select: { imageUrl: true } },
        },
      });

      if (!item) throw new NotFoundException('Artículo no encontrado');
      return item.catalogEntry?.imageUrl ? 1 : 0;
    }

    if (dto.entityType === 'RECIPE') {
      const recipe = await this.prisma.recipe.findFirst({
        where: { id: dto.entityId, organizationId },
        select: {
          catalogEntry: { select: { imageUrl: true } },
          item: {
            select: { catalogEntry: { select: { imageUrl: true } } },
          },
        },
      });

      if (!recipe) throw new NotFoundException('Receta no encontrada');
      return recipe.catalogEntry?.imageUrl || recipe.item?.catalogEntry?.imageUrl
        ? 1
        : 0;
    }

    if (dto.entityType === 'INGREDIENT') {
      const ingredient = await this.prisma.ingredient.findFirst({
        where: { id: dto.entityId, organizationId },
        select: { id: true },
      });

      if (!ingredient) throw new NotFoundException('Insumo no encontrado');
      return 0;
    }

    const menu = await this.prisma.menu.findFirst({
      where: { id: dto.entityId, organizationId },
      select: { id: true },
    });

    if (!menu) throw new NotFoundException('Menú no encontrado');
    return 0;
  }

  private assertKindAllowed(
    kind: MediaKind,
    contentType: string,
    size: number,
  ) {
    if (kind === MediaKind.IMAGE) {
      if (!IMAGE_TYPES[contentType]) {
        throw new BadRequestException(
          'Formato de imagen no permitido (JPG, PNG o WebP)',
        );
      }
      if (size > IMAGE_MAX_BYTES) {
        throw new PayloadTooLargeException(
          'La imagen supera el máximo de 5 MB',
        );
      }
      return;
    }

    if (!VIDEO_TYPES[contentType]) {
      throw new BadRequestException(
        'Formato de video no permitido (MP4, WebM o MOV)',
      );
    }

    if (size > this.videoMaxBytes()) {
      throw new PayloadTooLargeException(
        `El video supera el máximo de ${Math.round(
          this.videoMaxBytes() / 1024 / 1024,
        )} MB`,
      );
    }
  }

  private assertLimit(
    kind: MediaKind,
    primary: number,
    assets: Array<{ kind: MediaKind }>,
    limits: MediaLimits,
  ) {
    const images =
      primary + assets.filter((asset) => asset.kind === MediaKind.IMAGE).length;
    const videos = assets.filter((asset) => asset.kind === MediaKind.VIDEO).length;

    if (kind === MediaKind.IMAGE && images >= limits.maxImages) {
      throw new BadRequestException(
        `Tu plan permite hasta ${limits.maxImages} imagen(es) por elemento`,
      );
    }

    if (kind === MediaKind.VIDEO && videos >= limits.maxVideos) {
      throw new BadRequestException(
        `Tu plan permite hasta ${limits.maxVideos} video(s) por elemento`,
      );
    }
  }

  private videoMaxBytes(): number {
    const configured = Number(process.env.MEDIA_MAX_VIDEO_BYTES);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_VIDEO_MAX_BYTES;
  }
}

function toView(asset: {
  id: string;
  entityType: string;
  entityId: string;
  kind: MediaKind;
  url: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: bigint | null;
  createdAt: Date;
}): MediaAssetView {
  return {
    id: asset.id,
    entityType: asset.entityType,
    entityId: asset.entityId,
    kind: asset.kind,
    url: asset.url,
    name: asset.name,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
    createdAt: asset.createdAt,
  };
}
