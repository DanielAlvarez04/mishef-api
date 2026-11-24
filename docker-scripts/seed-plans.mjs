// Crea los planes comerciales de Mishef en la base de datos.
//
// Las migraciones crean la tabla `Plan`, pero no insertan filas: sin esto la
// app no tiene precios que mostrar y `create-platform-admin.mjs` no puede
// asignar el plan Legacy a la cuenta interna.
//
// Uso:
//   node scripts/seed-plans.mjs            (crea los que falten; no toca los existentes)
//   node scripts/seed-plans.mjs --update   (sincroniza precios y límites con estos valores)
//
// Requisitos:
//   - DATABASE_URL en `api/.env` (o en el entorno del contenedor).
//   - Ejecutar desde `api/`.
//
// El modo por defecto es conservador a propósito: si alguien ajustó precios o
// límites desde `/plans`, volver a correr el script no revierte esos cambios.

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en api/.env');
  process.exit(1);
}

const apply = process.argv.includes('--update');

const GB = 1024n * 1024n * 1024n;

const PLANS = [
  {
    id: 'plan_esencial',
    code: 'esencial',
    name: 'Esencial',
    description: 'Para un solo local que está empezando.',
    priceMonthly: '499',
    priceYearly: '4990',
    currency: 'MXN',
    perBranch: false,
    trialDays: 14,
    maxBranches: 1,
    maxUsersPerBranch: 10,
    maxImagesPerItem: 1,
    maxVideosPerItem: 0,
    maxStorageBytes: GB,
    maxInventoryItems: 1000,
    customDomain: false,
    isActive: true,
    isPublic: true,
    sortOrder: 1,
    features: {
      domain: 'negocio.mishef.co',
      support: 'Soporte por correo',
    },
  },
  {
    id: 'plan_expansion',
    code: 'expansion',
    name: 'Expansión',
    description: 'Para negocios con varias sucursales y más contenido.',
    priceMonthly: '799',
    priceYearly: '7990',
    currency: 'MXN',
    perBranch: true,
    trialDays: 14,
    maxBranches: null,
    maxUsersPerBranch: 25,
    maxImagesPerItem: 5,
    maxVideosPerItem: 1,
    maxStorageBytes: null,
    maxInventoryItems: null,
    customDomain: true,
    isActive: true,
    isPublic: true,
    sortOrder: 2,
    features: {
      domain: 'dominio personalizado',
      support: 'Soporte prioritario',
    },
  },
  {
    id: 'plan_legacy',
    code: 'legacy',
    name: 'Legacy',
    description: 'Plan interno para negocios que ya estaban con Mishef.',
    priceMonthly: '0',
    priceYearly: '0',
    currency: 'MXN',
    perBranch: false,
    trialDays: 0,
    maxBranches: null,
    maxUsersPerBranch: null,
    maxImagesPerItem: 99,
    maxVideosPerItem: 99,
    maxStorageBytes: null,
    maxInventoryItems: null,
    customDomain: true,
    isActive: true,
    isPublic: false,
    sortOrder: 99,
    features: {
      domain: 'dominio personalizado',
      support: 'Soporte heredado',
    },
  },
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  }),
});

async function main() {
  const result = [];

  for (const plan of PLANS) {
    const existing = await prisma.plan.findUnique({
      where: { code: plan.code },
      select: { id: true },
    });

    if (!existing) {
      await prisma.plan.create({ data: plan });
      result.push({ code: plan.code, action: 'created' });
      continue;
    }

    if (!apply) {
      result.push({ code: plan.code, action: 'exists' });
      continue;
    }

    const { id: _id, ...data } = plan;
    await prisma.plan.update({ where: { code: plan.code }, data });
    result.push({ code: plan.code, action: 'updated' });
  }

  console.log(JSON.stringify({ ok: true, apply, plans: result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
