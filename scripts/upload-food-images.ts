// @ts-nocheck
/**
 * Sube imágenes ilustrativas de comida (Unsplash) a R2 para el usuario de
 * pruebas. Deja **solo** las variantes optimizadas (AVIF + JPEG): el original
 * se procesa en memoria y nunca se guarda.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/upload-food-images.ts
 *
 * Es idempotente: omite las filas que ya tienen `imageVariants`.
 */
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  imageFallbackUrl,
  imageObjectKeys,
} from '../src/uploads/image-assets';
import { storeOptimizedImage } from '../src/uploads/image-storage';
import {
  catalogFolder,
  deleteR2Object,
  variantFolder,
} from '../src/uploads/r2';

config();

const EMAIL = process.argv[2] ?? 'portafolio.d.alvarez@gmail.com';
const FALLBACK_PHOTO = '1504674900247-0877df9cc836';

/** Foto de Unsplash por artículo/receta. */
const ENTRY_PHOTOS = {
  'Hamburguesa clásica': '1568901346375-23c9450c58cd',
  'Tacos al pastor (3 pz)': '1613514785940-daed07799d9b',
  'Pizza margarita': '1565299624946-b28f40a0ae38',
  'Ensalada césar': '1546069901-ba9599a7e63c',
  'Pasta Alfredo': '1551183053-bf91a1d81141',
  'Chilaquiles verdes': '1552332386-f8dd00dc2f85',
  'Sándwich de pollo': '1530610476181-d83430b64dcd',
  'Croissant de mantequilla': '1555507036-ab1f4038808a',
  'Brownie con nuez': '1565958011703-44f9829ba187',
  'Latte vainilla': '1495474472287-4d71bcdd2085',
  'Agua mineral': '1513558161293-cdaf765ed2fd',
  'Refresco de cola': '1544145945-f90425340c7e',
  'Jugo de naranja': '1600271886742-f049cd451bba',
  'Té helado': '1517701550927-30cf4ba1dba5',
  'Café americano': '1461023058943-07fcbe16d735',
  'Papas a la francesa': '1504674900247-0877df9cc836',
  'Aros de cebolla': '1550317138-10000687a72b',
  'Galleta con chispas de chocolate': '1551024506-0bccd828d307',
  'Yogur con granola': '1488477181946-6428a0291777',
  'Barra de chocolate': '1578985545062-69928b1d9587',
  'Combo familiar': '1504674900247-0877df9cc836',
  'Salsa roja base': '1598866594230-a7c12756260f',
  'Salsa verde base': '1552332386-f8dd00dc2f85',
  'Adobo de pollo': '1600891964092-4316c288032e',
  'Crema Alfredo': '1473093295043-cdd812d0e601',
  'Ganache de chocolate': '1551024506-0bccd828d307',
  'Masa para pizza': '1574071318508-1cdbab80d002',
  'Frijoles refritos': '1595708684082-a173bb3a06c5',
  'Arroz rojo': '1504674900247-0877df9cc836',
  'Vinagreta de la casa': '1546793665-c74683f339c1',
  'Pollo marinado': '1600891964092-4316c288032e',
};

