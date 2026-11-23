/**
 * Crea una organización temporal con datos mínimos para validar las 20
 * preguntas de oro sin consumir la cuota de la organización principal.
 *
 * Uso:
 *   node scripts/seed-intel-validation-org.mjs
 *   node scripts/seed-intel-validation-org.mjs --cleanup
 */
import 'dotenv/config';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from 'argon2';
import pg from 'pg';

const { Client } = pg;
const db = new Client({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://np_user:np_password@localhost:55432/np_db',
});

const STATE_PATH = join(tmpdir(), 'intel-validation-org.json');
const run = Date.now().toString(36);
const slug = `intel-val-${run}`;
const email = `${slug}@example.local`;
const password = 'Intel123!';
const orgId = `org-${slug}`;
const userId = `usr-${slug}`;
const ids = {};

function id(prefix) {
  return `${prefix}-${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

const now = Date.now();
const daysAgo = (days) => new Date(now - days * 86400000);

async function main() {
  await db.connect();

  if (process.argv.includes('--cleanup')) {
    if (!existsSync(STATE_PATH)) {
      console.log('No hay organización temporal registrada');
      return;
    }

    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));

    // Orden de borrado por las FK restrict de OrderItem→Product y
    // RecipeIngredient/MenuItem→Product.
    await db.query(`DELETE FROM "Order" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Payment" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Waste" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(
      `DELETE FROM "InventoryMovement" WHERE "organizationId" = $1`,
      [state.orgId],
    );
    await db.query(`DELETE FROM "CashSession" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Purchase" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Menu" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Recipe" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Product" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Ingredient" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Supplier" WHERE "organizationId" = $1`, [
      state.orgId,
    ]);
    await db.query(`DELETE FROM "Organization" WHERE id = $1`, [state.orgId]);
    await db.query(`DELETE FROM "User" WHERE id = $1`, [state.userId]);
    unlinkSync(STATE_PATH);

    console.log(`Organización temporal ${state.slug} eliminada`);
    return;
  }

  const passwordHash = await hash(password);

  await db.query(
    `INSERT INTO "Organization"
      (id, name, slug, "intelEnabled", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, now(), now())`,
    [orgId, `Intel Validation ${run}`, slug],
  );

  await db.query(
    `INSERT INTO "User"
      (id, email, "passwordHash", name, "emailVerified", "isActive",
       "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Intel Validation', true, true, now(), now())`,
    [userId, email, passwordHash],
  );

  await db.query(
    `INSERT INTO "Membership"
      (id, "userId", "organizationId", username, roles, "isActive", "isOwner",
       "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'admin', ARRAY['ADMIN']::"Role"[], true, true,
             now(), now())`,
    [id('membership'), userId, orgId],
  );

  ids.ingredient = id('ingredient');
  await db.query(
    `INSERT INTO "Ingredient"
      (id, "organizationId", name, sku, "baseUnit", "displayUnit",
       "currentStock", "minStock", "unitCost", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Salsa verde', $3, 'ML', 'ML', 500, 1000, 0.05, true,
             now(), now())`,
    [ids.ingredient, orgId, `SKU-${slug}`],
  );

  ids.item = id('item');
  await db.query(
    `INSERT INTO "Product"
      (id, "organizationId", name, price, "taxRate", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Salsa verde', 50, 0.16, true, now(), now())`,
    [ids.item, orgId],
  );

  ids.recipe = id('recipe');
  await db.query(
    `INSERT INTO "Recipe"
      (id, "organizationId", "productId", name, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Receta salsa verde', true, now(), now())`,
    [ids.recipe, orgId, ids.item],
  );
  await db.query(
    `INSERT INTO "RecipeIngredient"
      (id, "recipeId", "ingredientId", quantity, "isOptional", "sortOrder")
     VALUES ($1, $2, $3, 50, false, 0)`,
    [id('recipe-ingredient'), ids.recipe, ids.ingredient],
  );

  ids.menu = id('menu');
  await db.query(
    `INSERT INTO "Menu"
      (id, "organizationId", name, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Menú validación', true, now(), now())`,
    [ids.menu, orgId],
  );
  await db.query(
    `INSERT INTO "MenuItem" (id, "menuId", "itemId", "sortOrder")
     VALUES ($1, $2, $3, 0)`,
    [id('menu-item'), ids.menu, ids.item],
  );

  ids.supplier = id('supplier');
  await db.query(
    `INSERT INTO "Supplier"
      (id, "organizationId", name, aliases, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Proveedor validación', ARRAY[]::text[], true, now(), now())`,
    [ids.supplier, orgId],
  );

  for (const [index, price] of [
    [0, 0.04],
    [1, 0.045],
  ]) {
    const purchaseId = id(`purchase-${index}`);
    ids[`purchase${index}`] = purchaseId;
    await db.query(
      `INSERT INTO "Purchase"
        (id, "organizationId", "supplierId", folio, "purchasedAt", total,
         status, "createdBy", "approvedBy", "approvedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', $7, $7, now(), now(), now())`,
      [
        purchaseId,
        orgId,
        ids.supplier,
        `${slug}-${index}`,
        daysAgo(index === 0 ? 20 : 5),
        price * 1000,
        userId,
      ],
    );
    await db.query(
      `INSERT INTO "PurchaseItem"
        (id, "purchaseId", "rawDescription", "ingredientId", quantity, unit,
         "unitCostGross", "lineTotalGross", "mappingSource")
       VALUES ($1, $2, 'SALSA VERDE 1 L', $3, 1000, 'ML', $4, $5, 'AI')`,
      [
        id('purchase-item'),
        purchaseId,
        ids.ingredient,
        price,
        price * 1000,
      ],
    );
  }

  const methods = ['CASH', 'CARD', 'CASH'];

  for (let index = 0; index < 3; index += 1) {
    const orderId = id(`order-${index}`);
    const roundId = id(`round-${index}`);
    const createdAt = daysAgo(index + 1);
    ids[`order${index}`] = orderId;
    ids[`round${index}`] = roundId;

    await db.query(
      `INSERT INTO "Order"
        (id, "organizationId", status, subtotal, "taxTotal", total, "userId",
         "createdAt", "updatedAt")
       VALUES ($1, $2, 'CLOSED', 50, 8, 58, $3, $4, now())`,
      [orderId, orgId, userId, createdAt],
    );

    await db.query(
      `INSERT INTO "OrderRound"
        (id, "orderId", status, "sentAt", "startedAt", "readyAt", "deliveredAt",
         "createdAt", "updatedAt")
       VALUES ($1, $2, 'DELIVERED', $3, $4, $5, $6, $3, now())`,
      [
        roundId,
        orderId,
        createdAt,
        new Date(createdAt.getTime() + 2 * 60000),
        new Date(createdAt.getTime() + 12 * 60000),
        new Date(createdAt.getTime() + 14 * 60000),
      ],
    );

    await db.query(
      `INSERT INTO "OrderItem"
        (id, "orderRoundId", "productId", "productName", "productPrice",
         quantity, subtotal, "discountAmount", "taxAmount")
       VALUES ($1, $2, $3, 'Salsa verde', 50, 1, 50, 0, 8)`,
      [id('order-item'), roundId, ids.item],
    );

    await db.query(
      `INSERT INTO "Payment"
        (id, "organizationId", "orderId", "userId", method, amount, status,
         "paidAt", "confirmedAt", "confirmedById", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 58, 'CONFIRMED', $6, $6, $4, $6, now())`,
      [id('payment'), orgId, orderId, userId, methods[index], createdAt],
    );
  }

  const cancelledOrder = id('order-cancelled');
  await db.query(
    `INSERT INTO "Order"
      (id, "organizationId", status, subtotal, "taxTotal", total, "userId",
       "createdAt", "updatedAt")
     VALUES ($1, $2, 'CANCELLED', 50, 8, 58, $3, $4, now())`,
    [cancelledOrder, orgId, userId, daysAgo(3)],
  );

  const openOrder = id('order-open');
  await db.query(
    `INSERT INTO "Order"
      (id, "organizationId", status, subtotal, "taxTotal", total, "userId",
       "createdAt", "updatedAt")
     VALUES ($1, $2, 'OPEN', 50, 8, 58, $3, $4, now())`,
    [openOrder, orgId, userId, daysAgo(1)],
  );

  for (const [index, days] of [
    [0, 5],
    [1, 2],
  ]) {
    await db.query(
      `INSERT INTO "InventoryMovement"
        (id, "organizationId", "ingredientId", "ingredientName", "displayUnit",
         "userId", type, quantity, "stockAfter", reason, "createdAt")
       VALUES ($1, $2, $3, 'Salsa verde', 'ML', $4, 'CONSUMPTION', -200,
               $5, 'Consumo validación', $6)`,
      [
        id(`movement-${index}`),
        orgId,
        ids.ingredient,
        userId,
        500 - (index + 1) * 200,
        daysAgo(days),
      ],
    );
  }

  await db.query(
    `INSERT INTO "Waste"
      (id, "organizationId", "ingredientName", quantity, "displayUnit", reason,
       cost, "userId", "createdAt")
     VALUES ($1, $2, 'Salsa verde', 100, 'ML', 'EXPIRED', 5, $3, $4)`,
    [id('waste'), orgId, userId, daysAgo(2)],
  );

  await db.query(
    `INSERT INTO "CashSession"
      (id, "organizationId", status, "openedById", "openedAt", "closedById",
       "closedAt", "countedCash", "expectedCash", difference, "createdAt", "updatedAt")
     VALUES ($1, $2, 'CLOSED', $3, $4, $3, $5, 900, 1000, -100, now(), now())`,
    [
      id('cash-session'),
      orgId,
      userId,
      daysAgo(3),
      daysAgo(3),
    ],
  );

  const credentials = { slug, email, password, orgId, userId };
  writeFileSync(
    STATE_PATH,
    JSON.stringify(credentials, null, 2),
  );

  console.log(`INTEL_VALIDATION_USER=${email}`);
  console.log(`INTEL_VALIDATION_PASSWORD=${password}`);
  console.log(`INTEL_VALIDATION_TENANT=${slug}`);
}

try {
  await main();
} finally {
  await db.end();
}
