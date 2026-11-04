import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  catalogFolder,
  deleteR2Object,
  imageSnapshotName,
  maxUploadBytes,
  objectSize,
  publicUrlForKey,
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
   * Guarda o quita la imagen de una entrada.
   *
   * Valida que la clave esté en la carpeta de la entrada, comprueba el tamaño
   * real y borra el objeto anterior: solo queda una imagen por entrada.
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
      select: { id: true, imageKey: true },
    });

    if (!entry) {
      throw new NotFoundException('Elemento de catálogo no encontrado');
    }

    const previousKey = entry.imageKey;

    if (imageKey === previousKey) return;

    if (imageKey === null) {
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
