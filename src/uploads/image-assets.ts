/**
 * Derivación de las imágenes optimizadas a partir de la clave en R2.
 *
 * Una imagen optimizada no tiene un archivo "original": la clave es un prefijo
 * sin extensión con las medidas de origen (`.../{hash}-{ancho}x{alto}`) y las
 * variantes viven al lado con sufijo de ancho (`...-640.avif`, `...-1280.jpg`).
 *
 * Así la base de datos guarda una sola clave y las URLs se reconstruyen sin
 * consultar nada más.
 */

import { publicUrlForKey } from './r2';

/** Anchos de las variantes que se generan al subir una imagen. */
export const IMAGE_VARIANT_WIDTHS = [640, 1280] as const;

/** Una imagen optimizada nunca se reescribe: se puede cachear para siempre. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface ImageAssetVariant {
  /** Ancho real del archivo (px). */
  width: number;
  /** Alto real del archivo (px). */
  height: number;
  /** URL pública del archivo AVIF. */
  avif: string;
  /** URL pública del JPEG de respaldo (navegadores sin AVIF). */
  jpg: string;
}

export interface ImageAssets {
  /** Medidas de origen, después de aplicar la orientación EXIF. */
  width: number;
  height: number;
  /** Variantes ordenadas de menor a mayor ancho. */
  variants: ImageAssetVariant[];
}

/**
 * Anchos que se generan para una imagen de `width` x `height`.
 *
 * El ancho de referencia es el lado más largo: una foto vertical de 3000x4000
 * genera `-640` (640x480) y `-1280` (1280x960). Nunca se amplía una imagen: si
 * el origen mide 500 px, la única variante es de 500 px.
 */
export function variantWidths(width: number, height: number): number[] {
  const longest = Math.max(width, height);
  const widths = new Set<number>();

  for (const target of IMAGE_VARIANT_WIDTHS) {
    widths.add(Math.min(target, longest));
  }

  return [...widths].sort((a, b) => a - b);
}

/** Medidas de origen codificadas en la clave, o `null` si es una clave vieja. */
export function imageKeySize(
  key: string,
): { width: number; height: number } | null {
  const match = /-(\d+)x(\d+)$/.exec(key);

  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1) return null;

  return { width, height };
}

/** Variantes y URLs de una clave optimizada. `null` para claves antiguas. */
export function imageAssetsForKey(key: string): ImageAssets | null {
  const size = imageKeySize(key);

  if (!size) return null;

  const longest = Math.max(size.width, size.height);

  return {
    width: size.width,
    height: size.height,
    variants: variantWidths(size.width, size.height).map((variantWidth) => {
      const scale = variantWidth / longest;

      return {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        avif: publicUrlForKey(`${key}-${variantWidth}.avif`),
        jpg: publicUrlForKey(`${key}-${variantWidth}.jpg`),
      };
    }),
  };
}

/**
 * Claves de todos los objetos de una imagen optimizada.
 *
 * Devuelve una lista vacía para las claves antiguas (con extensión), que se
 * borran directamente.
 */
export function imageAssetObjectKeys(key: string): string[] {
  const size = imageKeySize(key);

  if (!size) return [];

  return variantWidths(size.width, size.height).flatMap((variantWidth) => [
    `${key}-${variantWidth}.avif`,
    `${key}-${variantWidth}.jpg`,
  ]);
}

/**
 * Todas las claves que hay que borrar para una imagen.
 *
 * Las claves optimizadas expanden a sus variantes; las antiguas devuelven el
 * objeto suelto para que el borrado siga funcionando con datos históricos.
 */
export function imageObjectKeys(key: string): string[] {
  const keys = imageAssetObjectKeys(key);

  return keys.length > 0 ? keys : [key];
}

/** URL del JPEG de mayor tamaño, que es el `src` de respaldo. */
export function imageFallbackUrl(assets: ImageAssets): string {
  return assets.variants[assets.variants.length - 1].jpg;
}

/** Clave del JPEG de mayor tamaño (para comprobar que existe). */
export function imageMainObjectKey(key: string): string | null {
  const size = imageKeySize(key);

  if (!size) return null;

  const width = variantWidths(size.width, size.height).at(-1);

  return `${key}-${width}.jpg`;
}
