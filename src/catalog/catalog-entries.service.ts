import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildImageKey,
  catalogFolder,
  copyR2Object,
  deleteR2Object,
  imageSnapshotName,
  maxUploadBytes,
  objectSize,
  variantFolder,
} from '../uploads/r2';
import {
  imageAssetsForKey,
  imageFallbackUrl,
  imageMainObjectKey,
  imageObjectKeys,
  variantWidths,
  type ImageAssets,
} from '../uploads/image-assets';

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
   * La imagen ya viene optimizada y vive en `{carpeta}/{hash}-{W}x{H}`; aquí
   * solo se valida que esté en la carpeta de la entrada y se guardan las URLs
   * derivadas. La presentación principal ya no recibe una copia: si no tiene
   * imagen propia, la UI muestra la del artículo (estado "Base").
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

    const entry = await this.prisma.catalogEntry.findFirst({
      where: { id: entryId, organizationId },
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
        data: {
          imageKey: null,
          imageUrl: null,
          imageVariants: Prisma.DbNull,
          imageName: null,
        },
      });

      await this.deleteImageAssets(previousKey);
      return;
    }

    const assets = this.assertImageKey(
      catalogFolder(organizationId, entry.id),
      imageKey,
    );

    await this.assertObjectsExist(imageKey);

    await this.prisma.catalogEntry.update({
      where: { id: entry.id },
      data: {
        imageKey,
        imageUrl: imageFallbackUrl(assets),
        imageVariants: assets as unknown as Prisma.InputJsonValue,
        // Nombre legible en la base; en R2 los objetos van hasheados.
        imageName: imageSnapshotName(name),
      },
    });

    await this.deleteImageAssets(previousKey);
  }

  /**
   * Copia una imagen optimizada a otra carpeta (misma imagen, clave nueva).
   *
   * Se usa cuando la presentación principal estrena imagen y el artículo no
   * tiene una: el artículo toma esa misma imagen como base.
   */
  private async copyImageToFolder(
    sourceKey: string,
    assets: ImageAssets,
    folder: string,
  ): Promise<string> {
    const targetKey = buildImageKey(folder, assets.width, assets.height);

    for (const width of variantWidths(assets.width, assets.height)) {
      await copyR2Object(
        `${sourceKey}-${width}.avif`,
        `${targetKey}-${width}.avif`,
      );
      await copyR2Object(
        `${sourceKey}-${width}.jpg`,
        `${targetKey}-${width}.jpg`,
      );
    }

    return targetKey;
  }

  /**
   * Valida que la clave sea una imagen optimizada dentro de la carpeta dada.
   *
   * Las claves antiguas (con extensión) ya no se aceptan al guardar: el
   * backfill las convierte antes de que la app vuelva a escribir imágenes.
   */
  private assertImageKey(folder: string, key: string): ImageAssets {
    if (!key.startsWith(`${folder}/`)) {
      throw new BadRequestException(
        'La imagen no pertenece a este elemento del catálogo',
      );
    }

    const assets = imageAssetsForKey(key);

    if (!assets) {
      throw new BadRequestException(
        'La imagen no está optimizada. Vuelve a subirla.',
      );
    }

    return assets;
  }

  /** Comprueba el tamaño real del archivo principal (best-effort). */
  private async assertObjectsExist(key: string): Promise<void> {
    const mainKey = imageMainObjectKey(key);

    if (!mainKey) return;

    const size = await objectSize(mainKey);
    const maxBytes = maxUploadBytes();

    if (size !== null && size > maxBytes) {
      await this.deleteImageAssets(key);
      throw new BadRequestException(
        `La imagen supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      );
    }
  }

  /** Borra todos los objetos de una imagen (o el objeto suelto si es antigua). */
  private async deleteImageAssets(key: string | null): Promise<void> {
    if (!key) return;

    for (const objectKey of imageObjectKeys(key)) {
      await deleteR2Object(objectKey);
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
    const entry = await this.prisma.catalogEntry.findFirst({
      where: { id: entryId, organizationId },
      select: { imageKey: true },
    });

    if (!entry) {
      throw new NotFoundException('Elemento de catálogo no encontrado');
    }

    if (imageKey === null) {
      await this.prisma.itemVariant.update({
        where: { id: variant.id },
        data: {
          imageKey: null,
          imageUrl: null,
          imageVariants: Prisma.DbNull,
          imageName: null,
        },
      });

      await this.deleteImageAssets(previousKey);
      return;
    }

    const assets = this.assertImageKey(
      variantFolder(organizationId, entryId, variant.id),
      imageKey,
    );

    await this.assertObjectsExist(imageKey);

    // Si la principal estrena imagen y el artículo no tiene base, se copia a
    // la entrada. Después cada lado es independiente.
    let baseKey: string | null = null;
    let baseAssets: ImageAssets | null = null;

    if (variant.isPrimary && !entry.imageKey) {
      baseKey = await this.copyImageToFolder(
        imageKey,
        assets,
        catalogFolder(organizationId, entryId),
      );
      baseAssets = imageAssetsForKey(baseKey);
    }

    await this.prisma.itemVariant.update({
      where: { id: variant.id },
      data: {
        imageKey,
        imageUrl: imageFallbackUrl(assets),
        imageVariants: assets as unknown as Prisma.InputJsonValue,
        imageName: imageSnapshotName(`${item.name} ${variant.name}`),
      },
    });

    if (baseKey && baseAssets) {
      await this.prisma.catalogEntry.update({
        where: { id: entryId },
        data: {
          imageKey: baseKey,
          imageUrl: imageFallbackUrl(baseAssets),
          imageVariants: baseAssets as unknown as Prisma.InputJsonValue,
          imageName: imageSnapshotName(item.name),
        },
      });
    }

    await this.deleteImageAssets(previousKey);
  }

  /**
   * Borra la entrada y su objeto cuando ya no la referencia ningún artículo
   * ni receta. Si todavía queda alguno, no hace nada.
   */
  async deleteIfOrphan(
    entryId: string | null | undefined,
    organizationId?: string | null,
  ): Promise<void> {
    if (!entryId) return;

    const entry = await this.prisma.catalogEntry.findFirst({
      where: {
        id: entryId,
        ...(organizationId ? { organizationId } : {}),
      },
      select: {
        imageKey: true,
        _count: { select: { items: true, recipes: true } },
      },
    });

    if (!entry) return;
    if (entry._count.items > 0 || entry._count.recipes > 0) return;

    try {
      const removed = await this.prisma.catalogEntry.deleteMany({
        where: {
          id: entryId,
          ...(organizationId ? { organizationId } : {}),
        },
      });

      // Otra organización no debe poder borrar esta entrada: si el `where`
      // acotado no coincidió, no se toca la imagen.
      if (removed.count === 0) return;
    } catch {
      // Apareció una referencia entre la consulta y el borrado: se conserva.
      return;
    }

    if (entry.imageKey) await this.deleteImageAssets(entry.imageKey);
  }
}
