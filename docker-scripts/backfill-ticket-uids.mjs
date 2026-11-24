/**
 * Backfill de sucursal y folios de ticket para cuentas anteriores.
 *
 * - Asigna la única sucursal activa a las cuentas que quedaron sin sucursal.
 * - Genera `ticketNumber` y `ticketUid` (AAAAMMDD + 3 dígitos) por sucursal y
 *   día del negocio, respetando los números que ya existan.
 *
 * Uso:
 *   node scripts/backfill-ticket-uids.mjs          # simulación
 *   node scripts/backfill-ticket-uids.mjs --apply  # aplica cambios
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const APPLY = process.argv.includes('--apply');
const TIME_ZONE = 'America/Mexico_City';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  }),
});

function dayKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = new Map(parts.map((part) => [part.type, part.value]));

  return `${value.get('year')}${value.get('month')}${value.get('day')}`;
}

function dayDate(date) {
  const key = dayKey(date);

  return new Date(
    `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00.000Z`,
  );
}

function padded(value) {
  return String(value).padStart(3, '0');
}

function ticketUid(date, number) {
  return `${dayKey(date)}${padded(number)}`;
}

async function main() {
  const organizations = await prisma.organization.findMany({
    where: { slug: { not: 'mishef-platform' } },
    select: {
      id: true,
      name: true,
      branches: {
        where: { isActive: true },
        select: { id: true, name: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  for (const organization of organizations) {
    console.log(`\n${organization.name} (${organization.id})`);

    if (organization.branches.length === 1) {
      const branch = organization.branches[0];
      const orphans = await prisma.order.count({
        where: { organizationId: organization.id, branchId: null },
      });

      if (orphans > 0) {
        console.log(`  ${orphans} cuenta(s) sin sucursal → ${branch.name}`);

        if (APPLY) {
          await prisma.order.updateMany({
            where: { organizationId: organization.id, branchId: null },
            data: { branchId: branch.id },
          });
        }
      }
    } else if (organization.branches.length > 1) {
      const orphans = await prisma.order.count({
        where: { organizationId: organization.id, branchId: null },
      });

      if (orphans > 0) {
        console.log(
          `  ${orphans} cuenta(s) sin sucursal; hay ${organization.branches.length} sucursales, se omiten.`,
        );
      }
    } else {
      const orphans = await prisma.order.count({
        where: { organizationId: organization.id, branchId: null },
      });

      if (orphans > 0) {
        console.log(
          `  ${orphans} cuenta(s) sin sucursal y el negocio no tiene sucursales activas; se omiten.`,
        );
      }
    }

    for (const branch of organization.branches) {
      const pending = await prisma.order.findMany({
        where: {
          branchId: branch.id,
          OR: [{ ticketNumber: null }, { ticketUid: null }],
        },
        select: {
          id: true,
          createdAt: true,
          ticketNumber: true,
          ticketUid: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (pending.length === 0) continue;

      const existing = await prisma.order.findMany({
        where: { branchId: branch.id, ticketNumber: { not: null } },
        select: { createdAt: true, ticketNumber: true },
      });
      const maxByDay = new Map();

      for (const order of existing) {
        const key = dayKey(order.createdAt);
        maxByDay.set(
          key,
          Math.max(maxByDay.get(key) ?? 0, order.ticketNumber),
        );
      }

      console.log(`  ${branch.name}: ${pending.length} cuenta(s)`);

      const sequences = new Map();

      for (const order of pending) {
        const key = dayKey(order.createdAt);
        const mapKey = `${branch.id}|${key}`;

        if (!sequences.has(mapKey)) {
          const day = dayDate(order.createdAt);
          const sequence = await prisma.branchDailySequence.findUnique({
            where: {
              branchId_date: { branchId: branch.id, date: day },
            },
            select: { lastNumber: true },
          });

          sequences.set(mapKey, {
            day,
            last: Math.max(
              sequence?.lastNumber ?? 0,
              maxByDay.get(key) ?? 0,
            ),
          });
        }

        const state = sequences.get(mapKey);
        let number = order.ticketNumber;
        let uid = order.ticketUid;

        if (!number) {
          state.last += 1;
          number = state.last;
        }

        if (!uid) {
          uid = ticketUid(order.createdAt, number);
        }

        console.log(
          `    ${order.id}: ${key} → #${padded(number)} (${uid})`,
        );

        if (APPLY) {
          await prisma.order.update({
            where: { id: order.id },
            data: { ticketNumber: number, ticketUid: uid },
          });
        }
      }

      if (APPLY) {
        for (const state of sequences.values()) {
          await prisma.branchDailySequence.upsert({
            where: {
              branchId_date: { branchId: branch.id, date: state.day },
            },
            create: {
              branchId: branch.id,
              date: state.day,
              lastNumber: state.last,
            },
            update: { lastNumber: state.last },
          });
        }
      }
    }
  }

  console.log(
    APPLY
      ? '\nBackfill aplicado.'
      : '\nSimulación terminada. Ejecuta con --apply para guardar.',
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
