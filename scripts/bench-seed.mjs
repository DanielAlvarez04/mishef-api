/**
 * Siembra una base de pruebas con volumen realista para medir consultas.
 *
 * No toca los datos de desarrollo: escribe en la base apuntada por
 * `BENCH_DATABASE_URL` (por convención `np_bench`).
 *
 * Uso:
 *   BENCH_DATABASE_URL="postgresql://np_user:np_password@localhost:55432/np_bench" \
 *     node scripts/bench-seed.mjs
 *
 * Variables opcionales: BENCH_ORDERS (5000), BENCH_PRODUCTS (300).
 */
import pg from 'pg';

const { Client } = pg;

const url = process.env.BENCH_DATABASE_URL;

if (!url) {
  console.error('Falta BENCH_DATABASE_URL');
  process.exit(1);
}

const ORDERS = Number(process.env.BENCH_ORDERS ?? 5000);
const PRODUCTS = Number(process.env.BENCH_PRODUCTS ?? 300);
const INGREDIENTS = 120;
const MOVEMENTS = Number(process.env.BENCH_MOVEMENTS ?? 20000);
const DAYS = 90;

const ORG = 'bnc_org';
const BRANCH = 'bnc_branch';

const rand = (n) => Math.floor(Math.random() * n);
const pick = (list) => list[rand(list.length)];
const now = Date.now();
const start = now - DAYS * 24 * 60 * 60 * 1000;

/** Fecha aleatoria dentro de los últimos DAYS días. */
function randomDate(daysBack = DAYS) {
  const from = now - daysBack * 24 * 60 * 60 * 1000;
  return new Date(from + rand(now - from));
}

async function insertMany(client, table, columns, rows, chunkSize = 500) {
  const columnList = columns.map((column) => `"${column}"`).join(', ');

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const slice = rows.slice(offset, offset + chunkSize);
    const params = [];
    let position = 1;

    const values = slice.map((row) => {
      const placeholders = row.map(() => `$${position++}`);
      params.push(...row);
      return `(${placeholders.join(', ')})`;
    });

    await client.query(
      `INSERT INTO "${table}" (${columnList}) VALUES ${values.join(', ')}`,
      params,
    );
  }
}

const client = new Client({ connectionString: url });
await client.connect();

console.log('Limpiando datos de prueba…');
await client.query(`
  TRUNCATE TABLE
    "Payment", "OrderItem", "OrderRound", "Order",
    "InventoryMovement", "MenuItem", "Menu",
    "Product", "Category", "Ingredient", "Branch", "Organization"
  RESTART IDENTITY CASCADE
`);

console.log('Organización y sucursal…');
const created = new Date(start);
const stamp = created.toISOString();

await insertMany(client, 'Organization', ['id', 'name', 'slug', 'updatedAt'], [
  [ORG, 'Bench Org', 'bench-org', stamp],
]);
await insertMany(client, 'Branch', ['id', 'organizationId', 'name', 'updatedAt'], [
  [BRANCH, ORG, 'Sucursal Centro', stamp],
]);

console.log(`Categorías e insumos…`);
const categories = Array.from({ length: 12 }, (_, index) => [
  `bnc_cat_${index}`,
  ORG,
  `Categoría ${index + 1}`,
  stamp,
]);
await insertMany(client, 'Category', ['id', 'organizationId', 'name', 'updatedAt'], categories);

const ingredients = Array.from({ length: INGREDIENTS }, (_, index) => [
  `bnc_ing_${index}`,
  ORG,
  `Insumo ${index + 1}`,
  'G',
  'G',
  (Math.random() * 5000).toFixed(4),
  String(index + 1).padStart(4, '0'),
  stamp,
]);
await insertMany(
  client,
  'Ingredient',
  ['id', 'organizationId', 'name', 'baseUnit', 'displayUnit', 'currentStock', 'sku', 'updatedAt'],
  ingredients,
);

console.log(`${PRODUCTS} artículos…`);
const products = Array.from({ length: PRODUCTS }, (_, index) => {
  const price = (20 + rand(180)).toFixed(2);
  return [
    `bnc_item_${index}`,
    ORG,
    `bnc_cat_${index % 12}`,
    `Artículo ${index + 1}`,
    price,
    String((index % 300) + 1).padStart(4, '0'),
    stamp,
  ];
});
await insertMany(
  client,
  'Product',
  ['id', 'organizationId', 'categoryId', 'name', 'price', 'sku', 'updatedAt'],
  products,
);

console.log('Menú global con todos los artículos…');
await insertMany(client, 'Menu', ['id', 'organizationId', 'name', 'updatedAt'], [
  ['bnc_menu', ORG, 'Menú global', stamp],
]);
await insertMany(
  client,
  'MenuItem',
  ['id', 'menuId', 'itemId', 'sortOrder', 'group'],
  products.map((_, index) => [
    `bnc_mi_${index}`,
    'bnc_menu',
    `bnc_item_${index}`,
    index,
    `Grupo ${index % 8}`,
  ]),
);

