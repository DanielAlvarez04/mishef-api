// Purga eventos de analítica vencidos según la retención configurada.
//
// Uso:
//   node scripts/purge-analytics.mjs          (12 meses)
//   node scripts/purge-analytics.mjs 365      (mismo, explícito)
//   node scripts/purge-analytics.mjs 180      (6 meses)
//
// Requisitos:
//   - DATABASE_URL en `api/.env`.
//   - Ejecutar desde `api/` o con la ruta del paquete configurada.
//
// Recomendación: programarlo mensualmente en el VPS (cron o Dokploy) para
// cumplir con la retención mínima documentada en `deploy/DEPLOY.md`.
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const days = Number(process.argv[2] ?? 365);

if (!Number.isInteger(days) || days <= 0) {
  console.error('La retención debe ser un número entero de días mayor a cero.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en api/.env');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const cutoff = new Date(Date.now() - days * 86_400_000);

try {
  const result = await prisma.analyticsEvent.deleteMany({
    where: { occurredAt: { lt: cutoff } },
  });

  console.log(
    `Eventos de analítica purgados: ${result.count} (anteriores a ${cutoff.toISOString()}).`,
  );
} finally {
  await prisma.$disconnect();
}
