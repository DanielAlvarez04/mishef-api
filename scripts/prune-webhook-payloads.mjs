// Vacía los payloads de webhooks de Mercado Pago ya procesados y borra los
// eventos viejos. Reduce la retención de PII (correos, IDs de pago) sin perder
// la traza de qué se procesó.
//
// Uso:
//   node scripts/prune-webhook-payloads.mjs          (30 días)
//   node scripts/prune-webhook-payloads.mjs 90       (90 días)
//
// Requisitos:
//   - DATABASE_URL en `api/.env`.
//   - Ejecutar desde `api/`.
//
// Recomendación: cron diario en el VPS/Dokploy; ver `docs/mercado-pago.md`.
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const days = Number(process.argv[2] ?? process.env.MP_WEBHOOK_RETENTION_DAYS ?? 30);

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
  const [mp, billing] = await Promise.all([
    prisma.mercadoPagoWebhookEvent.updateMany({
      where: { receivedAt: { lt: cutoff }, processedAt: { not: null } },
      data: { payload: {} },
    }),
    prisma.billingWebhookEvent.updateMany({
      where: { receivedAt: { lt: cutoff }, processedAt: { not: null } },
      data: { payload: {} },
    }),
  ]);

  console.log(
    `Payloads vaciados (anteriores a ${cutoff.toISOString()}): mercadopago=${mp.count}, billing=${billing.count}.`,
  );
} finally {
  await prisma.$disconnect();
}
