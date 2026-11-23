// Reasigna los colores de los grupos de los menús globales.
//
// El primer grupo siempre es Combos; el resto va en orden alfabético. Este
// script vuelve a repartir la paleta en ese mismo orden para que la secuencia
// sea legible.
//
// Uso:
//   node scripts/reassign-global-menu-colors.mjs            (dry run)
//   node scripts/reassign-global-menu-colors.mjs --apply    (escribe en la base)
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const GROUP_COLOR_NAMES = [
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
const GROUP_COLOR_SHADES = [300, 500, 700];
const GROUP_COLOR_SEQUENCE = GROUP_COLOR_SHADES.flatMap((shade) =>
  GROUP_COLOR_NAMES.map((name) => `${name}-${shade}`),
);

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const menus = await prisma.menu.findMany({
  where: { isGlobal: true },
  select: { id: true, name: true, groups: true, groupColors: true },
  orderBy: [{ organizationId: 'asc' }, { name: 'asc' }],
});

let updated = 0;

for (const menu of menus) {
  const rest = menu.groups
    .filter((group) => group !== 'Combos')
    .sort((left, right) =>
      left.localeCompare(right, 'es', { sensitivity: 'base' }),
    );
  const groups = menu.groups.includes('Combos')
    ? ['Combos', ...rest]
    : rest;

  if (groups.length > GROUP_COLOR_SEQUENCE.length) {
    console.warn(
      `${menu.name}: ${groups.length} grupos; la paleta solo tiene ${GROUP_COLOR_SEQUENCE.length} colores.`,
    );
  }

  const groupColors = {};

  groups.forEach((group, index) => {
    const color = GROUP_COLOR_SEQUENCE[index];

    if (color) groupColors[group] = color;
  });

  const sameGroups =
    groups.join('\u0000') === menu.groups.join('\u0000');
  const previousColors = menu.groupColors ?? {};
  const sameColors =
    groups.every((group) => previousColors[group] === groupColors[group]) &&
    Object.keys(previousColors).length === Object.keys(groupColors).length;

  if (sameGroups && sameColors) {
    console.log(`${menu.name}: sin cambios.`);
    continue;
  }

  console.log(`\n${menu.name}`);
  console.log(`  grupos: ${menu.groups.join(', ')} → ${groups.join(', ')}`);

  for (const group of groups) {
    const before = previousColors[group] ?? '—';
    const after = groupColors[group] ?? '—';

    if (before !== after) console.log(`  ${group}: ${before} → ${after}`);
  }

  if (apply) {
    await prisma.menu.update({
      where: { id: menu.id },
      data: { groups, groupColors },
    });
    updated += 1;
  }
}

if (!apply) {
  console.log('\nDry run. Ejecuta con --apply para escribir los cambios.');
} else {
  console.log(`\nMenús actualizados: ${updated} de ${menus.length}.`);
}

await prisma.$disconnect();