/** Foto por presentación: `artículo|presentación`. */
const VARIANT_PHOTOS = {
  'Hamburguesa clásica|Sencilla': '1568901346375-23c9450c58cd',
  'Hamburguesa clásica|Doble': '1550547660-d9450f859349',
  'Pizza margarita|Personal': '1574071318508-1cdbab80d002',
  'Pizza margarita|Mediana': '1565299624946-b28f40a0ae38',
  'Pizza margarita|Grande': '1593560708920-61dd98c46a4e',
  'Latte vainilla|Mediano': '1495474472287-4d71bcdd2085',
  'Latte vainilla|Grande': '1509042239860-f550ce710b93',
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function photoUrl(photoId) {
  return `https://images.unsplash.com/photo-${photoId}?w=800&h=800&fit=crop&q=82`;
}

function photoIdFor(name, variantName) {
  if (variantName) {
    const key = `${name}|${variantName}`;
    if (VARIANT_PHOTOS[key]) return VARIANT_PHOTOS[key];
  }

  return ENTRY_PHOTOS[name] ?? FALLBACK_PHOTO;
}

async function download(photoId) {
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(photoUrl(photoId), {
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = Buffer.from(await response.arrayBuffer());

      if (body.length < 2000) {
        throw new Error(`imagen demasiado pequeña (${body.length} bytes)`);
      }

      return body;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function deletePrevious(key) {
  if (!key) return;

  for (const objectKey of imageObjectKeys(key)) {
    await deleteR2Object(objectKey);
  }
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    include: {
      memberships: {
        where: { isActive: true, organization: { isActive: true } },
        include: { organization: true },
      },
    },
  });

  const organization = user?.memberships.find((row) => row.organization)
    ?.organization;

  if (!organization) {
    throw new Error(`Sin organización activa para ${EMAIL}`);
  }

  const organizationId = organization.id;
  const entries = await prisma.catalogEntry.findMany({
    where: { organizationId },
    include: {
      items: { select: { name: true } },
      recipes: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });

  let uploadedEntries = 0;
  let skippedEntries = 0;
  let failedEntries = 0;

  for (const entry of entries) {
    if (entry.imageVariants) {
      skippedEntries += 1;
      continue;
    }

    const name = entry.items[0]?.name ?? entry.recipes[0]?.name ?? 'Artículo';
    const photoId = photoIdFor(name);

    try {
      const body = await download(photoId);
      const stored = await storeOptimizedImage(
        catalogFolder(organizationId, entry.id),
        body,
      );

      await prisma.catalogEntry.update({
        where: { id: entry.id },
        data: {
          imageKey: stored.key,
          imageUrl: imageFallbackUrl(stored.assets),
          imageVariants: stored.assets,
          imageName: entry.imageName,
        },
      });

      await deletePrevious(entry.imageKey);

      uploadedEntries += 1;
      console.log(`✓ ${name}`);
    } catch (error) {
      failedEntries += 1;
      console.error(
        `✗ ${name}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const variants = await prisma.itemVariant.findMany({
    where: {
      item: {
        organizationId,
        catalogEntryId: { not: null },
      },
    },
    include: {
      item: { select: { name: true, catalogEntryId: true } },
    },
    orderBy: { id: 'asc' },
  });

  let uploadedVariants = 0;
  let skippedVariants = 0;
  let failedVariants = 0;

  for (const variant of variants) {
    if (!variant.item.catalogEntryId) continue;

    if (variant.imageVariants) {
      skippedVariants += 1;
      continue;
    }

    const photoId = photoIdFor(variant.item.name, variant.name);

    try {
      const body = await download(photoId);
      const stored = await storeOptimizedImage(
        variantFolder(
          organizationId,
          variant.item.catalogEntryId,
          variant.id,
        ),
        body,
      );

      await prisma.itemVariant.update({
        where: { id: variant.id },
        data: {
          imageKey: stored.key,
          imageUrl: imageFallbackUrl(stored.assets),
          imageVariants: stored.assets,
          imageName: variant.imageName,
        },
      });

      await deletePrevious(variant.imageKey);

      uploadedVariants += 1;
      console.log(`✓ ${variant.item.name} · ${variant.name}`);
    } catch (error) {
      failedVariants += 1;
      console.error(
        `✗ ${variant.item.name} · ${variant.name}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  console.log('Listo:');
  console.log(`  Entradas subidas : ${uploadedEntries}`);
  console.log(`  Entradas omitidas: ${skippedEntries}`);
  console.log(`  Entradas fallidas: ${failedEntries}`);
  console.log(`  Variantes subidas: ${uploadedVariants}`);
  console.log(`  Variantes omitidas: ${skippedVariants}`);
  console.log(`  Variantes fallidas: ${failedVariants}`);
}

main()
  .catch((error) => {
    console.error('Falló:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
