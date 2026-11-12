import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ImageJobStatus, ImageJobTarget } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FinalizeImageDto } from './dto/finalize-image.dto';
import { PresignImageDto } from './dto/presign-image.dto';
import { ImageJobsService } from './image-jobs.service';
import {
  IMAGE_CONTENT_TYPES,
  UPLOAD_URL_EXPIRES_IN,
  assetFolder,
  buildTempObjectKey,
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

export interface ImageJobStarted {
  /** Identificador del trabajo que optimizará la imagen en segundo plano. */
  jobId: string;
  status: string;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ImageJobsService,
  ) {}

  /**
   * Firma una subida temporal del navegador a R2.
   *
   * El archivo original se sube a `{org}/tmp/` y nunca se guarda como imagen de
   * la entidad: al terminar, el navegador llama a `finalize*`, que encola la
   * optimización en segundo plano (AVIF/JPEG + actualización de la entidad).
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
   * Encola la optimización del temporal de un artículo o receta.
   *
   * El trabajo pesado (sharp + R2) corre en `ImageJobsService`; aquí solo se
   * valida la entidad y se devuelve el job para que el cliente lo consulte.
   */
  async finalizeImage(
    organizationId: string | null,
    module: UploadModule,
    entityId: string,
    dto: FinalizeImageDto,
  ): Promise<ImageJobStarted> {
    this.assertOrganization(organizationId);

    const exists = await this.countEntity(module, entityId, organizationId);

    if (!exists) {
      throw new NotFoundException('La entidad no existe en este negocio');
    }

    return this.enqueueJob({
      organizationId,
      target: ImageJobTarget.CATALOG_ENTRY,
      targetId: entityId,
      folder: assetFolder(organizationId, module, entityId),
      tempKey: dto.key,
      imageName: await this.resolveEntryName(organizationId, entityId),
    });
  }

  /** Encola la optimización del temporal de una presentación. */
  async finalizeVariantImage(
    organizationId: string | null,
    itemId: string,
    catalogEntryId: string,
    variantId: string,
    dto: FinalizeImageDto,
  ): Promise<ImageJobStarted> {
    this.assertOrganization(organizationId);

    const exists = await this.prisma.catalogEntry.count({
      where: { id: catalogEntryId, organizationId },
    });

    if (!exists) {
      throw new NotFoundException('El artículo no existe en este negocio');
    }

    return this.enqueueJob({
      organizationId,
      target: ImageJobTarget.VARIANT,
      targetId: variantId,
      itemId,
      folder: variantFolder(organizationId, catalogEntryId, variantId),
      tempKey: dto.key,
    });
  }

  /** Crea el job y lo entrega a la cola serial. */
  private async enqueueJob(input: {
    organizationId: string;
    target: ImageJobTarget;
    targetId: string;
    itemId?: string | null;
    imageName?: string | null;
    folder: string;
    tempKey: string;
  }): Promise<ImageJobStarted> {
    if (!isTempObjectKey(input.organizationId, input.tempKey)) {
      throw new BadRequestException('La subida no pertenece a este negocio');
    }

    // Reintentos de la misma subida reutilizan el job en curso.
    const existing = await this.prisma.imageJob.findFirst({
      where: {
        organizationId: input.organizationId,
        tempKey: input.tempKey,
        status: { not: ImageJobStatus.FAILED },
      },
      select: { id: true, status: true },
    });

    if (existing) {
      this.jobs.enqueue(existing.id);
      return { jobId: existing.id, status: existing.status };
    }

    const job = await this.prisma.imageJob.create({
      data: {
        organizationId: input.organizationId,
        target: input.target,
        targetId: input.targetId,
        itemId: input.itemId ?? null,
        imageName: input.imageName ?? null,
        folder: input.folder,
        tempKey: input.tempKey,
      },
      select: { id: true, status: true },
    });

    this.jobs.enqueue(job.id);

    return { jobId: job.id, status: job.status };
  }

  /** Nombre legible para el snapshot de la imagen de una entrada compartida. */
  private async resolveEntryName(
    organizationId: string,
    entryId: string,
  ): Promise<string> {
    const entry = await this.prisma.catalogEntry.findFirst({
      where: { id: entryId, organizationId },
      select: {
        items: { select: { name: true }, take: 1 },
        recipes: { select: { name: true }, take: 1 },
      },
    });

    return entry?.items[0]?.name ?? entry?.recipes[0]?.name ?? 'Imagen';
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
