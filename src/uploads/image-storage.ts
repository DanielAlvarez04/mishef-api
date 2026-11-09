import {
  IMMUTABLE_CACHE_CONTROL,
  imageAssetObjectKeys,
  imageAssetsForKey,
  variantWidths,
  type ImageAssets,
} from './image-assets';
import { processImage } from './image-processor';
import { buildImageKey, deleteR2Object, putR2Object } from './r2';

export interface StoredImage {
  /** Clave base de la imagen (lo que se guarda en la base). */
  key: string;
  /** URLs y medidas de cada variante. */
  assets: ImageAssets;
}

/**
 * Procesa una imagen y deja en R2 solo las variantes optimizadas (AVIF + JPEG).
 *
 * El original nunca se guarda: se procesa en memoria y se escriben los
 * archivos derivados. Si una escritura falla a mitad, se borran las anteriores
 * para no dejar objetos huérfanos.
 */
export async function storeOptimizedImage(
  folder: string,
  input: Buffer,
): Promise<StoredImage> {
  const processed = await processImage(input);
  const key = buildImageKey(folder, processed.width, processed.height);
  const sizes = variantWidths(processed.width, processed.height);

  try {
    for (const [index, size] of sizes.entries()) {
      const variant = processed.variants[index];

      await putR2Object(
        `${key}-${size}.avif`,
        variant.avif,
        'image/avif',
        IMMUTABLE_CACHE_CONTROL,
      );
      await putR2Object(
        `${key}-${size}.jpg`,
        variant.jpeg,
        'image/jpeg',
        IMMUTABLE_CACHE_CONTROL,
      );
    }
  } catch (error) {
    // Los borrados no se facturan: limpiar es más barato que dejar huérfanos.
    for (const objectKey of imageAssetObjectKeys(key)) {
      await deleteR2Object(objectKey);
    }

    throw error;
  }

  const assets = imageAssetsForKey(key);

  if (!assets) {
    throw new Error(`La clave generada no es válida: ${key}`);
  }

  return { key, assets };
}
