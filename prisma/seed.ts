// Seed de desarrollo: usuario de prueba y catálogo ficticio.
// Idempotente: puede ejecutarse varias veces sin duplicar datos.
// Uso: npm run prisma:seed
import { config } from 'dotenv';
import { hash } from 'argon2';
import { PrismaClient, Prisma, UnitCode, CategoryKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  canonicalUnit,
  toCanonicalCost,
  toCanonicalQuantity,
} from '../src/common/units';
import { CORE_CATEGORIES } from '../src/catalog/core-categories';

config();

const TEST_EMAIL = 'admin@naranjapimienta.local';
const TEST_PASSWORD = 'Naranja123!';
const ORG_NAME = 'Naranja Pimienta';
const ORG_SLUG = 'naranja-pimienta';

// Categorías core del sistema (isCore = true, no editables por el usuario)
const CORE_INGREDIENT_CATEGORIES = [
  { name: 'Frutas y verduras', description: 'Productos frescos de origen vegetal', sortOrder: 1 },
  { name: 'Carnes, aves y pescados', description: 'Carnes rojas, aves, pescados y mariscos', sortOrder: 2 },
  { name: 'Lácteos y refrigerados', description: 'Leche, quesos, yogures, huevos y productos refrigerados', sortOrder: 3 },
  { name: 'Congelados', description: 'Productos congelados listos para usar', sortOrder: 4 },
  { name: 'Abarrotes y productos secos', description: 'Alimentos no perecederos, granos y harinas', sortOrder: 5 },
  { name: 'Aceites, salsas y condimentos', description: 'Aceites, vinagres, salsas, especias y adobos', sortOrder: 6 },
  { name: 'Panadería y tortillería', description: 'Pan, tortillas, masas y productos de panadería', sortOrder: 7 },
  { name: 'Café, té y bebidas', description: 'Café, té, cacao, jugos, refrescos y bases para bebidas', sortOrder: 8 },
  { name: 'Enlatados, conservas y encurtidos', description: 'Latas, conservas y encurtidos', sortOrder: 9 },
  { name: 'Repostería y decoración', description: 'Insumos de repostería, coberturas y decoración', sortOrder: 10 },
  { name: 'Desechables y empaques', description: 'Vasos, cubiertos, servilletas, bolsas y film', sortOrder: 11 },
  { name: 'Limpieza e higiene', description: 'Detergentes, desinfectantes, jabones y papel', sortOrder: 12 },
  { name: 'Artículos de operación', description: 'Utensilios, equipo menor y artículos de operación', sortOrder: 13 },
  { name: 'Bebidas alcohólicas y coctelería', description: 'Licores, cervezas, vinos y mezcladores', sortOrder: 14 },
];

