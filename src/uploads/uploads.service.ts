import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresignImageDto } from './dto/presign-image.dto';
import {
  IMAGE_CONTENT_TYPES,
  UPLOAD_URL_EXPIRES_IN,
  buildObjectKey,
  buildVariantObjectKey,
  maxUploadBytes,
  presignPutUrl,
  publicUrlForKey,
  type UploadModule,
} from './r2';

export interface PresignImageResult {
  /** Clave del objeto; es lo que se guarda en la base de datos. */
  key: string;
  /** URL pública final del archivo. */
  url: string;
  /** URL firmada a la que el navegador hace el PUT. */
  uploadUrl: string;
  method: 'PUT';
  /** Cabeceras que el navegador debe enviar tal cual (firmadas). */
  headers: Record<string, string>;
  expiresIn: number;
  maxBytes: number;
}

@Injectable()
export class UploadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Firma una subida directa del navegador a R2.
   *
   * La imagen se sube a la carpeta de la entidad (`{org}/{página}/{id}/`), así
   * que la entidad ya debe existir: el diálogo guarda primero el artículo o la
   * receta y luego sube la imagen. No hay área temporal ni objetos huérfanos.
   *
   * En `catalog`, `entityId` es el `CatalogEntry.id` (la identidad compartida
   * por la receta y su artículo), no el id de la fila.
   *
   * El `Content-Type` va firmado, así que el objeto se guarda con el tipo
   * declarado. R2 no permite fijar el tamaño en la firma de un PUT: el límite
   * de 5 MB se valida aquí, en el cliente y, al guardar, con el tamaño real
   * del objeto.
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
      buildObjectKey(organizationId!, module, entityId, dto.contentType),
      dto,
      maxBytes,
    );
  }

  /**
   * Firma la subida de la imagen propia de una presentación.
   *
   * La clave va en una subcarpeta de la entrada de catálogo
   * (`.../variants/{variantId}/`), así no se mezcla con la imagen base y la
   * validación al guardar puede exigir que la imagen sea de esa presentación.
   */
  async presignVariantImage(
    organizationId: string | null,
    catalogEntryId: string,
    variantId: string,
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
      buildVariantObjectKey(
        organizationId!,
        catalogEntryId,
        variantId,
        dto.contentType,
      ),
      dto,
      maxBytes,
    );
  }

  /** Valida organización, formato y tamaño antes de firmar cualquier imagen. */
  private assertCanPresign(
    organizationId: string | null,
    dto: PresignImageDto,
  ): number {
    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona una organización antes de subir imágenes',
      );
    }

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

  /** Construye la respuesta firmada para una clave ya validada. */
  private async sign(
    key: string,
    dto: PresignImageDto,
    maxBytes: number,
  ): Promise<PresignImageResult> {
    return {
      key,
      url: publicUrlForKey(key),
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
