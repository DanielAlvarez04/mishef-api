// @ts-nocheck
/**
 * Seed de pruebas para un usuario concreto.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/seed-test-user.ts
 *   npx ts-node --transpile-only scripts/seed-test-user.ts correo@dominio.com
 *
 * Borra TODOS los datos de la organización del usuario (conserva usuario,
 * membresía y datos core globales) y siembra un catálogo completo:
 * - Categorías core, categorías/ubicaciones de insumos core.
 * - ~50 insumos con existencias, costos y mínimos.
 * - 20 recetas: 10 publicadas como artículo, 5 que producen un insumo y 5
 *   preparaciones independientes.
 * - 10 artículos sin receta.
 * - Presentaciones, precios, un combo de 5 artículos y 3 menús.
 * - Imágenes ilustrativas gratuitas (LoremFlickr).
 */
import { config } from 'dotenv';
import { PrismaClient, Prisma, UnitCode, CategoryKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  canonicalUnit,
  toCanonicalCost,
  toCanonicalQuantity,
} from '../src/common/units';
import { CORE_CATEGORIES } from '../src/catalog/core-categories';

config();

const EMAIL = process.argv[2] ?? 'portafolio.d.alvarez@gmail.com';
const TAX_RATE = '0.16';

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

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

/**
 * Fotos ilustrativas de Unsplash por etiqueta. Son URLs estables y sirven
 * aunque no se suban a R2; el script `upload-food-images.ts` las migra al
 * bucket para producción.
 */
const UNSPLASH_BY_TAG: Record<string, string> = {
  burger: '1568901346375-23c9450c58cd',
  tacos: '1613514785940-daed07799d9b',
  pizza: '1565299624946-b28f40a0ae38',
  'caesar salad': '1546069901-ba9599a7e63c',
  'fettuccine alfredo': '1551183053-bf91a1d81141',
  chilaquiles: '1552332386-f8dd00dc2f85',
  'chicken sandwich': '1530610476181-d83430b64dcd',
  croissant: '1555507036-ab1f4038808a',
  brownie: '1565958011703-44f9829ba187',
  latte: '1495474472287-4d71bcdd2085',
  'water bottle': '1513558161293-cdaf765ed2fd',
  soda: '1544145945-f90425340c7e',
  'orange juice': '1600271886742-f049cd451bba',
  'iced tea': '1517701550927-30cf4ba1dba5',
  'black coffee': '1461023058943-07fcbe16d735',
  'french fries': '1504674900247-0877df9cc836',
  'onion rings': '1550317138-10000687a72b',
  'chocolate chip cookie': '1551024506-0bccd828d307',
  'yogurt granola': '1488477181946-6428a0291777',
  'chocolate bar': '1578985545062-69928b1d9587',
  'burger combo': '1504674900247-0877df9cc836',
  salsa: '1598866594230-a7c12756260f',
  'green salsa': '1552332386-f8dd00dc2f85',
  adobo: '1600891964092-4316c288032e',
  'alfredo sauce': '1473093295043-cdd812d0e601',
  'chocolate ganache': '1551024506-0bccd828d307',
  'pizza dough': '1574071318508-1cdbab80d002',
  'refried beans': '1595708684082-a173bb3a06c5',
  'mexican rice': '1504674900247-0877df9cc836',
  'salad dressing': '1546793665-c74683f339c1',
  'marinated chicken': '1600891964092-4316c288032e',
  food: '1504674900247-0877df9cc836',
};

function foodImage(tag: string) {
  const photoId = UNSPLASH_BY_TAG[tag] ?? UNSPLASH_BY_TAG.food;

  return `https://images.unsplash.com/photo-${photoId}?w=800&h=800&fit=crop&q=82`;
}

function slug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Borra todos los datos de negocio de la organización (conserva core/usuario). */
async function wipeOrganization(tx: any, organizationId: string) {
  const byOrder = { orderRound: { order: { organizationId } } };
  const byOrderItem = { orderItem: byOrder };

  await tx.orderItemIngredientChoice.deleteMany({ where: byOrderItem });
  await tx.orderItemExtra.deleteMany({ where: byOrderItem });
  await tx.orderItemOption.deleteMany({ where: byOrderItem });
  await tx.orderItemExclusion.deleteMany({ where: byOrderItem });
  await tx.orderStatusHistory.deleteMany({ where: byOrder });
  await tx.orderItem.deleteMany({ where: byOrder });
  await tx.orderRound.deleteMany({ where: { order: { organizationId } } });
  await tx.payment.deleteMany({ where: { organizationId } });
  await tx.order.deleteMany({ where: { organizationId } });

  await tx.inventoryMovement.deleteMany({ where: { organizationId } });
  await tx.analyticsEvent.deleteMany({ where: { organizationId } });
  await tx.auditLog.deleteMany({ where: { organizationId } });

  await tx.menuItem.deleteMany({ where: { menu: { organizationId } } });
  await tx.menu.deleteMany({ where: { organizationId } });

  await tx.itemOptionEffect.deleteMany({
    where: { itemOptionValue: { itemOptionGroup: { item: { organizationId } } } },
  });
  await tx.itemOptionValue.deleteMany({
    where: { itemOptionGroup: { item: { organizationId } } },
  });
  await tx.itemOptionGroup.deleteMany({ where: { item: { organizationId } } });
  await tx.optionValue.deleteMany({ where: { group: { organizationId } } });
  await tx.optionGroup.deleteMany({ where: { organizationId } });

  await tx.comboPromotion.deleteMany({ where: { item: { organizationId } } });
  await tx.comboComponent.deleteMany({ where: { combo: { organizationId } } });

  await tx.itemExtraIngredient.deleteMany({
    where: { itemExtra: { item: { organizationId } } },
  });
  await tx.itemExtra.deleteMany({ where: { item: { organizationId } } });
  await tx.itemIngredientExclusion.deleteMany({
    where: { item: { organizationId } },
  });

  await tx.recipeIngredientOption.deleteMany({
    where: { recipeIngredient: { recipe: { organizationId } } },
  });
  await tx.recipeIngredient.deleteMany({
    where: { recipe: { organizationId } },
  });
  await tx.recipe.deleteMany({ where: { organizationId } });

  await tx.itemVariant.deleteMany({ where: { item: { organizationId } } });
  await tx.item.deleteMany({ where: { organizationId } });
  await tx.catalogEntry.deleteMany({ where: { organizationId } });

  await tx.branchStock.deleteMany({ where: { branch: { organizationId } } });
  await tx.ingredientEquivalence.deleteMany({
    where: { ingredient: { organizationId } },
  });
  await tx.ingredient.deleteMany({ where: { organizationId } });

  await tx.branch.deleteMany({ where: { organizationId } });
  await tx.category.deleteMany({ where: { organizationId } });
  await tx.ingredientCategory.deleteMany({ where: { organizationId } });
  await tx.ingredientLocation.deleteMany({ where: { organizationId } });
}

