// Migra las imágenes del catálogo a la carpeta global
// `{org}/catalog/{catalogEntryId}/...`.
//
// Uso:
//   node scripts/migrate-catalog-assets.mjs            (dry run, no toca nada)
//   node scripts/migrate-catalog-assets.mjs --apply    (mueve y actualiza)
//   node scripts/migrate-catalog-assets.mjs --apply --keep-source
//   node scripts/migrate-catalog-assets.mjs --apply --prune-orphans
//
// Requisitos:
//   - Migración `20261104120000_catalog_entry` aplicada (crea CatalogEntry y
//     hace el backfill de metadatos). Las columnas viejas todavía existen.
//   - Variables de R2 y DATABASE_URL en `api/.env`.
//
// El script es idempotente: si la clave ya está en la carpeta de la entrada, no
// toca nada. Copia el objeto, comprueba que existe el destino, actualiza la
// base y solo entonces borra el original.
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

config();

const args = new Set(process.argv.slice(2));
// Por seguridad, sin `--apply` solo se muestra el plan.
const dryRun = !args.has('--apply');
const keepSource = args.has('--keep-source');
const pruneOrphans = args.has('--prune-orphans');

const bucket = process.env.R2_BUCKET || 'sazona-public';
const publicBase = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!publicBase) {
  console.error('Falta R2_PUBLIC_BASE_URL en api/.env');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const s3 = new S3Client({
  region: 'auto',
  endpoint:
    process.env.R2_ENDPOINT ||
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function targetFolder(organizationId, entryId) {
  return `${organizationId}/catalog/${entryId}`;
}

function basename(key) {
  return key.split('/').pop();
}

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function copy(sourceKey, targetKey) {
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${sourceKey}`,
      Key: targetKey,
    }),
  );
}

async function remove(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function main() {
  const entries = await prisma.catalogEntry.findMany({
    where: { imageKey: { not: null } },
    select: {
      id: true,
      organizationId: true,
      imageKey: true,
      imageUrl: true,
    },
    orderBy: { id: 'asc' },
  });

  const moves = [];

  for (const entry of entries) {
    if (!entry.organizationId || !entry.imageKey) continue;

    const folder = targetFolder(entry.organizationId, entry.id);
    const currentKey = entry.imageKey;

    if (currentKey.startsWith(`${folder}/`)) continue;

    const targetKey = `${folder}/${basename(currentKey)}`;
    moves.push({ entry, currentKey, targetKey });
  }

  console.log(
    `Entradas con imagen: ${entries.length}. Por mover: ${moves.length}.`,
  );

  let moved = 0;
  let failed = 0;

  for (const { entry, currentKey, targetKey } of moves) {
    console.log(`${dryRun ? '[plan]' : '[move]'} ${currentKey} -> ${targetKey}`);

    if (dryRun) continue;

    try {
      if (!(await exists(targetKey))) {
        await copy(currentKey, targetKey);
      }

      if (!(await exists(targetKey))) {
        throw new Error('la copia no aparece en el destino');
      }

      await prisma.catalogEntry.update({
        where: { id: entry.id },
        data: {
          imageKey: targetKey,
          imageUrl: `${publicBase}/${targetKey}`,
        },
      });

      if (!keepSource) await remove(currentKey);
      moved += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `  ERROR ${entry.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Objetos que quedaron apuntando a una carpeta vieja y ya no son la imagen
  // elegida de ninguna entrada (p. ej. la copia de la receta cuando el artículo
  // ya tenía la suya). Solo se borran con --prune-orphans.
  if (pruneOrphans) {
    let itemRows = [];
    let recipeRows = [];

    try {
      [itemRows, recipeRows] = await Promise.all([
        prisma.$queryRawUnsafe(
          'SELECT "imageKey" FROM "Product" WHERE "imageKey" IS NOT NULL',
        ),
        prisma.$queryRawUnsafe(
          'SELECT "imageKey" FROM "Recipe" WHERE "imageKey" IS NOT NULL',
        ),
      ]);
    } catch {
      console.log(
        'Las columnas viejas ya no existen; se omite --prune-orphans.',
      );
    }

    const live = new Set(
      entries.map((entry) => entry.imageKey).filter(Boolean),
    );

    // Las claves que se acaban de mover también siguen vivas en el destino.
    for (const { targetKey } of moves) live.add(targetKey);

    const orphans = new Set(
      [...itemRows, ...recipeRows]
        .map((row) => row.imageKey)
        .filter((key) => key && !live.has(key)),
    );

    for (const key of orphans) {
      console.log(`${dryRun ? '[plan-orphan]' : '[orphan]'} ${key}`);

      if (!dryRun) {
        try {
          await remove(key);
        } catch (error) {
          console.error(
            `  ERROR ${key}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }

  console.log(
    dryRun
      ? 'Dry run: no se modificó nada.'
      : `Listo. Movidas: ${moved}. Errores: ${failed}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
