import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

import { variantWidths } from './image-assets';

/**
 * Calidad de AVIF. 70 conserva el detalle de fotografía de comida sin inflar
 * el archivo; por debajo de 60 aparecen artefactos en texturas (pan, granos).
 */
export const AVIF_QUALITY = 70;

/** Calidad del JPEG de respaldo (solo lo descargan navegadores sin AVIF). */
export const JPEG_QUALITY = 82;

/** Esfuerzo de compresión AVIF (0-9). 3 es el equilibrio velocidad/tamaño. */
export const AVIF_EFFORT = 3;

/**
 * Tope de píxeles de la imagen de entrada (~50 MP).
 *
 * El límite de 5 MB no protege de una bomba de descompresión (un PNG de 1 MB
 * puede declarar 20 000x20 000). Sharp rechaza lo que supere este tope.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Formatos que aceptamos decodificar (la API ya valida el MIME al firmar). */
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ProcessedImageVariant {
  width: number;
  height: number;
  avif: Buffer;
  jpeg: Buffer;
}

export interface ProcessedImage {
  /** Medidas de origen después de aplicar la orientación EXIF. */
  width: number;
  height: number;
  /** Variantes ordenadas de menor a mayor ancho. */
  variants: ProcessedImageVariant[];
}

/**
 * Decodifica, corrige la orientación y genera las variantes optimizadas.
 *
 * Nunca devuelve el archivo original: el llamador guarda solo AVIF + JPEG.
 * Sharp elimina los metadatos por defecto, incluida la geolocalización.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const metadata = await readMetadata(input);
  const orientation = metadata.orientation ?? 1;
  // Las orientaciones 5-8 giran 90°: ancho y alto quedan intercambiados.
  const rotated = orientation >= 5 && orientation <= 8;
  const width = rotated ? metadata.height! : metadata.width!;
  const height = rotated ? metadata.width! : metadata.height!;

  const pipeline = sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
  }).rotate();

  const longest = Math.max(width, height);
  const variants: ProcessedImageVariant[] = [];

  for (const variantWidth of variantWidths(width, height)) {
    const scale = variantWidth / longest;
    const resizedWidth = Math.max(1, Math.round(width * scale));
    const resizedHeight = Math.max(1, Math.round(height * scale));

    const resized = pipeline.clone().resize({
      width: resizedWidth,
      height: resizedHeight,
      fit: 'fill',
    });

    const avif = await resized.clone().avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT }).toBuffer();
    const jpeg = await resized
      .clone()
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
      .toBuffer();

    variants.push({
      width: resizedWidth,
      height: resizedHeight,
      avif,
      jpeg,
    });
  }

  return { width, height, variants };
}

/** Formato de los metadatos que devuelve sharp (sin importar el namespace). */
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

async function readMetadata(input: Buffer): Promise<SharpMetadata> {
  let metadata: SharpMetadata;

  try {
    metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new BadRequestException(
      'La imagen no se pudo leer. Usa un JPG, PNG o WebP válido.',
    );
  }

  if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
    throw new BadRequestException(
      'Formato no admitido. Usa JPG, PNG o WebP.',
    );
  }

  if (!metadata.width || !metadata.height) {
    throw new BadRequestException('La imagen no tiene medidas válidas.');
  }

  return metadata;
}