async function ensureCore(tx: any) {
  for (const category of CORE_CATEGORIES) {
    await tx.category.upsert({
      where: { kind_code: { kind: category.kind, code: category.code } },
      update: {
        organizationId: null,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isCore: true,
        isActive: true,
      },
      create: {
        organizationId: null,
        code: category.code,
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        kind: category.kind,
        isCore: true,
        isActive: true,
      },
    });
  }

  for (const category of CORE_INGREDIENT_CATEGORIES) {
    const existing = await tx.ingredientCategory.findFirst({
      where: { organizationId: null, name: category.name },
      select: { id: true },
    });

    if (existing) {
      await tx.ingredientCategory.update({
        where: { id: existing.id },
        data: { ...category, isCore: true, isActive: true },
      });
    } else {
      await tx.ingredientCategory.create({
        data: {
          organizationId: null,
          ...category,
          isCore: true,
          isActive: true,
        },
      });
    }
  }

  for (const location of CORE_INGREDIENT_LOCATIONS) {
    const existing = await tx.ingredientLocation.findFirst({
      where: { organizationId: null, name: location.name },
      select: { id: true },
    });

    if (existing) {
      await tx.ingredientLocation.update({
        where: { id: existing.id },
        data: { ...location, isCore: true, isActive: true },
      });
    } else {
      await tx.ingredientLocation.create({
        data: {
          organizationId: null,
          ...location,
          isCore: true,
          isActive: true,
        },
      });
    }
  }
}

type IngredientSeed = {
  name: string;
  unit: UnitCode;
  stock: string;
  min: string;
  cost: string;
  max?: string;
  category: string;
  location: string;
};

