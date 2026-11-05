import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildObjectKey,
  buildVariantObjectKey,
  catalogFolder,
  contentTypeFromKey,
  copyR2Object,
  deleteR2Object,
  imageSnapshotName,
  maxUploadBytes,
  objectSize,
  publicUrlForKey,
  variantFolder,
} from '../uploads/r2';

/** Prisma normal o dentro de una transacción. */
type Db = Prisma.TransactionClient | PrismaService;

/**
 * Identidad global del catálogo (`CatalogEntry`).
 *
 * La entrada es dueña de la imagen y de la carpeta en R2
 * (`{org}/catalog/{entryId}/`). La receta y el artículo que la publica
 * comparten la misma entrada, así que la ruta no cambia al publicar y nunca
 * hay dos objetos para la misma imagen.
 */
@Injectable()
export class CatalogEntriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve la entrada de un artículo o la crea si todavía no existe.
   *
   * Las filas históricas usan el id de la entidad como id de la entrada para
   * que la carpeta `catalog/{itemId}/` siga siendo válida.
   */
  async ensureForItem(
    organizationId: string | null,
    itemId: string,
    db: Db = this.prisma,
  ): Promise<string> {
    const item = await db.item.findFirst({
      where: { id: itemId, organizationId },
      select: { id: true, catalogEntryId: true },
    });

    if (!item) {
      throw new NotFoundException('Artículo no encontrado');
    }

    if (item.catalogEntryId) return item.catalogEntryId;

    await db.catalogEntry.upsert({
      where: { id: item.id },
      create: { id: item.id, organizationId },
      update: {},
    });

    await db.item.update({
      where: { id: item.id },
      data: { catalogEntryId: item.id },
    });

    return item.id;
  }

  /**
   * Entrada de catálogo de una presentación.
   *
   * Valida que la presentación pertenezca al artículo y al negocio antes de
   * devolver la entrada compartida (la misma del artículo).
   */
  async ensureForVariant(
    organizationId: string | null,
    itemId: string,
    variantId: string,
  ): Promise<string> {
    const variant = await this.prisma.itemVariant.findFirst({
      where: {
        id: variantId,
        item: { id: itemId, organizationId },
      },
      select: { id: true },
    });

    if (!variant) {
      throw new NotFoundException('Presentación no encontrada');
    }

    return this.ensureForItem(organizationId, itemId);
  }

  /** Igual que `ensureForItem`, pero para una receta. */
  async ensureForRecipe(
    organizationId: string | null,
    recipeId: string,
    db: Db = this.prisma,
  ): Promise<string> {
    const recipe = await db.recipe.findFirst({
      where: { id: recipeId, organizationId },
      select: { id: true, catalogEntryId: true },
    });

    if (!recipe) {
      throw new NotFoundException('Receta no encontrada');
    }

    if (recipe.catalogEntryId) return recipe.catalogEntryId;

    await db.catalogEntry.upsert({
      where: { id: recipe.id },
      create: { id: recipe.id, organizationId },
      update: {},
    });

    await db.recipe.update({
      where: { id: recipe.id },
      data: { catalogEntryId: recipe.id },
    });

    return recipe.id;
  }

  /**
   * Guarda o quita la imagen base de una entrada.
   *
   * Valida que la clave esté en la carpeta de la entrada, comprueba el tamaño
   * real y borra el objeto anterior. Antes de cambiar o quitar la base, si la
   * presentación principal no tiene imagen propia, se copia la base anterior
   * a la presentación: así la principal conserva la imagen que ya mostraba.
   */
  async applyImage(
    organizationId: string | null,
    entryId: string,
    name: string,
    imageKey: string | null,
  ): Promise<void> {
    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona una organización antes de guardar imágenes',
      );
    }

    const entry = await this.prisma.catalogEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        imageKey: true,
        items: {
          select: {
            id: true,
            name: true,
            variants: {
              where: { isActive: true, isPrimary: true },
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
              take: 1,
              select: { id: true, name: true, imageKey: true },
            },
          },
        },
      },
    });

    if (!entry) {
      throw new NotFoundException('Elemento de catálogo no encontrado');
    }

    const previousKey = entry.imageKey;

    if (imageKey === previousKey) return;

    if (imageKey === null) {
      // La principal hereda la imagen base cuando esta se quita.
      if (previousKey) {
        await this.copyBaseToPrimary(
          organizationId,
          entry.id,
          previousKey,
          entry.items,
        );
      }

      await this.prisma.catalogEntry.update({
        where: { id: entry.id },
        data: { imageKey: null, imageUrl: null, imageName: null },
      });

      // La base ya no apunta a la imagen: el objeto puede borrarse.
      if (previousKey) await deleteR2Object(previousKey);
      return;
    }

    const folder = catalogFolder(organizationId, entry.id);

    if (!imageKey.startsWith(`${folder}/`)) {
      throw new BadRequestException(
        'La imagen no pertenece a este elemento del catálogo',
      );
    }

    // R2 no permite fijar el tamaño en la firma del PUT: se comprueba aquí.
    const size = await objectSize(imageKey);
    const maxBytes = maxUploadBytes();

    if (size !== null && size > maxBytes) {
      await deleteR2Object(imageKey);
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    // La principal conserva la imagen anterior antes de que cambie la base.
    if (previousKey) {
      await this.copyBaseToPrimary(
        organizationId,
        entry.id,
        previousKey,
        entry.items,
      );
    }

    await this.prisma.catalogEntry.update({
      where: { id: entry.id },
      data: {
        imageKey,
        imageUrl: publicUrlForKey(imageKey),
        // Nombre legible en la base; en R2 el objeto va hasheado.
        imageName: imageSnapshotName(name),
      },
    });

    if (previousKey) await deleteR2Object(previousKey);
  }

  /**
   * Copia la imagen base a la carpeta de la presentación principal.
   *
   * La copia es un objeto nuevo: cambiar o borrar después la base no afecta a
   * la presentación (ni al revés).
   */
  private async copyBaseToPrimary(
    organizationId: string,
    entryId: string,
    sourceKey: string,
    items: Array<{
      id: string;
      name: string;
      variants: Array<{
        id: string;
        name: string;
        imageKey: string | null;
      }>;
    }>,
  ): Promise<void> {
    const contentType = contentTypeFromKey(sourceKey);
    if (!contentType) return;

    for (const item of items) {
      const primary = item.variants[0];
      if (!primary || primary.imageKey) continue;

      const targetKey = buildVariantObjectKey(
        organizationId,
        entryId,
        primary.id,
        contentType,
      );

      await copyR2Object(sourceKey, targetKey);

      await this.prisma.itemVariant.update({
        where: { id: primary.id },
        data: {
          imageKey: targetKey,
          imageUrl: publicUrlForKey(targetKey),
          imageName: imageSnapshotName(`${item.name} ${primary.name}`),
        },
      });
    }
  }

  /**
   * Guarda o quita la imagen propia de una presentación.
   *
   * Si es la principal y el artículo todavía no tiene imagen base, la imagen
   * se copia también a la entrada para que el artículo la tome como base.
   */
  async applyVariantImage(
    organizationId: string | null,
    itemId: string,
    variantId: string,
    imageKey: string | null,
  ): Promise<void> {
    if (!organizationId) {
      throw new BadRequestException(
        'Selecciona una organización antes de guardar imágenes',
      );
    }

    const item = await this.prisma.item.findFirst({
      where: { id: itemId, organizationId },
      select: { id: true, name: true, catalogEntryId: true },
    });

    if (!item) {
      throw new NotFoundException('Artículo no encontrado');
    }

    const variant = await this.prisma.itemVariant.findFirst({
      where: { id: variantId, itemId: item.id },
      select: { id: true, name: true, imageKey: true, isPrimary: true },
    });

    if (!variant) {
      throw new NotFoundException('Presentación no encontrada');
    }

    const previousKey = variant.imageKey;

    if (imageKey === previousKey) return;

    const entryId =
      item.catalogEntryId ?? (await this.ensureForItem(organizationId, item.id));
    const entry = await this.prisma.catalogEntry.findUnique({
      where: { id: entryId },
      select: { imageKey: true },
    });

    if (!entry) {
      throw new NotFoundException('Elemento de catálogo no encontrado');
    }

    if (imageKey === null) {
      await this.prisma.itemVariant.update({
        where: { id: variant.id },
        data: { imageKey: null, imageUrl: null, imageName: null },
      });

      if (previousKey) await deleteR2Object(previousKey);
      return;
    }

    const folder = variantFolder(organizationId, entryId, variant.id);

    if (!imageKey.startsWith(`${folder}/`)) {
      throw new BadRequestException(
        'La imagen no pertenece a esta presentación',
      );
    }

    const size = await objectSize(imageKey);
    const maxBytes = maxUploadBytes();

    if (size !== null && size > maxBytes) {
      await deleteR2Object(imageKey);
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }

    // Si la principal estrena imagen y el artículo no tiene base, se copia a
    // la entrada. Después cada lado es independiente.
    let baseKey: string | null = null;

    if (variant.isPrimary && !entry.imageKey) {
      const contentType = contentTypeFromKey(imageKey);

      if (contentType) {
        baseKey = buildObjectKey(
          organizationId,
          'catalog',
          entryId,
          contentType,
        );
        await copyR2Object(imageKey, baseKey);
      }
    }

    await this.prisma.itemVariant.update({
      where: { id: variant.id },
      data: {
        imageKey,
        imageUrl: publicUrlForKey(imageKey),
        imageName: imageSnapshotName(`${item.name} ${variant.name}`),
      },
    });

    if (baseKey) {
      await this.prisma.catalogEntry.update({
        where: { id: entryId },
        data: {
          imageKey: baseKey,
          imageUrl: publicUrlForKey(baseKey),
          imageName: imageSnapshotName(item.name),
        },
      });
    }

    if (previousKey) await deleteR2Object(previousKey);
  }

  /**
   * Borra la entrada y su objeto cuando ya no la referencia ningún artículo
   * ni receta. Si todavía queda alguno, no hace nada.
   */
  async deleteIfOrphan(entryId: string | null | undefined): Promise<void> {
    if (!entryId) return;

    const entry = await this.prisma.catalogEntry.findUnique({
      where: { id: entryId },
      select: {
        imageKey: true,
        _count: { select: { items: true, recipes: true } },
      },
    });

    if (!entry) return;
    if (entry._count.items > 0 || entry._count.recipes > 0) return;

    try {
      await this.prisma.catalogEntry.delete({ where: { id: entryId } });
    } catch {
      // Apareció una referencia entre la consulta y el borrado: se conserva.
      return;
    }

    if (entry.imageKey) await deleteR2Object(entry.imageKey);
  }
}
