// Reasigna los colores de los grupos de todos los menús a la nueva paleta.
//
// Uso:
//   node scripts/reassign-menu-group-colors.mjs            (dry run)
//   node scripts/reassign-menu-group-colors.mjs --apply    (escribe en la base)
//
// La asignación es por orden de grupo dentro de cada menú: primero todos los
// tonos 300, después los 500 y al final los 700.
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const apply = process.argv.includes('--apply');

const NAMES = [
  'sky',
  'indigo',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'lime',
  'green',
  'teal',
];

const SHADES = [300, 500, 700];

const SEQUENCE = SHADES.flatMap((shade) =>
  NAMES.map((name) => `${name}-${shade}`),
);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const menus = await prisma.menu.findMany({
    select: { id: true, name: true, groups: true },
    orderBy: [{ organizationId: 'asc' }, { sortOrder: 'asc' }],
  });

  console.log(`Menús encontrados: ${menus.length}.`);

  let updated = 0;
  let skipped = 0;

  for (const menu of menus) {
    if (menu.groups.length === 0) {
      skipped += 1;
      continue;
    }

    const groupColors = {};

    for (const [index, group] of menu.groups.entries()) {
      const color = SEQUENCE[index];

      if (color) groupColors[group] = color;
    }

    console.log(
      `${menu.name}: ${menu.groups.length} grupo(s) → ${Object.values(
        groupColors,
      ).join(', ')}`,
    );

    if (!apply) continue;

    await prisma.menu.update({
      where: { id: menu.id },
      data: { groupColors },
    });

    updated += 1;
  }

  if (apply) {
    console.log(`Menús actualizados: ${updated}. Sin grupos: ${skipped}.`);
  } else {
    console.log('Dry run. Ejecuta con --apply para escribir los cambios.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