const INGREDIENT_SEEDS: IngredientSeed[] = [
  { name: 'Carne de res molida', unit: UnitCode.KG, stock: '12', min: '2', max: '30', cost: '180', category: 'Carnes, aves y pescados', location: 'Refrigerador' },
  { name: 'Pan brioche', unit: UnitCode.UNIT, stock: '48', min: '12', max: '96', cost: '12', category: 'Panadería y tortillería', location: 'Almacén seco' },
  { name: 'Queso cheddar', unit: UnitCode.KG, stock: '3', min: '0.5', max: '8', cost: '160', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Lechuga romana', unit: UnitCode.KG, stock: '2', min: '0.5', max: '6', cost: '35', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Jitomate saladet', unit: UnitCode.KG, stock: '4', min: '1', max: '10', cost: '28', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Cebolla blanca', unit: UnitCode.KG, stock: '5', min: '1', max: '12', cost: '22', category: 'Frutas y verduras', location: 'Almacén seco' },
  { name: 'Papa', unit: UnitCode.KG, stock: '15', min: '3', max: '30', cost: '25', category: 'Frutas y verduras', location: 'Almacén seco' },
  { name: 'Tortilla de maíz', unit: UnitCode.KG, stock: '6', min: '1', max: '10', cost: '20', category: 'Panadería y tortillería', location: 'Refrigerador' },
  { name: 'Carne de cerdo', unit: UnitCode.KG, stock: '8', min: '2', max: '20', cost: '150', category: 'Carnes, aves y pescados', location: 'Refrigerador' },
  { name: 'Piña', unit: UnitCode.KG, stock: '2', min: '0.5', max: '5', cost: '30', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Harina de trigo', unit: UnitCode.KG, stock: '20', min: '5', max: '40', cost: '18', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Mantequilla', unit: UnitCode.KG, stock: '6', min: '1', max: '15', cost: '85', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Levadura', unit: UnitCode.KG, stock: '0.5', min: '0.1', max: '2', cost: '300', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Azúcar', unit: UnitCode.KG, stock: '10', min: '2', max: '25', cost: '22', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Huevo', unit: UnitCode.UNIT, stock: '60', min: '12', max: '120', cost: '3.5', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Leche entera', unit: UnitCode.L, stock: '20', min: '5', max: '40', cost: '25', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Crema para batir', unit: UnitCode.L, stock: '5', min: '1', max: '12', cost: '55', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Queso parmesano', unit: UnitCode.KG, stock: '1.5', min: '0.3', max: '4', cost: '320', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Pasta fettuccine', unit: UnitCode.KG, stock: '5', min: '1', max: '10', cost: '45', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Pollo pechuga', unit: UnitCode.KG, stock: '10', min: '2', max: '20', cost: '120', category: 'Carnes, aves y pescados', location: 'Refrigerador' },
  { name: 'Chile guajillo', unit: UnitCode.KG, stock: '0.5', min: '0.1', max: '2', cost: '180', category: 'Frutas y verduras', location: 'Almacén seco' },
  { name: 'Chile serrano', unit: UnitCode.KG, stock: '1', min: '0.2', max: '3', cost: '45', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Tomate verde', unit: UnitCode.KG, stock: '3', min: '0.5', max: '6', cost: '30', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Cilantro', unit: UnitCode.KG, stock: '0.5', min: '0.1', max: '1.5', cost: '60', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Ajo', unit: UnitCode.KG, stock: '1', min: '0.2', max: '2', cost: '90', category: 'Frutas y verduras', location: 'Almacén seco' },
  { name: 'Aceite vegetal', unit: UnitCode.L, stock: '8', min: '2', max: '20', cost: '35', category: 'Aceites, salsas y condimentos', location: 'Almacén seco' },
  { name: 'Café molido', unit: UnitCode.KG, stock: '4', min: '1', max: '10', cost: '120', category: 'Café, té y bebidas', location: 'Almacén seco' },
  { name: 'Vainilla', unit: UnitCode.L, stock: '0.5', min: '0.1', max: '1', cost: '400', category: 'Café, té y bebidas', location: 'Almacén seco' },
  { name: 'Chocolate semiamargo', unit: UnitCode.KG, stock: '2', min: '0.5', max: '5', cost: '220', category: 'Repostería y decoración', location: 'Almacén seco' },
  { name: 'Nuez', unit: UnitCode.KG, stock: '1', min: '0.2', max: '3', cost: '280', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Pan molido', unit: UnitCode.KG, stock: '2', min: '0.5', max: '5', cost: '40', category: 'Panadería y tortillería', location: 'Almacén seco' },
  { name: 'Mayonesa', unit: UnitCode.KG, stock: '2', min: '0.5', max: '5', cost: '60', category: 'Aceites, salsas y condimentos', location: 'Refrigerador' },
  { name: 'Mostaza', unit: UnitCode.KG, stock: '1', min: '0.2', max: '3', cost: '50', category: 'Aceites, salsas y condimentos', location: 'Almacén seco' },
  { name: 'Vinagre blanco', unit: UnitCode.L, stock: '2', min: '0.5', max: '5', cost: '25', category: 'Aceites, salsas y condimentos', location: 'Almacén seco' },
  { name: 'Queso mozzarella', unit: UnitCode.KG, stock: '3', min: '0.5', max: '8', cost: '180', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Queso fresco', unit: UnitCode.KG, stock: '1.5', min: '0.3', max: '4', cost: '140', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Frijol negro', unit: UnitCode.KG, stock: '5', min: '1', max: '10', cost: '30', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Arroz', unit: UnitCode.KG, stock: '8', min: '2', max: '15', cost: '28', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Miel', unit: UnitCode.L, stock: '1', min: '0.2', max: '3', cost: '120', category: 'Abarrotes y productos secos', location: 'Almacén seco' },
  { name: 'Limón', unit: UnitCode.KG, stock: '1', min: '0.2', max: '3', cost: '30', category: 'Frutas y verduras', location: 'Refrigerador' },
  { name: 'Agua filtrada', unit: UnitCode.L, stock: '40', min: '10', max: '80', cost: '5', category: 'Café, té y bebidas', location: 'Almacén seco' },
  { name: 'Vaso 16 oz', unit: UnitCode.UNIT, stock: '300', min: '50', max: '600', cost: '1.2', category: 'Desechables y empaques', location: 'Almacén de desechables' },
  { name: 'Servilletas', unit: UnitCode.UNIT, stock: '500', min: '100', max: '1000', cost: '0.2', category: 'Desechables y empaques', location: 'Almacén de desechables' },
  { name: 'Caja para llevar', unit: UnitCode.UNIT, stock: '200', min: '40', max: '500', cost: '2.5', category: 'Desechables y empaques', location: 'Almacén de desechables' },
  { name: 'Refresco de cola', unit: UnitCode.UNIT, stock: '24', min: '6', max: '96', cost: '9', category: 'Café, té y bebidas', location: 'Almacén seco' },
  { name: 'Agua purificada', unit: UnitCode.UNIT, stock: '48', min: '12', max: '96', cost: '4', category: 'Café, té y bebidas', location: 'Almacén seco' },
  { name: 'Jugo de naranja', unit: UnitCode.L, stock: '6', min: '1', max: '12', cost: '30', category: 'Café, té y bebidas', location: 'Refrigerador' },
  // Insumos producidos por recetas
  { name: 'Salsa roja', unit: UnitCode.L, stock: '4', min: '1', max: '8', cost: '35', category: 'Aceites, salsas y condimentos', location: 'Refrigerador' },
  { name: 'Salsa verde', unit: UnitCode.L, stock: '4', min: '1', max: '8', cost: '35', category: 'Aceites, salsas y condimentos', location: 'Refrigerador' },
  { name: 'Adobo de pollo', unit: UnitCode.L, stock: '3', min: '0.5', max: '6', cost: '60', category: 'Aceites, salsas y condimentos', location: 'Refrigerador' },
  { name: 'Crema Alfredo', unit: UnitCode.L, stock: '3', min: '0.5', max: '6', cost: '85', category: 'Lácteos y refrigerados', location: 'Refrigerador' },
  { name: 'Ganache de chocolate', unit: UnitCode.KG, stock: '2', min: '0.5', max: '4', cost: '150', category: 'Repostería y decoración', location: 'Refrigerador' },
];

type VariantSeed = {
  name: string;
  adjust?: string;
  factor?: string;
  imageTag?: string;
};

type ItemSeed = {
  name: string;
  sku: string;
  price: string;
  category: string;
  description?: string;
  imageTag: string;
  sortOrder?: number;
  variants?: VariantSeed[];
  comboComponents?: Array<{
    itemName: string;
    variantName?: string;
    quantity?: number;
  }>;
};

async function createItem(tx: any, organizationId: string, seed: ItemSeed) {
  const category = await tx.category.findUniqueOrThrow({
    where: {
      kind_code: { kind: CategoryKind.ARTICLE, code: seed.category },
    },
    select: { id: true },
  });

  const variants = seed.variants ?? [];
  const item = await tx.item.create({
    data: {
      organizationId,
      categoryId: category.id,
      name: seed.name,
      sku: seed.sku,
      description: seed.description ?? null,
      price: seed.price,
      taxRate: TAX_RATE,
      isCombo: Boolean(seed.comboComponents?.length),
      sortOrder: seed.sortOrder ?? 0,
      variants: {
        create: variants.map((variant, index) => ({
          name: variant.name,
          sku: `${seed.sku}${String.fromCharCode(65 + index)}`,
          isPrimary: index === 0,
          priceAdjust: variant.adjust ?? '0',
          recipeFactor: variant.factor ?? '1',
          imageUrl: variant.imageTag ? foodImage(variant.imageTag) : null,
          sortOrder: index,
        })),
      },
    },
    include: { variants: true },
  });

  await tx.catalogEntry.create({
    data: {
      id: item.id,
      organizationId,
      imageUrl: foodImage(seed.imageTag),
      imageName: slug(seed.name),
    },
  });

  await tx.item.update({
    where: { id: item.id },
    data: { catalogEntryId: item.id },
  });

  if (seed.comboComponents?.length) {
    const components = [];
    for (const component of seed.comboComponents) {
      const componentItem = await tx.item.findFirstOrThrow({
        where: { organizationId, name: component.itemName },
        include: { variants: true },
      });
      const variant = component.variantName
        ? componentItem.variants.find(
            (row: any) => row.name === component.variantName,
          )
        : null;

      components.push({
        comboId: item.id,
        componentItemId: componentItem.id,
        componentVariantId: variant?.id ?? null,
        quantity: component.quantity ?? 1,
      });
    }

    await tx.comboComponent.createMany({ data: components });
  }

  return { ...item, variants: item.variants };
}

type RecipeLine = { ingredient: string; quantity: string };

async function createRecipe(
  tx: any,
  organizationId: string,
  ingredients: Map<string, any>,
  seed: {
    name: string;
    category?: string;
    itemId?: string;
    producesIngredient?: string;
    yieldQuantity?: string;
    yieldUnit?: UnitCode;
    lines: RecipeLine[];
    description?: string;
    imageTag?: string;
  },
) {
  const category = seed.category
    ? await tx.category.findUniqueOrThrow({
        where: {
          kind_code: { kind: CategoryKind.RECIPE, code: seed.category },
        },
        select: { id: true },
      })
    : null;

  const produces = seed.producesIngredient
    ? ingredients.get(seed.producesIngredient)
    : null;

  const recipe = await tx.recipe.create({
    data: {
      organizationId,
      itemId: seed.itemId ?? null,
      variantId: null,
      categoryId: category?.id ?? null,
      name: seed.name,
      description: seed.description ?? null,
      producesIngredientId: produces?.id ?? null,
      yieldQuantity: seed.yieldQuantity
        ? toCanonicalQuantity(
            seed.yieldQuantity,
            seed.yieldUnit ?? UnitCode.UNIT,
          )
        : null,
      yieldUnit: seed.yieldUnit ?? null,
    },
  });

  for (const [index, line] of seed.lines.entries()) {
    const ingredient = ingredients.get(line.ingredient);
    if (!ingredient) {
      throw new Error(`Insumo no encontrado: ${line.ingredient}`);
    }

    await tx.recipeIngredient.create({
      data: {
        recipeId: recipe.id,
        ingredientId: ingredient.id,
        quantity: toCanonicalQuantity(
          line.quantity,
          ingredient.displayUnit,
        ),
        sortOrder: index,
      },
    });
  }

  if (seed.itemId) {
    const item = await tx.item.findUniqueOrThrow({
      where: { id: seed.itemId },
      select: { catalogEntryId: true },
    });

    await tx.recipe.update({
      where: { id: recipe.id },
      data: { catalogEntryId: item.catalogEntryId },
    });
  } else {
    await tx.catalogEntry.create({
      data: {
        id: recipe.id,
        organizationId,
        imageUrl: foodImage(seed.imageTag ?? 'food'),
        imageName: slug(seed.name),
      },
    });
    await tx.recipe.update({
      where: { id: recipe.id },
      data: { catalogEntryId: recipe.id },
    });
  }

  return recipe;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida. Revisa api/.env');
  }

  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    include: {
      memberships: {
        where: { isActive: true },
        include: { organization: true },
      },
    },
  });

  if (!user) throw new Error(`No existe el usuario ${EMAIL}`);

  const membership = user.memberships.find((row) => row.organization);
  if (!membership?.organization) {
    throw new Error(`El usuario ${EMAIL} no tiene una organización activa`);
  }

  const organizationId = membership.organization.id;
  console.log(`Usuario: ${EMAIL}`);
  console.log(`Organización: ${membership.organization.name} (${organizationId})`);

  await prisma.$transaction(
    async (tx) => {
      console.log('Borrando datos de la organización…');
      await wipeOrganization(tx, organizationId);

      console.log('Sembrando datos core…');
      await ensureCore(tx);

      const ingredientCategoryMap = Object.fromEntries(
        (
          await tx.ingredientCategory.findMany({
            where: { organizationId: null, isCore: true },
            select: { id: true, name: true },
          })
        ).map((row: any) => [row.name, row.id]),
      );
      const ingredientLocationMap = Object.fromEntries(
        (
          await tx.ingredientLocation.findMany({
            where: { organizationId: null, isCore: true },
            select: { id: true, name: true },
          })
        ).map((row: any) => [row.name, row.id]),
      );

      console.log('Creando insumos…');
      const ingredients = new Map<string, any>();
      for (const seed of INGREDIENT_SEEDS) {
        const displayUnit = seed.unit;
        const baseUnit = canonicalUnit(displayUnit);

        const ingredient = await tx.ingredient.create({
          data: {
            organizationId,
            name: seed.name,
            baseUnit,
            displayUnit,
            currentStock: toCanonicalQuantity(seed.stock, displayUnit),
            minStock: toCanonicalQuantity(seed.min, displayUnit),
            maxStock: seed.max
              ? toCanonicalQuantity(seed.max, displayUnit)
              : null,
            unitCost: toCanonicalCost(seed.cost, displayUnit),
            categoryId: ingredientCategoryMap[seed.category] ?? null,
            locationId: ingredientLocationMap[seed.location] ?? null,
          },
        });

        ingredients.set(seed.name, ingredient);
      }

      console.log('Creando recetas base (producen insumos)…');
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Salsa roja base',
        category: 'sauces',
        producesIngredient: 'Salsa roja',
        yieldQuantity: '1.5',
        yieldUnit: UnitCode.L,
        imageTag: 'salsa',
        description: 'Base de jitomate y chile guajillo para pizzas y platillos.',
        lines: [
          { ingredient: 'Jitomate saladet', quantity: '0.5' },
          { ingredient: 'Chile guajillo', quantity: '0.08' },
          { ingredient: 'Ajo', quantity: '0.02' },
          { ingredient: 'Cebolla blanca', quantity: '0.15' },
          { ingredient: 'Aceite vegetal', quantity: '0.05' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Salsa verde base',
        category: 'sauces',
        producesIngredient: 'Salsa verde',
        yieldQuantity: '1.5',
        yieldUnit: UnitCode.L,
        imageTag: 'green salsa',
        description: 'Base de tomate verde para chilaquiles y enchiladas.',
        lines: [
          { ingredient: 'Tomate verde', quantity: '0.6' },
          { ingredient: 'Chile serrano', quantity: '0.08' },
          { ingredient: 'Cilantro', quantity: '0.03' },
          { ingredient: 'Cebolla blanca', quantity: '0.1' },
          { ingredient: 'Ajo', quantity: '0.015' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Adobo de pollo',
        category: 'sauces',
        producesIngredient: 'Adobo de pollo',
        yieldQuantity: '1',
        yieldUnit: UnitCode.L,
        imageTag: 'adobo',
        description: 'Marinado de chile para pollo y sándwiches.',
        lines: [
          { ingredient: 'Chile guajillo', quantity: '0.1' },
          { ingredient: 'Ajo', quantity: '0.03' },
          { ingredient: 'Vinagre blanco', quantity: '0.2' },
          { ingredient: 'Aceite vegetal', quantity: '0.1' },
          { ingredient: 'Cebolla blanca', quantity: '0.1' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Crema Alfredo',
        category: 'sauces',
        producesIngredient: 'Crema Alfredo',
        yieldQuantity: '1',
        yieldUnit: UnitCode.L,
        imageTag: 'alfredo sauce',
        description: 'Crema con parmesano y mantequilla para pasta.',
        lines: [
          { ingredient: 'Crema para batir', quantity: '0.8' },
          { ingredient: 'Mantequilla', quantity: '0.1' },
          { ingredient: 'Queso parmesano', quantity: '0.1' },
          { ingredient: 'Ajo', quantity: '0.01' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Ganache de chocolate',
        category: 'fillings',
        producesIngredient: 'Ganache de chocolate',
        yieldQuantity: '1',
        yieldUnit: UnitCode.KG,
        imageTag: 'chocolate ganache',
        description: 'Cobertura de chocolate para postres.',
        lines: [
          { ingredient: 'Chocolate semiamargo', quantity: '0.5' },
          { ingredient: 'Crema para batir', quantity: '0.4' },
          { ingredient: 'Mantequilla', quantity: '0.05' },
        ],
      });

      console.log('Creando preparaciones independientes…');
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Masa para pizza',
        category: 'doughs',
        yieldQuantity: '1.5',
        yieldUnit: UnitCode.KG,
        imageTag: 'pizza dough',
        lines: [
          { ingredient: 'Harina de trigo', quantity: '1' },
          { ingredient: 'Agua filtrada', quantity: '0.6' },
          { ingredient: 'Levadura', quantity: '0.01' },
          { ingredient: 'Aceite vegetal', quantity: '0.05' },
          { ingredient: 'Azúcar', quantity: '0.02' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Frijoles refritos',
        category: 'sides',
        yieldQuantity: '0.8',
        yieldUnit: UnitCode.KG,
        imageTag: 'refried beans',
        lines: [
          { ingredient: 'Frijol negro', quantity: '0.5' },
          { ingredient: 'Cebolla blanca', quantity: '0.1' },
          { ingredient: 'Aceite vegetal', quantity: '0.05' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Arroz rojo',
        category: 'sides',
        yieldQuantity: '1',
        yieldUnit: UnitCode.KG,
        imageTag: 'mexican rice',
        lines: [
          { ingredient: 'Arroz', quantity: '0.5' },
          { ingredient: 'Jitomate saladet', quantity: '0.2' },
          { ingredient: 'Cebolla blanca', quantity: '0.1' },
          { ingredient: 'Ajo', quantity: '0.01' },
          { ingredient: 'Aceite vegetal', quantity: '0.05' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Vinagreta de la casa',
        category: 'sauces',
        yieldQuantity: '0.5',
        yieldUnit: UnitCode.L,
        imageTag: 'salad dressing',
        lines: [
          { ingredient: 'Aceite vegetal', quantity: '0.3' },
          { ingredient: 'Vinagre blanco', quantity: '0.1' },
          { ingredient: 'Mostaza', quantity: '0.02' },
          { ingredient: 'Miel', quantity: '0.05' },
        ],
      });

      await createRecipe(tx, organizationId, ingredients, {
        name: 'Pollo marinado',
        category: 'prepped_ingredients',
        yieldQuantity: '1',
        yieldUnit: UnitCode.KG,
        imageTag: 'marinated chicken',
        lines: [
          { ingredient: 'Pollo pechuga', quantity: '1' },
          { ingredient: 'Limón', quantity: '0.1' },
          { ingredient: 'Ajo', quantity: '0.02' },
          { ingredient: 'Aceite vegetal', quantity: '0.1' },
          { ingredient: 'Chile guajillo', quantity: '0.02' },
        ],
      });

      console.log('Creando artículos con receta (publicados)…');
      const hamburguesa = await createItem(tx, organizationId, {
        name: 'Hamburguesa clásica',
        sku: 'BUR-001',
        price: '149',
        category: 'burgers_sandwiches',
        imageTag: 'burger',
        sortOrder: 1,
        variants: [
          { name: 'Sencilla', adjust: '0', factor: '1', imageTag: 'burger' },
          { name: 'Doble', adjust: '40', factor: '1.4', imageTag: 'burger' },
        ],
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Hamburguesa clásica',
        category: 'dishes',
        itemId: hamburguesa.id,
        lines: [
          { ingredient: 'Pan brioche', quantity: '1' },
          { ingredient: 'Carne de res molida', quantity: '0.15' },
          { ingredient: 'Queso cheddar', quantity: '0.03' },
          { ingredient: 'Lechuga romana', quantity: '0.02' },
          { ingredient: 'Jitomate saladet', quantity: '0.03' },
          { ingredient: 'Cebolla blanca', quantity: '0.02' },
          { ingredient: 'Mayonesa', quantity: '0.02' },
        ],
      });

      const tacos = await createItem(tx, organizationId, {
        name: 'Tacos al pastor (3 pz)',
        sku: 'TAC-001',
        price: '95',
        category: 'tacos',
        imageTag: 'tacos',
        sortOrder: 2,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Tacos al pastor',
        category: 'dishes',
        itemId: tacos.id,
        lines: [
          { ingredient: 'Tortilla de maíz', quantity: '0.12' },
          { ingredient: 'Carne de cerdo', quantity: '0.18' },
          { ingredient: 'Piña', quantity: '0.04' },
          { ingredient: 'Cebolla blanca', quantity: '0.02' },
          { ingredient: 'Cilantro', quantity: '0.01' },
          { ingredient: 'Chile guajillo', quantity: '0.01' },
          { ingredient: 'Aceite vegetal', quantity: '0.01' },
        ],
      });

      const pizza = await createItem(tx, organizationId, {
        name: 'Pizza margarita',
        sku: 'PIZ-001',
        price: '179',
        category: 'pizza_pasta',
        imageTag: 'pizza',
        sortOrder: 3,
        variants: [
          { name: 'Personal', adjust: '0', factor: '1', imageTag: 'pizza' },
          { name: 'Mediana', adjust: '30', factor: '1.3', imageTag: 'pizza' },
          { name: 'Grande', adjust: '70', factor: '1.7', imageTag: 'pizza' },
        ],
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Pizza margarita',
        category: 'dishes',
        itemId: pizza.id,
        lines: [
          { ingredient: 'Harina de trigo', quantity: '0.25' },
          { ingredient: 'Levadura', quantity: '0.005' },
          { ingredient: 'Salsa roja', quantity: '0.12' },
          { ingredient: 'Queso mozzarella', quantity: '0.15' },
          { ingredient: 'Jitomate saladet', quantity: '0.05' },
          { ingredient: 'Aceite vegetal', quantity: '0.01' },
        ],
      });

      const ensalada = await createItem(tx, organizationId, {
        name: 'Ensalada césar',
        sku: 'ENS-001',
        price: '119',
        category: 'starters',
        imageTag: 'caesar salad',
        sortOrder: 4,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Ensalada césar',
        category: 'dishes',
        itemId: ensalada.id,
        lines: [
          { ingredient: 'Lechuga romana', quantity: '0.15' },
          { ingredient: 'Pollo pechuga', quantity: '0.12' },
          { ingredient: 'Queso parmesano', quantity: '0.02' },
          { ingredient: 'Pan molido', quantity: '0.03' },
          { ingredient: 'Mayonesa', quantity: '0.03' },
          { ingredient: 'Mostaza', quantity: '0.005' },
          { ingredient: 'Ajo', quantity: '0.005' },
        ],
      });

      const pasta = await createItem(tx, organizationId, {
        name: 'Pasta Alfredo',
        sku: 'PAS-001',
        price: '165',
        category: 'pizza_pasta',
        imageTag: 'fettuccine alfredo',
        sortOrder: 5,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Pasta Alfredo',
        category: 'dishes',
        itemId: pasta.id,
        lines: [
          { ingredient: 'Pasta fettuccine', quantity: '0.15' },
          { ingredient: 'Crema Alfredo', quantity: '0.15' },
          { ingredient: 'Queso parmesano', quantity: '0.03' },
          { ingredient: 'Mantequilla', quantity: '0.01' },
          { ingredient: 'Ajo', quantity: '0.005' },
        ],
      });

      const chilaquiles = await createItem(tx, organizationId, {
        name: 'Chilaquiles verdes',
        sku: 'CHI-001',
        price: '129',
        category: 'breakfast',
        imageTag: 'chilaquiles',
        sortOrder: 6,
        variants: [
          { name: 'Sencillos', adjust: '0', factor: '1' },
          { name: 'Con pollo', adjust: '35', factor: '1.2' },
        ],
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Chilaquiles verdes',
        category: 'dishes',
        itemId: chilaquiles.id,
        lines: [
          { ingredient: 'Tortilla de maíz', quantity: '0.12' },
          { ingredient: 'Salsa verde', quantity: '0.15' },
          { ingredient: 'Crema para batir', quantity: '0.03' },
          { ingredient: 'Queso fresco', quantity: '0.03' },
          { ingredient: 'Cebolla blanca', quantity: '0.02' },
          { ingredient: 'Cilantro', quantity: '0.01' },
        ],
      });

      const sandwich = await createItem(tx, organizationId, {
        name: 'Sándwich de pollo',
        sku: 'SAN-001',
        price: '109',
        category: 'burgers_sandwiches',
        imageTag: 'chicken sandwich',
        sortOrder: 7,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Sándwich de pollo',
        category: 'dishes',
        itemId: sandwich.id,
        lines: [
          { ingredient: 'Pan brioche', quantity: '1' },
          { ingredient: 'Pollo pechuga', quantity: '0.12' },
          { ingredient: 'Adobo de pollo', quantity: '0.03' },
          { ingredient: 'Lechuga romana', quantity: '0.02' },
          { ingredient: 'Jitomate saladet', quantity: '0.03' },
          { ingredient: 'Mayonesa', quantity: '0.02' },
        ],
      });

      const croissant = await createItem(tx, organizationId, {
        name: 'Croissant de mantequilla',
        sku: 'CRO-001',
        price: '42',
        category: 'bakery',
        imageTag: 'croissant',
        sortOrder: 8,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Croissant de mantequilla',
        category: 'dishes',
        itemId: croissant.id,
        lines: [
          { ingredient: 'Harina de trigo', quantity: '0.08' },
          { ingredient: 'Mantequilla', quantity: '0.03' },
          { ingredient: 'Huevo', quantity: '0.3' },
          { ingredient: 'Leche entera', quantity: '0.03' },
          { ingredient: 'Azúcar', quantity: '0.01' },
          { ingredient: 'Levadura', quantity: '0.002' },
        ],
      });

      const brownie = await createItem(tx, organizationId, {
        name: 'Brownie con nuez',
        sku: 'BRO-001',
        price: '65',
        category: 'desserts',
        imageTag: 'brownie',
        sortOrder: 9,
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Brownie con nuez',
        category: 'dishes',
        itemId: brownie.id,
        lines: [
          { ingredient: 'Chocolate semiamargo', quantity: '0.05' },
          { ingredient: 'Mantequilla', quantity: '0.03' },
          { ingredient: 'Huevo', quantity: '0.4' },
          { ingredient: 'Azúcar', quantity: '0.04' },
          { ingredient: 'Harina de trigo', quantity: '0.03' },
          { ingredient: 'Nuez', quantity: '0.02' },
          { ingredient: 'Ganache de chocolate', quantity: '0.03' },
        ],
      });

      const latte = await createItem(tx, organizationId, {
        name: 'Latte vainilla',
        sku: 'CAF-001',
        price: '58',
        category: 'hot_drinks',
        imageTag: 'latte',
        sortOrder: 10,
        variants: [
          { name: 'Mediano', adjust: '0', factor: '1', imageTag: 'latte' },
          { name: 'Grande', adjust: '12', factor: '1.3', imageTag: 'latte' },
        ],
      });
      await createRecipe(tx, organizationId, ingredients, {
        name: 'Latte vainilla',
        category: 'beverages',
        itemId: latte.id,
        lines: [
          { ingredient: 'Café molido', quantity: '0.008' },
          { ingredient: 'Leche entera', quantity: '0.15' },
          { ingredient: 'Vainilla', quantity: '0.005' },
          { ingredient: 'Vaso 16 oz', quantity: '1' },
        ],
      });

      console.log('Creando artículos sin receta…');
      const agua = await createItem(tx, organizationId, {
        name: 'Agua mineral',
        sku: 'BEB-001',
        price: '25',
        category: 'bottled_drinks',
        imageTag: 'water bottle',
        sortOrder: 11,
        variants: [
          { name: '600 ml', adjust: '0' },
          { name: '1 L', adjust: '10' },
        ],
      });

      const refresco = await createItem(tx, organizationId, {
        name: 'Refresco de cola',
        sku: 'BEB-002',
        price: '30',
        category: 'bottled_drinks',
        imageTag: 'soda',
        sortOrder: 12,
        variants: [
          { name: '355 ml', adjust: '0' },
          { name: '600 ml', adjust: '8' },
        ],
      });

      await createItem(tx, organizationId, {
        name: 'Jugo de naranja',
        sku: 'BEB-003',
        price: '45',
        category: 'cold_drinks',
        imageTag: 'orange juice',
        sortOrder: 13,
        variants: [
          { name: '12 oz', adjust: '0' },
          { name: '16 oz', adjust: '12' },
        ],
      });

      await createItem(tx, organizationId, {
        name: 'Té helado',
        sku: 'BEB-004',
        price: '40',
        category: 'cold_drinks',
        imageTag: 'iced tea',
        sortOrder: 14,
      });

      await createItem(tx, organizationId, {
        name: 'Café americano',
        sku: 'BEB-005',
        price: '40',
        category: 'hot_drinks',
        imageTag: 'black coffee',
        sortOrder: 15,
      });

      const papas = await createItem(tx, organizationId, {
        name: 'Papas a la francesa',
        sku: 'GUA-001',
        price: '55',
        category: 'sides',
        imageTag: 'french fries',
        sortOrder: 16,
      });

      const aros = await createItem(tx, organizationId, {
        name: 'Aros de cebolla',
        sku: 'GUA-002',
        price: '59',
        category: 'sides',
        imageTag: 'onion rings',
        sortOrder: 17,
      });

      await createItem(tx, organizationId, {
        name: 'Galleta con chispas de chocolate',
        sku: 'POS-001',
        price: '32',
        category: 'bakery',
        imageTag: 'chocolate chip cookie',
        sortOrder: 18,
      });

      await createItem(tx, organizationId, {
        name: 'Yogur con granola',
        sku: 'POS-002',
        price: '45',
        category: 'breakfast',
        imageTag: 'yogurt granola',
        sortOrder: 19,
      });

      await createItem(tx, organizationId, {
        name: 'Barra de chocolate',
        sku: 'POS-003',
        price: '38',
        category: 'retail',
        imageTag: 'chocolate bar',
        sortOrder: 20,
      });

      console.log('Creando combo…');
      const combo = await createItem(tx, organizationId, {
        name: 'Combo familiar',
        sku: 'COM-001',
        price: '249',
        category: 'combos',
        imageTag: 'burger combo',
        sortOrder: 1,
        comboComponents: [
          { itemName: 'Hamburguesa clásica', variantName: 'Sencilla' },
          { itemName: 'Papas a la francesa' },
          { itemName: 'Refresco de cola', variantName: '355 ml' },
          { itemName: 'Brownie con nuez' },
          { itemName: 'Agua mineral', variantName: '600 ml' },
        ],
      });

      console.log('Creando menús…');
      const menuOfTheDay = await tx.menu.create({
        data: {
          organizationId,
          name: 'Menú del día',
          description: 'Platillos, bebidas y postres disponibles todos los días.',
          isActive: true,
          sortOrder: 1,
          groups: ['Platos fuertes', 'Bebidas', 'Postres'],
        },
      });

      const dayItems = [
        { item: hamburguesa, group: 'Platos fuertes' },
        { item: tacos, group: 'Platos fuertes' },
        { item: pizza, group: 'Platos fuertes' },
        { item: pasta, group: 'Platos fuertes' },
        { item: chilaquiles, group: 'Platos fuertes' },
        { item: ensalada, group: 'Platos fuertes' },
        { item: latte, group: 'Bebidas' },
        { item: agua, group: 'Bebidas' },
        { item: refresco, group: 'Bebidas' },
        { item: brownie, group: 'Postres' },
        { item: croissant, group: 'Postres' },
      ];
      await tx.menuItem.createMany({
        data: dayItems.map((row, index) => ({
          menuId: menuOfTheDay.id,
          itemId: row.item.id,
          group: row.group,
          sortOrder: index,
        })),
      });

      const weekend = await tx.menu.create({
        data: {
          organizationId,
          name: 'Fin de semana',
          description: 'Combos y botanas para compartir de viernes a domingo.',
          isActive: true,
          sortOrder: 2,
          daysOfWeek: [5, 6, 0],
          groups: ['Para compartir', 'Bebidas frías'],
        },
      });
      await tx.menuItem.createMany({
        data: [
          { item: combo, group: 'Para compartir' },
          { item: pizza, group: 'Para compartir' },
          { item: papas, group: 'Para compartir' },
          { item: aros, group: 'Para compartir' },
          { item: refresco, group: 'Bebidas frías' },
          { item: agua, group: 'Bebidas frías' },
        ].map((row, index) => ({
          menuId: weekend.id,
          itemId: row.item.id,
          group: row.group,
          sortOrder: index,
        })),
      });

      const dinner = await tx.menu.create({
        data: {
          organizationId,
          name: 'Cena',
          description: 'Disponible de jueves a domingo por la noche.',
          isActive: true,
          sortOrder: 3,
          daysOfWeek: [4, 5, 6],
          startTime: '18:00',
          endTime: '23:00',
          groups: ['Cena', 'Postres'],
        },
      });
      await tx.menuItem.createMany({
        data: [
          { item: pasta, group: 'Cena' },
          { item: ensalada, group: 'Cena' },
          { item: sandwich, group: 'Cena' },
          { item: brownie, group: 'Postres' },
        ].map((row, index) => ({
          menuId: dinner.id,
          itemId: row.item.id,
          group: row.group,
          sortOrder: index,
        })),
      });

      // Conteos finales
      const [items, recipes, ingredientsCount, menus, combos] =
        await Promise.all([
          tx.item.count({ where: { organizationId } }),
          tx.recipe.count({ where: { organizationId } }),
          tx.ingredient.count({ where: { organizationId } }),
          tx.menu.count({ where: { organizationId } }),
          tx.item.count({ where: { organizationId, isCombo: true } }),
        ]);

      console.log('Seed completado:');
      console.log(`  Artículos      : ${items}`);
      console.log(`  Recetas        : ${recipes}`);
      console.log(`  Insumos        : ${ingredientsCount}`);
      console.log(`  Combos         : ${combos}`);
      console.log(`  Menús          : ${menus}`);
    },
    { timeout: 300_000 },
  );
}

main()
  .catch((error) => {
    console.error('Seed falló:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