// Ubicaciones core del sistema (isCore = true, no editables por el usuario)
const CORE_INGREDIENT_LOCATIONS = [
  { name: 'Almacén seco', description: 'Zona de almacenamiento a temperatura ambiente', sortOrder: 1 },
  { name: 'Refrigerador', description: 'Cámara fría / refrigerador principal (2-8°C)', sortOrder: 2 },
  { name: 'Congelador', description: 'Congelador / freezer (-18°C o menos)', sortOrder: 3 },
  { name: 'Cocina / Área de preparación', description: 'Zona de trabajo y mise en place', sortOrder: 4 },
  { name: 'Barra de bebidas', description: 'Área de servicio de bebidas y café', sortOrder: 5 },
  { name: 'Almacén de desechables', description: 'Stock de vasos, cubiertos, servilletas, empaques', sortOrder: 6 },
  { name: 'Área de limpieza', description: 'Productos de limpieza e higiene', sortOrder: 7 },
  { name: 'Bodega auxiliar', description: 'Almacén secundario / overflow', sortOrder: 8 },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida. Revisa api/.env');
  }

  // Mismo patrón que PrismaService (Prisma 7 con driver adapter)
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    // 1. Organización (el login exige una membresía activa)
    const org = await prisma.organization.upsert({
      where: { slug: ORG_SLUG },
      update: { name: ORG_NAME, isActive: true },
      create: { name: ORG_NAME, slug: ORG_SLUG },
    });

    // 2. Usuario — el hash se re-restablece en cada ejecución
    const passwordHash = await hash(TEST_PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: { passwordHash, isActive: true },
      create: {
        email: TEST_EMAIL,
        passwordHash,
        name: 'Admin de prueba',
        isActive: true,
      },
    });

    // 3. Membresía ADMIN (sin ella el login responde "Usuario sin membresía activa")
    const membership = await prisma.membership.upsert({
      where: {
        userId_organizationId: { userId: user.id, organizationId: org.id },
      },
      update: { roles: ['ADMIN'], isActive: true },
      create: { userId: user.id, organizationId: org.id, roles: ['ADMIN'] },
    });

    // 4. Categorías core de ingredientes (isCore = true, no editables)
    for (const cat of CORE_INGREDIENT_CATEGORIES) {
      try {
        await prisma.ingredientCategory.create({
          data: { organizationId: null as any, ...cat, isCore: true },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Duplicate core category, ignore
        } else {
          throw e;
        }
      }
    }

    // 5. Ubicaciones core de ingredientes (isCore = true, no editables)
    for (const loc of CORE_INGREDIENT_LOCATIONS) {
      try {
        await prisma.ingredientLocation.create({
          data: { organizationId: null as any, ...loc, isCore: true },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Duplicate core location, ignore
        } else {
          throw e;
        }
      }
    }

    // Obtener IDs de categorías y ubicaciones para asignar a ingredientes
    const ingredientCategories = await prisma.ingredientCategory.findMany({
      where: { OR: [{ organizationId: org.id }, { organizationId: null as any }] },
      select: { id: true, name: true },
    });
    const ingredientCategoryMap = Object.fromEntries(
      ingredientCategories.map((c) => [c.name, c.id])
    );

    const ingredientLocations = await prisma.ingredientLocation.findMany({
      where: { OR: [{ organizationId: org.id }, { organizationId: null as any }] },
      select: { id: true, name: true },
    });
    const ingredientLocationMap = Object.fromEntries(
      ingredientLocations.map((l) => [l.name, l.id])
    );

    // ------------------------------------------------------------------------
    // Catálogo ficticio de la cafetería (no es el menú real)
    // ------------------------------------------------------------------------

    // Categorías core compartidas (también las siembra la app al iniciar sesión).
    for (const core of CORE_CATEGORIES) {
      await prisma.category.upsert({
        where: {
          kind_code: { kind: core.kind, code: core.code },
        },
        update: {
          name: core.name,
          description: core.description,
          kind: core.kind,
          sortOrder: core.sortOrder,
          isCore: true,
          isActive: true,
          organizationId: null,
        },
        create: {
          organizationId: null,
          code: core.code,
          name: core.name,
          description: core.description,
          kind: core.kind,
          sortOrder: core.sortOrder,
          isCore: true,
          isActive: true,
        },
      });
    }

    const coreCategory = async (code: string, kind: CategoryKind) => {
      const category = await prisma.category.findUniqueOrThrow({
        where: { kind_code: { kind, code } },
      });
      return category;
    };

    const categories = {
      calientes: await coreCategory('hot_drinks', CategoryKind.ARTICLE),
      frias: await coreCategory('cold_drinks', CategoryKind.ARTICLE),
      panaderia: await coreCategory('bakery', CategoryKind.ARTICLE),
      combos: await coreCategory('combos', CategoryKind.ARTICLE),
      salsas: await coreCategory('sauces', CategoryKind.RECIPE),
    };

    const ingredients = {
      cafe: await ensureIngredient(prisma, org.id, {
        name: 'Café molido',
        baseUnit: UnitCode.KG,
        currentStock: '12',
        minStock: '2',
        categoryId: ingredientCategoryMap['Café, té y bebidas'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '120',
        maxStock: '50',
      }),
      leche: await ensureIngredient(prisma, org.id, {
        name: 'Leche entera',
        baseUnit: UnitCode.L,
        currentStock: '24',
        minStock: '5',
        categoryId: ingredientCategoryMap['Lácteos y refrigerados'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '25',
        maxStock: '50',
      }),
      agua: await ensureIngredient(prisma, org.id, {
        name: 'Agua filtrada',
        baseUnit: UnitCode.L,
        currentStock: '100',
        minStock: '10',
        categoryId: ingredientCategoryMap['Café, té y bebidas'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '5',
        maxStock: '200',
      }),
      harina: await ensureIngredient(prisma, org.id, {
        name: 'Harina de trigo',
        baseUnit: UnitCode.KG,
        currentStock: '25',
        minStock: '5',
        categoryId: ingredientCategoryMap['Abarrotes y productos secos'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '18',
        maxStock: '50',
      }),
      azucar: await ensureIngredient(prisma, org.id, {
        name: 'Azúcar',
        baseUnit: UnitCode.KG,
        currentStock: '15',
        minStock: '3',
        categoryId: ingredientCategoryMap['Abarrotes y productos secos'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '22',
        maxStock: '30',
      }),
      mantequilla: await ensureIngredient(prisma, org.id, {
        name: 'Mantequilla',
        baseUnit: UnitCode.KG,
        currentStock: '8',
        minStock: '2',
        categoryId: ingredientCategoryMap['Lácteos y refrigerados'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '85',
        maxStock: '20',
      }),
      chocolate: await ensureIngredient(prisma, org.id, {
        name: 'Chocolate en polvo',
        baseUnit: UnitCode.KG,
        currentStock: '6',
        minStock: '1.5',
        categoryId: ingredientCategoryMap['Café, té y bebidas'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '280',
        maxStock: '15',
      }),
      vaso: await ensureIngredient(prisma, org.id, {
        name: 'Vaso 12 oz',
        baseUnit: UnitCode.UNIT,
        currentStock: '400',
        minStock: '100',
        categoryId: ingredientCategoryMap['Desechables y empaques'],
        locationId: ingredientLocationMap['Almacén de desechables'],
        unitCost: '0.8',
        maxStock: '1000',
      }),
      huevo: await ensureIngredient(prisma, org.id, {
        name: 'Huevo',
        baseUnit: UnitCode.UNIT,
        currentStock: '60',
        minStock: '12',
        categoryId: ingredientCategoryMap['Lácteos y refrigerados'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '3.5',
        maxStock: '120',
      }),
      matcha: await ensureIngredient(prisma, org.id, {
        name: 'Matcha en polvo',
        baseUnit: UnitCode.KG,
        currentStock: '1.2',
        minStock: '0.3',
        categoryId: ingredientCategoryMap['Café, té y bebidas'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '850',
        maxStock: '5',
      }),
      lecheCoco: await ensureIngredient(prisma, org.id, {
        name: 'Leche de coco',
        baseUnit: UnitCode.L,
        currentStock: '6',
        minStock: '1',
        categoryId: ingredientCategoryMap['Lácteos y refrigerados'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '48',
        maxStock: '12',
      }),
      jitomate: await ensureIngredient(prisma, org.id, {
        name: 'Jitomate',
        baseUnit: UnitCode.KG,
        currentStock: '8',
        minStock: '2',
        categoryId: ingredientCategoryMap['Frutas y verduras'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '28',
        maxStock: '15',
      }),
      cebolla: await ensureIngredient(prisma, org.id, {
        name: 'Cebolla',
        baseUnit: UnitCode.KG,
        currentStock: '6',
        minStock: '1.5',
        categoryId: ingredientCategoryMap['Frutas y verduras'],
        locationId: ingredientLocationMap['Almacén seco'],
        unitCost: '22',
        maxStock: '12',
      }),
      chileSerrano: await ensureIngredient(prisma, org.id, {
        name: 'Chile serrano',
        baseUnit: UnitCode.KG,
        currentStock: '2',
        minStock: '0.5',
        categoryId: ingredientCategoryMap['Frutas y verduras'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '45',
        maxStock: '5',
      }),
      salsaVerde: await ensureIngredient(prisma, org.id, {
        name: 'Salsa verde',
        baseUnit: UnitCode.L,
        currentStock: '0',
        minStock: '0.5',
        categoryId: ingredientCategoryMap['Aceites, salsas y condimentos'],
        locationId: ingredientLocationMap['Refrigerador'],
        unitCost: '35',
        maxStock: '4',
      }),
    };

    // Equivalencia entre dimensiones: 1 g = 0.02 huevos (1 huevo ≈ 50 g).
    await prisma.ingredientEquivalence.upsert({
      where: {
        ingredientId_fromUnit_toUnit: {
          ingredientId: ingredients.huevo.id,
          fromUnit: UnitCode.G,
          toUnit: UnitCode.UNIT,
        },
      },
      update: { factor: '0.02', note: '1 huevo ≈ 50 g' },
      create: {
        ingredientId: ingredients.huevo.id,
        fromUnit: UnitCode.G,
        toUnit: UnitCode.UNIT,
        factor: '0.02',
        note: '1 huevo ≈ 50 g',
      },
    });

    const espresso = await ensureItem(prisma, org.id, {
      sku: 'CAF-ESP',
      name: 'Espresso',
      description: 'Café solo de 30 ml',
      categoryId: categories.calientes.id,
      price: '35',
      taxRate: '0.16',
      sortOrder: 1,
    });

    const latte = await ensureItem(prisma, org.id, {
      sku: 'CAF-LAT',
      name: 'Latte',
      description: 'Espresso con leche vaporizada',
      categoryId: categories.calientes.id,
      price: '55',
      taxRate: '0.16',
      sortOrder: 2,
      variants: [
        { name: 'Mediano', priceAdjust: '0', sortOrder: 1 },
        { name: 'Grande', priceAdjust: '10', sortOrder: 2 },
      ],
      extras: [
        {
          name: 'Shot extra',
          price: '12',
          ingredients: [{ ingredientId: ingredients.cafe.id, quantity: '0.008' }],
        },
      ],
      exclusions: [
        { ingredientId: ingredients.leche.id, label: 'Sin leche' },
      ],
    });

    const matchaLatte = await ensureItem(prisma, org.id, {
      sku: 'CAF-MAT',
      name: 'Matcha latte',
      description: 'Matcha con leche',
      categoryId: categories.calientes.id,
      price: '65',
      taxRate: '0.16',
      sortOrder: 3,
      exclusions: [
        { ingredientId: ingredients.leche.id, label: 'Sin leche' },
      ],
    });

    const croissant = await ensureItem(prisma, org.id, {
      sku: 'PAN-CRO',
      name: 'Croissant',
      description: 'Hojaldre de mantequilla',
      categoryId: categories.panaderia.id,
      price: '28',
      taxRate: '0.16',
      sortOrder: 1,
    });

    const chocolateCaliente = await ensureItem(prisma, org.id, {
      sku: 'CAF-CHO',
      name: 'Chocolate caliente',
      description: 'Chocolate con leche',
      categoryId: categories.calientes.id,
      price: '48',
      taxRate: '0.16',
      sortOrder: 4,
    });

    const latteGrande = latte.variants.find(
      (variant) => variant.name === 'Grande',
    );

    const combo = await ensureItem(prisma, org.id, {
      sku: 'COM-DES',
      name: 'Combo desayuno',
      description: 'Latte mediano + croissant',
      categoryId: categories.combos.id,
      price: '75',
      taxRate: '0.16',
      isCombo: true,
      sortOrder: 1,
      comboComponents: [
        {
          componentItemId: latte.id,
          componentVariantId: latte.variants.find((v) => v.name === 'Mediano')
            ?.id,
          quantity: 1,
        },
        { componentItemId: croissant.id, quantity: 1 },
      ],
    });

    await ensureRecipe(prisma, org.id, espresso.id, null, 'Espresso', [
      { ingredientId: ingredients.cafe.id, quantity: '0.008' },
      { ingredientId: ingredients.agua.id, quantity: '0.04' },
      { ingredientId: ingredients.vaso.id, quantity: '1' },
    ]);

    await ensureRecipe(prisma, org.id, latte.id, null, 'Latte — Mediano', [
      { ingredientId: ingredients.cafe.id, quantity: '0.008' },
      { ingredientId: ingredients.leche.id, quantity: '0.15' },
      { ingredientId: ingredients.vaso.id, quantity: '1' },
    ]);

    if (latteGrande) {
      await ensureRecipe(
        prisma,
        org.id,
        latte.id,
        latteGrande.id,
        'Latte — Grande',
        [
          { ingredientId: ingredients.cafe.id, quantity: '0.012' },
          { ingredientId: ingredients.leche.id, quantity: '0.22' },
          { ingredientId: ingredients.vaso.id, quantity: '1' },
        ],
      );
    }

    await ensureRecipe(
      prisma,
      org.id,
      matchaLatte.id,
      null,
      'Matcha latte',
      [
        { ingredientId: ingredients.matcha.id, quantity: '0.004' },
        { ingredientId: ingredients.leche.id, quantity: '0.2' },
        { ingredientId: ingredients.vaso.id, quantity: '1' },
      ],
    );

    await ensureRecipe(prisma, org.id, croissant.id, null, 'Croissant', [
      { ingredientId: ingredients.harina.id, quantity: '0.08' },
      { ingredientId: ingredients.mantequilla.id, quantity: '0.03' },
      { ingredientId: ingredients.azucar.id, quantity: '0.01' },
      { ingredientId: ingredients.huevo.id, quantity: '0.2' },
    ]);

    await ensureRecipe(
      prisma,
      org.id,
      chocolateCaliente.id,
      null,
      'Chocolate caliente',
      [
        { ingredientId: ingredients.chocolate.id, quantity: '0.03' },
        { ingredientId: ingredients.leche.id, quantity: '0.2' },
        { ingredientId: ingredients.azucar.id, quantity: '0.01' },
        { ingredientId: ingredients.vaso.id, quantity: '1' },
      ],
    );

    // Alternativa del ingrediente "leche": leche entera (default) o de coco.
    const chocolateRecipe = await prisma.recipe.findFirst({
      where: { organizationId: org.id, itemId: chocolateCaliente.id },
      include: { ingredients: true },
    });
    const milkLine = chocolateRecipe?.ingredients.find(
      (line) => line.ingredientId === ingredients.leche.id,
    );

    if (milkLine) {
      await prisma.recipeIngredientOption.upsert({
        where: {
          recipeIngredientId_ingredientId: {
            recipeIngredientId: milkLine.id,
            ingredientId: ingredients.lecheCoco.id,
          },
        },
        update: { quantity: toCanonicalQuantity('0.2', UnitCode.L) },
        create: {
          recipeIngredientId: milkLine.id,
          ingredientId: ingredients.lecheCoco.id,
          quantity: toCanonicalQuantity('0.2', UnitCode.L),
        },
      });
    }

    // Receta independiente que también es insumo: salsa verde por lote.
    const salsaRecipe = await prisma.recipe.findFirst({
      where: { organizationId: org.id, itemId: null, name: 'Salsa verde' },
    });

    if (!salsaRecipe) {
      const salsa = await prisma.recipe.create({
        data: {
          organizationId: org.id,
          name: 'Salsa verde',
          description: 'Receta base que se produce como insumo para otros platillos',
          categoryId: categories.salsas.id,
          producesIngredientId: ingredients.salsaVerde.id,
          yieldQuantity: toCanonicalQuantity('2', UnitCode.L),
          yieldUnit: UnitCode.ML,
          ingredients: {
            create: [
              {
                ingredientId: ingredients.jitomate.id,
                quantity: toCanonicalQuantity('0.5', UnitCode.KG),
                sortOrder: 0,
              },
              {
                ingredientId: ingredients.cebolla.id,
                quantity: toCanonicalQuantity('0.2', UnitCode.KG),
                sortOrder: 1,
              },
              {
                ingredientId: ingredients.chileSerrano.id,
                quantity: toCanonicalQuantity('0.1', UnitCode.KG),
                sortOrder: 2,
              },
            ],
          },
        },
      });

      // Receta independiente: estrena su propia entrada de catálogo.
      await prisma.catalogEntry.create({
        data: { id: salsa.id, organizationId: org.id },
      });
      await prisma.recipe.update({
        where: { id: salsa.id },
        data: { catalogEntryId: salsa.id },
      });
    }

    // El combo no tiene receta propia: su consumo sale de sus componentes.

    console.log('Seed completado:');
    console.log(`  Organización : ${org.name} (${org.id})`);
    console.log(`  Usuario      : ${user.email} (${user.id})`);
    console.log(`  Membresía    : ${membership.roles.join(', ')}`);
    console.log(`  Categorías   : ${Object.keys(categories).length}`);
    console.log(`  Ingredientes : ${Object.keys(ingredients).length}`);
    console.log(
      `  Productos    : ${[espresso, latte, matchaLatte, croissant, chocolateCaliente, combo]
        .map((item) => item.name)
        .join(', ')}`,
    );
    console.log(`  Credenciales : ${TEST_EMAIL} / ${TEST_PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

type Prisma = PrismaClient;

interface IngredientSeed {
  name: string;
  /** Unidad visible con la que se escriben las cantidades de la semilla. */
  baseUnit: UnitCode;
  currentStock: string;
  minStock: string;
  sku?: string;
  categoryId?: string;
  locationId?: string;
  unitCost?: string;
  maxStock?: string;
}

async function ensureIngredient(
  prisma: Prisma,
  organizationId: string,
  data: IngredientSeed,
) {
  // La base se guarda en la unidad canónica y la semilla se escribe en la
  // unidad visible que declara cada insumo.
  const displayUnit = data.baseUnit;
  const baseUnit = canonicalUnit(displayUnit);

  return prisma.ingredient.upsert({
    where: {
      organizationId_name: { organizationId, name: data.name },
    },
    update: { isActive: true },
    create: {
      organizationId,
      name: data.name,
      sku: data.sku,
      baseUnit,
      displayUnit,
      currentStock: toCanonicalQuantity(data.currentStock, displayUnit),
      minStock: toCanonicalQuantity(data.minStock, displayUnit),
      maxStock:
        data.maxStock !== undefined
          ? toCanonicalQuantity(data.maxStock, displayUnit)
          : null,
      unitCost:
        data.unitCost !== undefined
          ? toCanonicalCost(data.unitCost, displayUnit)
          : null,
      categoryId: data.categoryId,
      locationId: data.locationId,
    },
  });
}

interface ItemSeed {
  sku: string;
  name: string;
  description?: string;
  categoryId?: string;
  price: string;
  taxRate?: string;
  isCombo?: boolean;
  sortOrder?: number;
  variants?: Array<{
    name: string;
    priceAdjust: string;
    sortOrder: number;
  }>;
  extras?: Array<{
    name: string;
    price: string;
    ingredients: Array<{ ingredientId: string; quantity: string }>;
  }>;
  exclusions?: Array<{ ingredientId: string; label?: string }>;
  comboComponents?: Array<{
    componentItemId: string;
    componentVariantId?: string;
    quantity: number;
  }>;
}

async function ensureItem(
  prisma: Prisma,
  organizationId: string,
  data: ItemSeed,
) {
  const existing = await prisma.item.findUnique({
    where: { organizationId_sku: { organizationId, sku: data.sku } },
    include: { variants: true },
  });

  if (existing) {
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        organizationId,
        categoryId: data.categoryId,
        sku: data.sku,
        name: data.name,
        description: data.description,
        price: data.price,
        taxRate: data.taxRate,
        isCombo: data.isCombo ?? false,
        sortOrder: data.sortOrder ?? 0,
        variants: {
          create: data.variants ?? [],
        },
        extras: {
          create: (data.extras ?? []).map((extra) => ({
            name: extra.name,
            price: extra.price,
            ingredients: {
              create: extra.ingredients.map((ingredient) => ({
                quantity: ingredient.quantity,
                ingredient: { connect: { id: ingredient.ingredientId } },
              })),
            },
          })),
        },
        ingredientExclusions: {
          create: (data.exclusions ?? []).map((exclusion) => ({
            label: exclusion.label,
            ingredient: { connect: { id: exclusion.ingredientId } },
          })),
        },
        comboComponents: {
          create: (data.comboComponents ?? []).map((component) => ({
            quantity: component.quantity,
            componentItem: { connect: { id: component.componentItemId } },
            ...(component.componentVariantId
              ? { variant: { connect: { id: component.componentVariantId } } }
              : {}),
          })),
        },
      },
      include: { variants: true },
    });

    await tx.catalogEntry.create({
      data: { id: created.id, organizationId },
    });

    return tx.item.update({
      where: { id: created.id },
      data: { catalogEntryId: created.id },
      include: { variants: true },
    });
  });
}

async function ensureRecipe(
  prisma: Prisma,
  organizationId: string,
  itemId: string,
  variantId: string | null,
  name: string,
  ingredients: Array<{ ingredientId: string; quantity: string }>,
) {
  const existing = await prisma.recipe.findFirst({
    where: { itemId, variantId },
  });

  if (existing) {
    return existing;
  }

  // Las cantidades de la semilla se escriben en la unidad visible del insumo.
  const resolved: Array<{
    ingredientId: string;
    quantity: Prisma.Decimal;
  }> = [];

  for (const item of ingredients) {
    const ingredient = await prisma.ingredient.findUniqueOrThrow({
      where: { id: item.ingredientId },
      select: { displayUnit: true },
    });

    resolved.push({
      ingredientId: item.ingredientId,
      quantity: toCanonicalQuantity(item.quantity, ingredient.displayUnit),
    });
  }

  // Una presentación ya no crea otra receta: sus insumos viven en la receta
  // base con `variantId`, reemplazando la cantidad común del mismo insumo.
  if (variantId) {
    const base = await prisma.recipe.findFirst({
      where: { itemId, variantId: null },
    });

    if (!base) {
      throw new Error('La receta base debe existir antes de sus presentaciones');
    }

    for (const line of resolved) {
      const existingLine = await prisma.recipeIngredient.findFirst({
        where: {
          recipeId: base.id,
          variantId,
          ingredientId: line.ingredientId,
        },
        select: { id: true },
      });

      if (existingLine) {
        await prisma.recipeIngredient.update({
          where: { id: existingLine.id },
          data: { quantity: line.quantity },
        });
      } else {
        await prisma.recipeIngredient.create({
          data: {
            recipeId: base.id,
            variantId,
            ingredientId: line.ingredientId,
            quantity: line.quantity,
          },
        });
      }
    }

    return base;
  }

  const recipe = await prisma.recipe.create({
    data: {
      organizationId,
      itemId,
      variantId,
      name,
      ingredients: {
        create: resolved,
      },
    },
  });

  // La receta comparte la entrada del artículo (o la estrena si faltaba).
  const item = await prisma.item.findUniqueOrThrow({
    where: { id: itemId },
    select: { catalogEntryId: true },
  });

  let catalogEntryId = item.catalogEntryId;

  if (!catalogEntryId) {
    await prisma.catalogEntry.upsert({
      where: { id: itemId },
      create: { id: itemId, organizationId },
      update: {},
    });
    await prisma.item.update({
      where: { id: itemId },
      data: { catalogEntryId: itemId },
    });
    catalogEntryId = itemId;
  }

  await prisma.recipe.update({
    where: { id: recipe.id },
    data: { catalogEntryId },
  });

  return recipe;
}

main().catch((err) => {
  console.error('Seed falló:', err);
  process.exit(1);
});
