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
 * También puede ejecutarse dentro del contenedor de producción:
 *   docker exec -u 0 -e DEMO_PASSWORD="..." <api> node scripts/seed-demo-org.mjs
 * `prepareSeed` crea el enlace `src -> dist/src` e instala `ts-node` temporalmente
 * porque la imagen solo trae dependencias de producción.
 *
 * Es idempotente para la organización, el usuario y la sucursal. El seed de
 * catálogo borra los datos de negocio, así que la demo debe reiniciarse antes
 * de acumular pedidos, caja o asistencia.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 * en `.seed-deps` para no tocar el `node_modules` de la API. El próximo deploy
 * reinicia el contenedor y lo deja limpio.
 */
const SEED_DEPS_DIR = '.seed-deps';
const SEED_TS_NODE = 'ts-node@10.9.2';
const SEED_TYPESCRIPT = 'typescript@5.6.3';

// La imagen de producción no copia `tsconfig.json`. Sin estas opciones ts-node
// usa `module: NodeNext` por defecto y falla con TS5109.
const TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  target: 'ES2022',
  esModuleInterop: true,
});

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

  // En local están las devDependencies: se usa el binario del proyecto.
  const localBin = 'node_modules/ts-node/dist/bin.js';
  if (existsSync(localBin)) return localBin;

  const seedBin = `${SEED_DEPS_DIR}/node_modules/ts-node/dist/bin.js`;

  if (!existsSync(seedBin)) {
    mkdirSync(SEED_DEPS_DIR, { recursive: true });
    writeFileSync(`${SEED_DEPS_DIR}/package.json`, '{"private":true}\n');

    console.log('Instalando ts-node temporalmente dentro del contenedor…');
    try {
      execFileSync(
        'npm',
        [
          'install',
          '--prefix',
          SEED_DEPS_DIR,
          '--no-save',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          SEED_TS_NODE,
          SEED_TYPESCRIPT,
        ],
        {
          stdio: 'inherit',
          // `NODE_ENV=production` haría que npm omitiera estas devDependencies.
          env: { ...process.env, NODE_ENV: 'development' },
        },
      );
    } catch {
      throw new Error(
        'No se pudo instalar ts-node. Ejecuta el contenedor como root: docker exec -u 0 ...',
      );
    }
  }

  if (!existsSync(seedBin)) {
    throw new Error('ts-node no quedó instalado en .seed-deps');
  }

  return seedBin;
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

  const tsNodeBin = prepareSeed();

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
  const seedTestUser = fileURLToPath(
    new URL('./seed-test-user.ts', import.meta.url),
  );
  console.log('Sembrando catálogo completo…');
  execFileSync(
    process.execPath,
    [tsNodeBin, '--transpile-only', seedTestUser, EMAIL],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, TS_NODE_COMPILER_OPTIONS },
    },
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
