import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ImageJobStatus, ImageJobTarget, Prisma } from '@prisma/client';

import { CatalogEntriesService } from '../catalog/catalog-entries.service';
import { PrismaService } from '../prisma/prisma.service';
import { imageFallbackUrl } from './image-assets';
import { storeOptimizedImage } from './image-storage';
import {
  deleteR2Object,
  getR2Object,
  maxUploadBytes,
} from './r2';

/**
 * Cola serial de optimizacion de imagenes.
 *
 * El trabajo pesado (descargar el temporal, generar AVIF/JPEG, subir las
 * variantes y actualizar la entidad) corre fuera de la peticion HTTP. Los
 * jobs viven en la base para sobrevivir reinicios; al arrancar se reencolan
 * los que quedaron pendientes o a medias.
 */
@Injectable()
export class ImageJobsService implements OnModuleInit {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogEntries: CatalogEntriesService,
  ) {}

  async onModuleInit() {
    try {
      // Un reinicio pudo dejar jobs a medias: vuelven a la cola.
      await this.prisma.imageJob.updateMany({
        where: { status: ImageJobStatus.PROCESSING },
        data: { status: ImageJobStatus.PENDING, startedAt: null },
      });

      const pending = await this.prisma.imageJob.findMany({
        where: { status: ImageJobStatus.PENDING },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      for (const job of pending) this.enqueue(job.id);
    } catch {
      // La API puede arrancar antes de que la base este lista; los jobs se
      // reencolaran en la siguiente peticion que los cree.
    }
  }

  enqueue(jobId: string) {
    if (this.queued.has(jobId)) return;

    this.queued.add(jobId);
    this.queue.push(jobId);
    void this.drain();
  }

  /** Estado de un job, acotado a la organizacion. */
  async status(organizationId: string | null, jobId: string) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const job = await this.prisma.imageJob.findFirst({
      where: { id: jobId, organizationId },
      select: {
        id: true,
        status: true,
        error: true,
        result: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    if (!job) throw new NotFoundException('Trabajo de imagen no encontrado');

    return job;
  }

  /** Estado de varios jobs en una sola consulta (para el toast combinado). */
  async statuses(organizationId: string | null, ids: string[]) {
    if (!organizationId) {
      throw new BadRequestException('La sesión no tiene un negocio activo');
    }

    const unique = [...new Set(ids)].slice(0, 50);

    return this.prisma.imageJob.findMany({
      where: { organizationId, id: { in: unique } },
      select: {
        id: true,
        status: true,
        error: true,
      },
    });
  }

  private async drain() {
    if (this.running) return;

    this.running = true;

    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift()!;
        this.queued.delete(jobId);

        try {
          await this.process(jobId);
        } catch {
          // `process` ya marca el job como FAILED; si el fallo es de base de
          // datos, la cola sigue con el siguiente trabajo.
        }
      }
    } finally {
      this.running = false;

      // Un job pudo entrar entre la ultima comprobacion y este punto.
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async process(jobId: string) {
    const job = await this.prisma.imageJob.findUnique({
      where: { id: jobId },
    });

    if (!job || job.status === ImageJobStatus.DONE) return;

    const claimed = await this.prisma.imageJob.updateMany({
      where: {
        id: jobId,
        status: { in: [ImageJobStatus.PENDING, ImageJobStatus.PROCESSING] },
      },
      data: {
        status: ImageJobStatus.PROCESSING,
        startedAt: new Date(),
        error: null,
      },
    });

    if (claimed.count === 0) return;

    try {
      const buffer = await getR2Object(job.tempKey);

      if (!buffer) {
        throw new BadRequestException(
          'La imagen temporal ya no está disponible. Vuelve a subirla.',
        );
      }

      const maxBytes = maxUploadBytes();

      if (buffer.length > maxBytes) {
        throw new BadRequestException(
          `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
        );
      }

      const stored = await storeOptimizedImage(job.folder, buffer);

      if (job.target === ImageJobTarget.VARIANT) {
        if (!job.itemId) {
          throw new BadRequestException(
            'El trabajo de la presentación no tiene artículo asociado',
          );
        }

        await this.catalogEntries.applyVariantImage(
          job.organizationId,
          job.itemId,
          job.targetId,
          stored.key,
        );
      } else {
        await this.catalogEntries.applyImage(
          job.organizationId,
          job.targetId,
          job.imageName ?? 'Imagen',
          stored.key,
        );
      }

      const result = {
        key: stored.key,
        url: imageFallbackUrl(stored.assets),
        width: stored.assets.width,
        height: stored.assets.height,
        variants: stored.assets.variants,
      };

      await this.prisma.imageJob.update({
        where: { id: job.id },
        data: {
          status: ImageJobStatus.DONE,
          result: result as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    } catch (error) {
      const message =
        error instanceof BadRequestException ||
        error instanceof NotFoundException
          ? error.message
          : 'No se pudo optimizar la imagen';

      await this.prisma.imageJob.update({
        where: { id: job.id },
        data: {
          status: ImageJobStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      });
    } finally {
      // El original nunca se queda en R2, pase lo que pase.
      await deleteR2Object(job.tempKey).catch(() => undefined);
    }
  }
}
