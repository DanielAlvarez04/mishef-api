import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FinalizeImageDto } from './dto/finalize-image.dto';
import { PresignImageDto } from './dto/presign-image.dto';
import {
  imageFallbackUrl,
  type ImageAssetVariant,
} from './image-assets';
import { storeOptimizedImage } from './image-storage';
import {
  IMAGE_CONTENT_TYPES,
  UPLOAD_URL_EXPIRES_IN,
  assetFolder,
  buildTempObjectKey,
  deleteR2Object,
  getR2Object,
  isTempObjectKey,
  maxUploadBytes,
  presignPutUrl,
  type UploadModule,
  variantFolder,
} from './r2';

export interface PresignImageResult {
  /** Clave temporal donde el navegador hará el PUT. */
  key: string;
  /** URL firmada a la que el navegador hace el PUT. */
  uploadUrl: string;
  method: 'PUT';
  /** Cabeceras que el navegador debe enviar tal cual (firmadas). */
  headers: Record<string, string>;
  expiresIn: number;
  maxBytes: number;
}

export interface FinalizeImageResult {
  /** Clave base optimizada; es lo que se guarda en la base de datos. */
  key: string;
  /** URL pública del JPEG de mayor tamaño. */
  url: string;
  /** Medidas de origen. */
  width: number;
  height: number;
  /** AVIF + JPEG por ancho, con sus URLs públicas. */
  variants: ImageAssetVariant[];
}

@Injectable()
export class UploadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Firma una subida temporal del navegador a R2.
   *
   * El archivo original se sube a `{org}/tmp/` y nunca se guarda como imagen de
   * la entidad: al terminar, el navegador llama a `finalize*`, la API lo
   * descarga, genera AVIF/JPEG y borra el temporal.
   *
   * Se mantiene la subida directa a R2 (el archivo no pasa por la API) y se
   * valida el tamaño aquí, en el cliente y al finalizar con el tamaño real.
   */
  async presignImage(
    organizationId: string | null,
    module: UploadModule,
    entityId: string,
    dto: PresignImageDto,
  ): Promise<PresignImageResult> {
    const maxBytes = this.assertCanPresign(organizationId, dto);

    const exists = await this.countEntity(module, entityId, organizationId!);

    if (!exists) {
      throw new NotFoundException('La entidad no existe en este negocio');
    }

    return this.sign(
      buildTempObjectKey(organizationId!, dto.contentType),
      dto,
      maxBytes,
    );
  }

  /**
   * Firma la subida temporal de la imagen propia de una presentación.
   *
   * La carpeta final se decide al finalizar (`.../variants/{variantId}/`),
   * cuando la API ya validó que la presentación pertenece al artículo.
   */
  async presignVariantImage(
    organizationId: string | null,
    catalogEntryId: string,
    _variantId: string,
    dto: PresignImageDto,
  ): Promise<PresignImageResult> {
    const maxBytes = this.assertCanPresign(organizationId, dto);

    const exists = await this.prisma.catalogEntry.count({
      where: { id: catalogEntryId, organizationId },
    });

    if (!exists) {
      throw new NotFoundException('El artículo no existe en este negocio');
    }

    return this.sign(
      buildTempObjectKey(organizationId!, dto.contentType),
      dto,
      maxBytes,
    );
  }

  /**
   * Procesa el temporal de un artículo o receta y deja solo las variantes
   * optimizadas en la carpeta de la entrada de catálogo.
   */
  async finalizeImage(
    organizationId: string | null,
    module: UploadModule,
    entityId: string,
    dto: FinalizeImageDto,
  ): Promise<FinalizeImageResult> {
    this.assertOrganization(organizationId);

    const exists = await this.countEntity(module, entityId, organizationId!);

    if (!exists) {
      throw new NotFoundException('La entidad no existe en este negocio');
    }

    return this.finalize(
      organizationId!,
      dto.key,
      assetFolder(organizationId!, module, entityId),
    );
  }

  /** Procesa el temporal de una presentación. */
  async finalizeVariantImage(
    organizationId: string | null,
    catalogEntryId: string,
    variantId: string,
    dto: FinalizeImageDto,
  ): Promise<FinalizeImageResult> {
    this.assertOrganization(organizationId);

    const exists = await this.prisma.catalogEntry.count({
      where: { id: catalogEntryId, organizationId },
    });

    if (!exists) {
      throw new NotFoundException('El artículo no existe en este negocio');
    }

    return this.finalize(
      organizationId!,
      dto.key,
      variantFolder(organizationId!, catalogEntryId, variantId),
    );
  }

  /**
   * Descarga el temporal, genera las variantes y lo borra.
   *
   * El borrado va en `finally`: pase lo que pase, el original no se queda en
   * R2. Si el procesado falla, el error de `processImage` explica el motivo.
   */
  private async finalize(
    organizationId: string,
    tempKey: string,
    folder: string,
  ): Promise<FinalizeImageResult> {
    if (!isTempObjectKey(organizationId, tempKey)) {
      throw new BadRequestException(
        'La subida no pertenece a este negocio',
      );
    }

    const buffer = await getR2Object(tempKey);

    if (!buffer) {
      throw new BadRequestException(
        'La imagen temporal ya no está disponible. Vuelve a subirla.',
      );
    }

    const maxBytes = maxUploadBytes();

    if (buffer.length > maxBytes) {
      await deleteR2Object(tempKey);
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    try {
      const stored = await storeOptimizedImage(folder, buffer);

      return {
        key: stored.key,
        url: imageFallbackUrl(stored.assets),
        width: stored.assets.width,
        height: stored.assets.height,
        variants: stored.assets.variants,
      };
    } finally {
      await deleteR2Object(tempKey);
    }
  }

  /** Valida organización, formato y tamaño antes de firmar cualquier imagen. */
  private assertCanPresign(
    organizationId: string | null,
    dto: PresignImageDto,
  ): number {
    this.assertOrganization(organizationId);

    if (!(dto.contentType in IMAGE_CONTENT_TYPES)) {
      throw new BadRequestException('Formato no admitido. Usa JPG, PNG o WebP');
    }

    const maxBytes = maxUploadBytes();

    if (dto.size > maxBytes) {
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    return maxBytes;
  }

  private assertOrganization(
    organizationId: string | null,
  ): asserts organizationId is string {
    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona una organización antes de subir imágenes',
      );
    }
  }

  /** Construye la respuesta firmada para una clave ya validada. */
  private async sign(
    key: string,
    dto: PresignImageDto,
    maxBytes: number,
  ): Promise<PresignImageResult> {
    return {
      key,
      uploadUrl: await presignPutUrl(key, dto.contentType),
      method: 'PUT',
      headers: { 'Content-Type': dto.contentType },
      expiresIn: UPLOAD_URL_EXPIRES_IN,
      maxBytes,
    };
  }

  /**
   * Comprueba que la entidad existe en la organización del usuario.
   *
   * Cada página nueva añade su caso aquí (con su modelo y permiso). Las que
   * todavía no tienen cargas responden 400 en vez de consultar otra tabla.
   */
  private async countEntity(
    module: UploadModule,
    entityId: string,
    organizationId: string | null,
  ): Promise<number> {
    switch (module) {
      case 'catalog':
        return this.prisma.catalogEntry.count({
          where: { id: entityId, organizationId },
        });
      case 'inventory':
        return this.prisma.ingredient.count({
          where: { id: entityId, organizationId },
        });
      default:
        throw new BadRequestException(
          `El módulo "${module}" todavía no admite cargas`,
        );
    }
  }
}
