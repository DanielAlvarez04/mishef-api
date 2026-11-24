/**
 * Crea (o repara) la organización demo para probar todas las funciones.
 *
 * - Organización `demo` con todos los overrides de funciones en `true`.
 * - Usuario dueño, membresía ADMIN y sucursal principal.
 * - Ejecuta `seed-test-user.ts` para llenar catálogo, inventario y menús.
 *
 * Uso (desde api/, con devDependencies instaladas y DATABASE_URL local o de
 * producción):
 *   npm run demo:seed
 *   DEMO_PASSWORD="..." npm run demo:seed
 *
 * `demo` es una palabra reservada para altas normales, pero la API la resuelve
 * como tenant de demostración mediante `DEMO_TENANT_SLUGS` (por defecto
 * `demo`). El seed crea la organización directamente en la base.
 *
 * No se ejecuta dentro del contenedor de producción tal cual: la imagen solo
 * instala dependencias de producción y no incluye `ts-node`. Usa un túnel SSH a
 * la base o ejecútalo desde tu máquina con la `DATABASE_URL` de producción.
 *
 * Es idempotente para la organización, el usuario y la sucursal. El seed de
 * catálogo borra los datos de negocio, así que la demo debe reiniciarse antes
 * de acumular pedidos, caja o asistencia.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { config } from 'dotenv';
import { hash } from 'argon2';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const EMAIL = process.env.DEMO_EMAIL?.trim().toLowerCase() || 'demo@mishef.co';
const SLUG = process.env.DEMO_SLUG?.trim().toLowerCase() || 'demo';
const PASSWORD =
  process.env.DEMO_PASSWORD?.trim() ||
  `Demo-${Math.random().toString(36).slice(2, 10)}!`;
const NAME = process.env.DEMO_NAME?.trim() || 'Negocio Demo';
const USERNAME = process.env.DEMO_USERNAME?.trim().toLowerCase() || 'admin';

/**
 * Prepara las dependencias que solo existen en desarrollo.
 *
 * En local `src` y `ts-node` ya están. En el contenedor de producción no:
 * `src` se enlaza a `dist/src` (los archivos compilados) y `ts-node` se instala
 * temporalmente. El próximo deploy reinicia el contenedor y lo deja limpio.
 */
function prepareSeed() {
  if (!existsSync('src') && existsSync('dist/src')) {
    try {
      symlinkSync('dist/src', 'src', 'dir');
      console.log('Enlace src -> dist/src creado para el seed.');
    } catch {
      throw new Error(
        'No se pudo crear el enlace src. Ejecuta el contenedor como root: docker exec -u 0 ...',
      );
    }
  }

  if (existsSync('node_modules/ts-node')) return;

  if (process.env.NODE_ENV !== 'production') {
    throw new Error(
      'Falta ts-node. Ejecuta `npm install --legacy-peer-deps` en api/.',
    );
  }

  console.log('Instalando ts-node temporalmente dentro del contenedor…');
  try {
    execFileSync(
      'npm',
      [
        'install',
        '--no-save',
        '--legacy-peer-deps',
        'ts-node',
        'typescript',
      ],
      { stdio: 'inherit' },
    );
  } catch {
    throw new Error(
      'No se pudo instalar ts-node. Ejecuta el contenedor como root: docker exec -u 0 ...',
    );
  }
}

// Se mantiene sincronizado con src/common/features.ts.
const FEATURE_KEYS = [
  'dashboard',
  'menus',
  'pos',
  'pos.payments',
  'kitchen',
  'catalog',
  'catalog.ai',
  'inventory',
  'reports',
  'reports.food-cost',
  'reports.leakage',
  'reports.benchmark',
  'attendance',
  'waste',
  'purchases',
  'purchases.suggestions',
  'suppliers',
  'intel',
  'intel.notifications',
  'intel.anomalies',
  'settings',
  'users',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL en api/.env');
  }

  prepareSeed();

  const featureOverrides = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, true]),
  );

  const organization = await prisma.organization.upsert({
    where: { slug: SLUG },
    create: {
      name: NAME,
      slug: SLUG,
      practiceMode: false,
      featureOverrides,
    },
    update: {
      name: NAME,
      practiceMode: false,
      practiceUntil: null,
      featureOverrides,
    },
  });

  const passwordHash = await hash(PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    create: {
      email: EMAIL,
      username: 'demo',
      passwordHash,
      name: 'Demo Mishef',
      emailVerified: true,
      isActive: true,
      mustChangePassword: false,
      onboardedAt: new Date(),
    },
    update: {
      passwordHash,
      name: 'Demo Mishef',
      emailVerified: true,
      isActive: true,
      mustChangePassword: false,
      onboardedAt: new Date(),
    },
  });

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id, organizationId: organization.id },
  });

  if (membership) {
    await prisma.membership.update({
      where: { id: membership.id },
      data: {
        username: USERNAME,
        roles: ['ADMIN'],
        isActive: true,
        isOwner: true,
      },
    });
  } else {
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        username: USERNAME,
        roles: ['ADMIN'],
        isActive: true,
        isOwner: true,
      },
    });
  }

  // Plan legacy para que la facturación no bloquee el panel demo.
  const legacyPlan = await prisma.plan.findUnique({
    where: { code: 'legacy' },
  });

  if (legacyPlan) {
    await prisma.organizationSubscription.upsert({
      where: { organizationId: organization.id },
      create: {
        organizationId: organization.id,
        planId: legacyPlan.id,
        status: 'ACTIVE',
        provider: 'MANUAL',
        interval: 'MONTH',
        quantity: 1,
        unitAmount: 0,
        currency: legacyPlan.currency,
      },
      update: {
        planId: legacyPlan.id,
        status: 'ACTIVE',
        provider: 'MANUAL',
        quantity: 1,
        unitAmount: 0,
        currency: legacyPlan.currency,
      },
    });
  }

  // Llena catálogo, inventario y menús con el seed existente. Ese script borra
  // las sucursales de la organización, por eso la creamos después.
  // Se ejecuta el binario de `ts-node` con el mismo Node para que funcione en
  // Windows (los `.cmd` de npx fallan con `spawnSync` sin shell).
  const require = createRequire(import.meta.url);
  const tsNodeBin = require.resolve('ts-node/dist/bin.js');
  console.log('Sembrando catálogo completo…');
  execFileSync(
    process.execPath,
    [tsNodeBin, '--transpile-only', 'scripts/seed-test-user.ts', EMAIL],
    { stdio: 'inherit', cwd: process.cwd(), env: process.env },
  );

  const branch = await prisma.branch.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: 'Sucursal demo',
      },
    },
    create: {
      organizationId: organization.id,
      name: 'Sucursal demo',
      address: 'Calle Demo 123',
      isActive: true,
    },
    update: { isActive: true },
  });

  await prisma.membership.updateMany({
    where: { userId: user.id, organizationId: organization.id },
    data: { branchId: branch.id },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenant: SLUG,
        email: EMAIL,
        username: USERNAME,
        password: PASSWORD,
        organizationId: organization.id,
        branchId: branch.id,
        allFeatures: true,
        seeded: true,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