console.log(`${ORDERS} pedidos con rondas, ítems y pagos…`);
const orders = [];
const rounds = [];
const items = [];
const payments = [];

for (let index = 0; index < ORDERS; index++) {
  const createdAt = randomDate();
  const orderId = `bnc_order_${index}`;
  const closed = Math.random() < 0.92;
  const cancelled = !closed && Math.random() < 0.4;
  const status = cancelled ? 'CANCELLED' : closed ? 'CLOSED' : 'OPEN';
  const roundCount = 1 + rand(3);
  let total = 0;

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    const roundId = `bnc_round_${index}_${roundIndex}`;
    const itemCount = 1 + rand(5);
    const roundAt = new Date(createdAt.getTime() + roundIndex * 6 * 60 * 1000);

    rounds.push([
      roundId,
      orderId,
      closed ? 'DELIVERED' : 'PENDING',
      roundAt.toISOString(),
      roundAt.toISOString(),
      roundAt.toISOString(),
      roundAt.toISOString(),
      roundAt.toISOString(),
    ]);

    for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
      const productIndex = rand(PRODUCTS);
      const price = Number(products[productIndex][4]);
      const quantity = 1 + rand(3);
      const subtotal = price * quantity;
      total += subtotal;

      items.push([
        `bnc_oi_${index}_${roundIndex}_${itemIndex}`,
        roundId,
        `bnc_item_${productIndex}`,
        products[productIndex][3],
        price.toFixed(2),
        subtotal.toFixed(2),
        quantity,
      ]);
    }
  }

  orders.push([
    orderId,
    ORG,
    BRANCH,
    status,
    'DINE_IN',
    total.toFixed(2),
    (total * 0.16).toFixed(2),
    (total * 1.16).toFixed(2),
    createdAt.toISOString(),
    createdAt.toISOString(),
    2,
  ]);

  if (closed) {
    const paidAt = new Date(createdAt.getTime() + 45 * 60 * 1000);
    payments.push([
      `bnc_pay_${index}`,
      ORG,
      BRANCH,
      orderId,
      (total * 1.16).toFixed(2),
      'CASH',
      'CONFIRMED',
      paidAt.toISOString(),
      paidAt.toISOString(),
      paidAt.toISOString(),
    ]);
  }
}

await insertMany(
  client,
  'Order',
  [
    'id',
    'organizationId',
    'branchId',
    'status',
    'channel',
    'subtotal',
    'taxTotal',
    'total',
    'createdAt',
    'updatedAt',
    'partySize',
  ],
  orders,
  400,
);

await insertMany(
  client,
  'OrderRound',
  ['id', 'orderId', 'status', 'createdAt', 'updatedAt', 'sentAt', 'startedAt', 'deliveredAt'],
  rounds,
  400,
);

await insertMany(
  client,
  'OrderItem',
  ['id', 'orderRoundId', 'productId', 'productName', 'productPrice', 'subtotal', 'quantity'],
  items,
  400,
);

await insertMany(
  client,
  'Payment',
  [
    'id',
    'organizationId',
    'branchId',
    'orderId',
    'amount',
    'method',
    'status',
    'confirmedAt',
    'paidAt',
    'updatedAt',
  ],
  payments,
  400,
);

console.log(`${MOVEMENTS} movimientos de inventario…`);
const movements = Array.from({ length: MOVEMENTS }, (_, index) => {
  const at = randomDate();
  const ingredientIndex = rand(INGREDIENTS);

  return [
    `bnc_im_${index}`,
    ORG,
    BRANCH,
    `bnc_ing_${ingredientIndex}`,
    `Insumo ${ingredientIndex + 1}`,
    'G',
    (Math.random() * 40).toFixed(4),
    'CONSUMPTION',
    at.toISOString(),
    `bnc_dedupe_${index}`,
  ];
});
await insertMany(
  client,
  'InventoryMovement',
  [
    'id',
    'organizationId',
    'branchId',
    'ingredientId',
    'ingredientName',
    'displayUnit',
    'quantity',
    'type',
    'createdAt',
    'dedupeKey',
  ],
  movements,
  400,
);

const counts = await client.query(`
  SELECT
    (SELECT count(*) FROM "Order") AS orders,
    (SELECT count(*) FROM "OrderRound") AS rounds,
    (SELECT count(*) FROM "OrderItem") AS items,
    (SELECT count(*) FROM "Payment") AS payments,
    (SELECT count(*) FROM "InventoryMovement") AS movements,
    (SELECT count(*) FROM "Product") AS products
`);

console.log('Listo:', counts.rows[0]);

await client.end();
