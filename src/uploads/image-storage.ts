import {
  IMMUTABLE_CACHE_CONTROL,
  imageAssetObjectKeys,
  imageAssetsForKey,
  variantWidths,
  type ImageAssets,
} from './image-assets';
import { MAX_INPUT_PIXELS, processImage } from './image-processor';
import {
  buildImageKey,
  deleteR2Object,
  publicUrlForKey,
  putR2Object,
} from './r2';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export interface StoredImage {
  /** Clave base de la imagen (lo que se guarda en la base). */
  key: string;
  /** URLs y medidas de cada variante. */
  assets: ImageAssets;
  /** Bytes totales de las variantes guardadas (para la cuota). */
  bytes: number;
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
  let bytes = 0;
  const key = buildImageKey(folder, processed.width, processed.height);
  const sizes = variantWidths(processed.width, processed.height);

  try {
    for (const [index, size] of sizes.entries()) {
      const variant = processed.variants[index];

      bytes += variant.avif.length + variant.jpeg.length;

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

  return { key, assets, bytes };
}

export interface StoredReceiptLogo {
  key: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Genera el JPEG pequeño que se imprime en el ticket.
 *
 * El logo del panel puede ser grande y tener transparencia; para la impresora
 * se recorta a 384 px de ancho, máximo 192 px de alto y fondo blanco.
 */
export async function storeReceiptLogo(
  folder: string,
  input: Buffer,
): Promise<StoredReceiptLogo> {
  let data: Buffer;
  let width: number;
  let height: number;

  try {
    const result = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width: 384,
        height: 192,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    data = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    throw new BadRequestException(
      'La imagen no se pudo leer. Usa un JPG, PNG o WebP válido.',
    );
  }

  if (!width || !height) {
    throw new BadRequestException('La imagen no tiene medidas válidas.');
  }

  const key = `${buildImageKey(folder, width, height)}-receipt.jpg`;

  await putR2Object(key, data, 'image/jpeg', IMMUTABLE_CACHE_CONTROL);

  return {
    key,
    url: publicUrlForKey(key),
    width,
    height,
    bytes: data.length,
  };
}
