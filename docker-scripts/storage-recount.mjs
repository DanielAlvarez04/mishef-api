// Recalcula el contador de almacenamiento (`Organization.storageBytes`).
//
// Sirve para el arranque (las imágenes subidas antes de existir la cuota no
// estaban contadas) y para corregir desviaciones. Suma el tamaño real de los
// objetos del bucket, ignorando `{org}/tmp/` (subidas temporales que la regla
// de ciclo de vida borra en 24 h).
//
// Uso:
//   node scripts/storage-recount.mjs           (solo muestra; no escribe)
//   node scripts/storage-recount.mjs --apply   (actualiza la base)
//
// Requisitos:
//   - DATABASE_URL y las variables R2_* en `api/.env`.
//   - Ejecutar desde `api/`.

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

config();

const apply = process.argv.includes('--apply');

for (const name of [
  'DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]) {
  if (!process.env[name]) {
    console.error(`Falta ${name} en api/.env`);
    process.exit(1);
  }
}

const bucket = process.env.R2_BUCKET || 'mishef-public';

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

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;

  return mb >= 1024
    ? `${(mb / 1024).toFixed(2)} GB`
    : `${mb.toFixed(2)} MB`;
}

try {
  /** Bytes por organización (primer segmento de la clave). */
  const totals = new Map();
  let continuationToken;
  let objects = 0;
  let ignored = 0;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents ?? []) {
      const key = item.Key ?? '';
      const [organizationId, folder] = key.split('/');

      if (!organizationId) continue;

      if (folder === 'tmp') {
        ignored += 1;
        continue;
      }

      totals.set(
        organizationId,
        (totals.get(organizationId) ?? 0) + (item.Size ?? 0),
      );
      objects += 1;
    }

    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);

  const organizations = await prisma.organization.findMany({
    select: { id: true, name: true, storageBytes: true },
  });
  const byId = new Map(organizations.map((org) => [org.id, org]));

  console.log(`Bucket ${bucket}: ${objects} objetos contados, ${ignored} en tmp/.`);

  let total = 0;

  for (const [organizationId, bytes] of [...totals.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    total += bytes;

    const organization = byId.get(organizationId);

    if (!organization) {
      console.warn(
        `  ${organizationId}: ${formatBytes(bytes)} — sin organización (huérfano)`,
      );
      continue;
    }

    const before = Number(organization.storageBytes ?? 0n);

    if (apply) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { storageBytes: BigInt(bytes) },
      });
    }

    console.log(
      `  ${organization.name} (${organizationId}): ` +
        `${formatBytes(before)} → ${formatBytes(bytes)}${apply ? '' : ' (simulación)'}`,
    );
  }

  console.log(`Total contado: ${formatBytes(total)}.`);

  if (!apply) {
    console.log('No se escribió nada. Repite con --apply para actualizar.');
  }
} finally {
  await prisma.$disconnect();
}
