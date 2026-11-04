// Convierte las recetas antiguas por presentación (`Recipe.variantId`) en
// filas con alcance dentro de la receta base.
//
// Uso:
//   node scripts/migrate-recipe-scopes.mjs            (dry run)
//   node scripts/migrate-recipe-scopes.mjs --apply    (convierte)
//
// Las recetas viejas no se borran: se desactivan para conservar el historial y
// los pedidos que las referencian.
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

config();

const apply = process.argv.includes('--apply');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const legacy = await prisma.recipe.findMany({
    where: { variantId: { not: null } },
    include: {
      variant: { select: { id: true, name: true } },
      ingredients: {
        orderBy: { sortOrder: 'asc' },
        include: {
          options: {
            orderBy: { sortOrder: 'asc' },
            select: { ingredientId: true, quantity: true, sortOrder: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Recetas por presentación encontradas: ${legacy.length}.`);

  let converted = 0;
  let skipped = 0;

  for (const recipe of legacy) {
    if (!recipe.itemId || !recipe.variantId) {
      skipped += 1;
      continue;
    }

    const base = await prisma.recipe.findFirst({
      where: { itemId: recipe.itemId, variantId: null },
      select: { id: true },
    });

    if (!base) {
      console.warn(
        `  OMITIDA ${recipe.name}: no existe la receta base del artículo ${recipe.itemId}`,
      );
      skipped += 1;
      continue;
    }

    console.log(
      `${apply ? '[convert]' : '[plan]'} ${recipe.name} -> base ${base.id} (${recipe.ingredients.length} insumos)`,
    );

    if (!apply) {
      converted += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      for (const line of recipe.ingredients) {
        const existing = await tx.recipeIngredient.findFirst({
          where: {
            recipeId: base.id,
            variantId: recipe.variantId,
            ingredientId: line.ingredientId,
          },
          select: { id: true },
        });

        if (existing) {
          await tx.recipeIngredient.update({
            where: { id: existing.id },
            data: {
              quantity: line.quantity,
              label: line.label,
              isOptional: line.isOptional,
            },
          });
        } else {
          const created = await tx.recipeIngredient.create({
            data: {
              recipeId: base.id,
              variantId: recipe.variantId,
              ingredientId: line.ingredientId,
              quantity: line.quantity,
              label: line.label,
              isOptional: line.isOptional,
              sortOrder: line.sortOrder,
            },
          });

          if (line.options.length > 0) {
            await tx.recipeIngredientOption.createMany({
              data: line.options.map((option) => ({
                recipeIngredientId: created.id,
                ingredientId: option.ingredientId,
                quantity: option.quantity,
                sortOrder: option.sortOrder,
              })),
            });
          }
        }
      }

      await tx.recipe.update({
        where: { id: recipe.id },
        data: { isActive: false },
      });
    });

    converted += 1;
  }

  console.log(
    apply
      ? `Listo. Convertidas: ${converted}. Omitidas: ${skipped}.`
      : `Dry run: se convertirían ${converted}, se omitirían ${skipped}. No se modificó nada.`,
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
