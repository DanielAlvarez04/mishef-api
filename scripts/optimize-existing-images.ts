// @ts-nocheck
/**
 * Re-optimiza todas las imágenes existentes del catálogo.
 *
 * Sustituye el archivo original de R2 (o la URL externa de Unsplash) por las
 * variantes AVIF + JPEG, actualiza la base y borra el original. Es el paso que
 * deja "solo versiones optimizadas" en el bucket.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/optimize-existing-images.ts
 *   npx ts-node --transpile-only scripts/optimize-existing-images.ts --apply
 *
 * Sin `--apply` solo muestra el plan. Es idempotente: las filas que ya tienen
 * `imageVariants` se omiten.
 */
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  imageAssetsForKey,
  imageFallbackUrl,
  imageMainObjectKey,
  imageObjectKeys,
} from '../src/uploads/image-assets';
import { storeOptimizedImage } from '../src/uploads/image-storage';
import {
  catalogFolder,
  deleteR2Object,
  getR2Object,
  variantFolder,
} from '../src/uploads/r2';

config();

const apply = process.argv.includes('--apply');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** Descarga el origen: primero R2, luego la URL externa. */
async function readSource(row) {
  if (row.imageKey) {
    const buffer = await getR2Object(row.imageKey);

    if (buffer) return buffer;
  }

  if (row.imageUrl?.startsWith('http')) {
    const response = await fetch(row.imageUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }
  }

  return null;
}

/** Borra los objetos de la imagen anterior. */
async function deletePrevious(key) {
  if (!key) return;

  for (const objectKey of imageObjectKeys(key)) {
    await deleteR2Object(objectKey);
  }
}

async function processRow(row, folder, update) {
  if (!row.imageKey && !row.imageUrl) return 'vacía';

  // Ya optimizada y con metadatos: no hay nada que hacer.
  if (row.imageVariants) return 'omitida';

  // Clave optimizada pero sin JSON (una corrida anterior se cortó): se repara.
  const existing = row.imageKey ? imageAssetsForKey(row.imageKey) : null;

  if (existing) {
    const fallback = imageFallbackUrl(existing);
    const mainKey = imageMainObjectKey(row.imageKey);
    const exists = mainKey ? await getR2Object(mainKey) : null;

    if (exists) {
      if (apply) {
        await update({
          imageKey: row.imageKey,
          imageUrl: fallback,
          imageVariants: existing,
        });
      }

      return apply ? 'reparada' : 'reparar';
    }
  }

  const buffer = await readSource(row);

  if (!buffer) return 'sin origen';

  if (!apply) return 'optimizar';

  const stored = await storeOptimizedImage(folder, buffer);

  await update({
    imageKey: stored.key,
    imageUrl: imageFallbackUrl(stored.assets),
    imageVariants: stored.assets,
  });

  await deletePrevious(row.imageKey);

  return 'optimizada';
}

async function main() {
  if (!apply) {
    console.log('Modo simulación. Añade --apply para escribir cambios.\n');
  }

  const entries = await prisma.catalogEntry.findMany({
    where: {
      OR: [{ imageKey: { not: null } }, { imageUrl: { not: null } }],
    },
    select: {
      id: true,
      organizationId: true,
      imageKey: true,
      imageUrl: true,
      imageVariants: true,
      imageName: true,
      items: { select: { name: true }, take: 1 },
      recipes: { select: { name: true }, take: 1 },
    },
    orderBy: { id: 'asc' },
  });

  const counts = {};

  for (const entry of entries) {
    const name =
      entry.items[0]?.name ?? entry.recipes[0]?.name ?? entry.id.slice(0, 8);

    if (!entry.organizationId) {
      console.log(`- ${name}: sin organización, se omite`);
      continue;
    }

    const result = await processRow(
      entry,
      catalogFolder(entry.organizationId, entry.id),
      (data) =>
        prisma.catalogEntry.update({ where: { id: entry.id }, data }),
    );

    counts[result] = (counts[result] ?? 0) + 1;
    console.log(`- ${name}: ${result}`);
  }

  const variants = await prisma.itemVariant.findMany({
    where: {
      OR: [{ imageKey: { not: null } }, { imageUrl: { not: null } }],
      item: { catalogEntryId: { not: null } },
    },
    select: {
      id: true,
      name: true,
      imageKey: true,
      imageUrl: true,
      imageVariants: true,
      item: {
        select: {
          name: true,
          organizationId: true,
          catalogEntryId: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  for (const variant of variants) {
    const { item } = variant;

    if (!item.organizationId || !item.catalogEntryId) continue;

    const label = `${item.name} · ${variant.name}`;
    const result = await processRow(
      variant,
      variantFolder(
        item.organizationId,
        item.catalogEntryId,
        variant.id,
      ),
      (data) =>
        prisma.itemVariant.update({ where: { id: variant.id }, data }),
    );

    counts[result] = (counts[result] ?? 0) + 1;
    console.log(`- ${label}: ${result}`);
  }

  console.log('\nResumen:');
  for (const [result, count] of Object.entries(counts)) {
    console.log(`  ${result}: ${count}`);
  }

  if (!apply) {
    console.log('\nNo se escribió nada. Ejecuta con --apply para aplicar.');
  }
}

main()
  .catch((error) => {
    console.error('Falló:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
