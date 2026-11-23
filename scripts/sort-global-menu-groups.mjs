// Ordena alfabéticamente los grupos de los menús globales existentes.
//
// Uso:
//   node scripts/sort-global-menu-groups.mjs            (dry run)
//   node scripts/sort-global-menu-groups.mjs --apply    (escribe en la base)
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const menus = await prisma.menu.findMany({
  where: { isGlobal: true },
  select: { id: true, name: true, groups: true },
  orderBy: [{ organizationId: 'asc' }, { name: 'asc' }],
});

let updated = 0;

for (const menu of menus) {
  const groups = [...menu.groups].sort((left, right) =>
    left.localeCompare(right, 'es', { sensitivity: 'base' }),
  );

  if (groups.join('\u0000') === menu.groups.join('\u0000')) continue;

  console.log(`${menu.name}: ${menu.groups.join(', ')} → ${groups.join(', ')}`);

  if (apply) {
    await prisma.menu.update({
      where: { id: menu.id },
      data: { groups },
    });
    updated += 1;
  }
}

if (!apply) {
  console.log('Dry run. Ejecuta con --apply para escribir los cambios.');
} else {
  console.log(`Menús actualizados: ${updated} de ${menus.length}.`);
}

await prisma.$disconnect();
