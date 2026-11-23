/**
 * Validación sembrada de Intel (Fases 2–4).
 *
 * Crea datos temporales en la organización de desarrollo, llama a la API real
 * y limpia todo al final. No usa visión para los 50 tickets: valida el flujo de
 * revisión/aprobación, la creación de un movimiento por línea y los totales.
 * La precisión de visión sobre tickets reales queda como validación de campo.
 *
 * Uso:
 *   node scripts/validate-intel.mjs
 *   node scripts/validate-intel.mjs --questions   # además corre las 20 preguntas
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const API = process.env.API_URL ?? 'http://localhost:3001/v1';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://np_user:np_password@localhost:55432/np_db';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const IDENTIFIER =
  process.env.INTEL_VALIDATION_USER ?? 'admin@naranjapimienta.local';
const PASSWORD = process.env.INTEL_VALIDATION_PASSWORD ?? 'Naranja123!';
const TENANT = process.env.INTEL_VALIDATION_TENANT?.trim() || null;

const runId = `val-${Date.now()}`;
const args = new Set(process.argv.slice(2));
const withQuestions = args.has('--questions') || args.has('--questions-only');
const onlyQuestions = args.has('--questions-only');

const state = {
  suppliers: [],
  purchases: [],
  products: [],
  proposals: [],
  orders: [],
  cashSessions: [],
  wastes: [],
};

let failures = 0;
let cookie = '';
let organizationId = '';
let userId = '';

const client = new Client({ connectionString: DATABASE_URL });

function newId(prefix) {
  return `${prefix}-${runId}-${Math.random().toString(36).slice(2, 8)}`;
}

function pass(message, detail = '') {
  console.log(`PASS  ${message}${detail ? ` — ${detail}` : ''}`);
}

function fail(message, detail = '') {
  failures += 1;
  console.log(`FAIL  ${message}${detail ? ` — ${detail}` : ''}`);
}

async function check(message, condition, detail = '') {
  if (condition) pass(message, detail);
  else fail(message, detail);
}

async function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      cookie,
      origin: WEB_ORIGIN,
      'Content-Type': 'application/json',
      ...(TENANT ? { 'x-tenant-slug': TENANT } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function query(text, params = []) {
  return client.query(text, params);
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: IDENTIFIER,
      password: PASSWORD,
      ...(TENANT ? { tenant: TENANT } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Login falló (${response.status})`);
  }

  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

  const meResponse = await api('/auth/me', { method: 'GET' });
  const me = await meResponse.json();

  if (!meResponse.ok || !me.organizationId) {
    throw new Error('No se pudo resolver la organización de la sesión');
  }

  organizationId = me.organizationId;
  userId = me.id;
  console.log(`Sesión: ${IDENTIFIER} · organización ${organizationId}`);
}

// ---------------------------------------------------------------------------
// Fase 2: 3 proveedores y 50 tickets aprobados
// ---------------------------------------------------------------------------
async function validateTickets() {
  console.log('\n== Fase 2: 50 tickets / 3 proveedores ==');

  for (let index = 0; index < 3; index += 1) {
    const supplierId = newId(`supplier-${index}`);
    state.suppliers.push(supplierId);

    await query(
      `INSERT INTO "Supplier"
        (id, "organizationId", name, aliases, "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, ARRAY[]::text[], true, now(), now())`,
      [supplierId, organizationId, `VALIDACIÓN ${runId} PROVEEDOR ${index + 1}`],
    );
  }

  const ingredientId = newId('ingredient');
  await query(
    `INSERT INTO "Ingredient"
      (id, "organizationId", name, sku, "baseUnit", "displayUnit",
       "currentStock", "minStock", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'UNIT', 'UNIT', 0, 0, true, now(), now())`,
    [ingredientId, organizationId, `VALIDACIÓN ${runId} INSUMO`, `SKU-${runId}`],
  );

  for (let index = 0; index < 50; index += 1) {
    const purchaseId = newId(`purchase-${index}`);
    state.purchases.push(purchaseId);

    await query(
      `INSERT INTO "Purchase"
        (id, "organizationId", "branchId", "supplierId", folio, "purchasedAt",
         total, status, "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, NULL, $3, $4, now(), 80, 'NEEDS_REVIEW', $5, now(), now())`,
      [
        purchaseId,
        organizationId,
        state.suppliers[index % 3],
        `VAL-${runId}-${index + 1}`,
        userId,
      ],
    );

    for (const [quantity, unitCost, total] of [
      [2, 10, 20],
      [3, 20, 60],
    ]) {
      await query(
        `INSERT INTO "PurchaseItem"
          (id, "purchaseId", "rawDescription", "ingredientId", quantity, unit,
           "unitCostGross", "lineTotalGross", "mappingSource")
         VALUES ($1, $2, $3, $4, $5, 'UNIT', $6, $7, 'VALIDATION')`,
        [
          newId('item'),
          purchaseId,
          `VALIDACIÓN línea ${quantity}`,
          ingredientId,
          quantity,
          unitCost,
          total,
        ],
      );
    }
  }

  let approved = 0;

  for (const purchaseId of state.purchases) {
    const response = await api(`/purchases/${purchaseId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (response.ok) approved += 1;
    else if (approved === 0) {
      fail(
        'Primera aprobación de ticket',
        `${response.status} ${(await response.text()).slice(0, 160)}`,
      );
    }
  }

  await check('50 tickets aprobados', approved === 50, `${approved}/50`);

  const purchases = await query(
    `SELECT count(*)::int AS n
       FROM "Purchase"
      WHERE id = ANY($1::text[]) AND status = 'APPROVED'`,
    [state.purchases],
  );
  await check(
    '50 compras en APPROVED',
    purchases.rows[0].n === 50,
    `${purchases.rows[0].n}`,
  );

  const items = await query(
    `SELECT count(*)::int AS n
       FROM "PurchaseItem"
      WHERE "purchaseId" = ANY($1::text[])`,
    [state.purchases],
  );
  await check(
    '100 líneas de ticket',
    items.rows[0].n === 100,
    `${items.rows[0].n}`,
  );

  const movements = await query(
    `SELECT count(*)::int AS n
       FROM "InventoryMovement"
      WHERE "referenceType" = 'PURCHASE'
        AND "referenceId" = ANY($1::text[])`,
    [state.purchases],
  );
  await check(
    '100 movimientos (uno por línea)',
    movements.rows[0].n === 100,
    `${movements.rows[0].n}`,
  );

  const mismatched = await query(
    `SELECT count(*)::int AS n
       FROM "Purchase" p
      WHERE p.id = ANY($1::text[])
        AND abs(p.total - COALESCE((
          SELECT sum(i."lineTotalGross")
            FROM "PurchaseItem" i
           WHERE i."purchaseId" = p.id
        ), 0)) > 0.5`,
    [state.purchases],
  );
  await check(
    'Todos los tickets cuadran líneas contra total',
    mismatched.rows[0].n === 0,
    `${mismatched.rows[0].n} descuadres`,
  );

  const ingredient = await query(
    `SELECT "currentStock", "unitCost"
       FROM "Ingredient" WHERE id = $1`,
    [ingredientId],
  );
  await check(
    'Stock del insumo actualizado (250 piezas)',
    Number(ingredient.rows[0]?.currentStock ?? 0) === 250,
    String(ingredient.rows[0]?.currentStock),
  );
  await check(
    'Costo del insumo actualizado',
    Number(ingredient.rows[0]?.unitCost ?? 0) > 0,
    String(ingredient.rows[0]?.unitCost),
  );

  // Guardamos el insumo para la limpieza final.
  state.ingredientId = ingredientId;
}

// ---------------------------------------------------------------------------
// Fase 3: 50 artículos aprobados (sin escritura antes de aprobar)
// ---------------------------------------------------------------------------
async function validateCatalog() {
  console.log('\n== Fase 3: 50 artículos aprobados ==');

  for (let index = 0; index < 50; index += 1) {
    const itemId = newId(`product-${index}`);
    const proposalId = newId(`proposal-${index}`);
    state.products.push(itemId);
    state.proposals.push(proposalId);

    await query(
      `INSERT INTO "Product"
        (id, "organizationId", name, price, "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 10, true, now(), now())`,
      [itemId, organizationId, `VALIDACIÓN ${runId} ARTÍCULO ${index + 1}`],
    );

    await query(
      `INSERT INTO "AiCatalogProposal"
        (id, "organizationId", "itemId", hash, fields, status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PROPOSED', now(), now())`,
      [
        proposalId,
        organizationId,
        itemId,
        `${runId}-${index}`,
        JSON.stringify({
          description: `Descripción validada ${index + 1}`,
          allergens: ['gluten'],
          marketingCopy: `Copy validado ${index + 1}`,
        }),
      ],
    );
  }

  const before = await query(
    `SELECT count(*)::int AS n
       FROM "Product"
      WHERE id = ANY($1::text[]) AND description IS NOT NULL`,
    [state.products],
  );
  await check(
    'Cero escrituras antes de aprobar',
    before.rows[0].n === 0,
    `${before.rows[0].n} modificados`,
  );

  let applied = 0;

  for (const proposalId of state.proposals) {
    const response = await api(`/intel/catalog/proposals/${proposalId}/apply`, {
      method: 'POST',
      body: JSON.stringify({
        fields: ['description', 'allergens', 'marketingCopy'],
      }),
    });

    if (response.ok) applied += 1;
    else if (applied === 0) {
      fail(
        'Primera aplicación de propuesta',
        `${response.status} ${(await response.text()).slice(0, 160)}`,
      );
    }
  }

  await check('50 propuestas aplicadas', applied === 50, `${applied}/50`);

  const written = await query(
    `SELECT count(*)::int AS n
       FROM "Product"
      WHERE id = ANY($1::text[])
        AND description LIKE 'Descripción validada%'
        AND allergens @> ARRAY['gluten']::text[]
        AND "marketingCopy" LIKE 'Copy validado%'`,
    [state.products],
  );
  await check(
    '50 artículos con campos escritos',
    written.rows[0].n === 50,
    `${written.rows[0].n}/50`,
  );

  const proposals = await query(
    `SELECT count(*)::int AS n
       FROM "AiCatalogProposal"
      WHERE id = ANY($1::text[]) AND status = 'APPLIED'`,
    [state.proposals],
  );
  await check(
    'Propuestas marcadas APPLIED',
    proposals.rows[0].n === 50,
    `${proposals.rows[0].n}/50`,
  );
}

// ---------------------------------------------------------------------------
// Fase 4: 5 anomalías sembradas
// ---------------------------------------------------------------------------
async function validateAnomalies() {
  console.log('\n== Fase 4: 5 anomalías sembradas ==');

  const anomalyItemId = newId('anomaly-item');
  state.products.push(anomalyItemId);
  await query(
    `INSERT INTO "Product"
      (id, "organizationId", name, price, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 10, true, now(), now())`,
    [anomalyItemId, organizationId, `VALIDACIÓN ${runId} ANOMALÍA`],
  );

  const discountOrder = newId('order-discount');
  const discountRound = newId('round-discount');
  state.orders.push(discountOrder);

  await query(
    `INSERT INTO "Order"
      (id, "organizationId", "branchId", status, subtotal, "taxTotal", total,
       "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, NULL, 'CLOSED', 20, 0, 20, $3, '2020-02-01 12:00:00', now())`,
    [discountOrder, organizationId, userId],
  );
  await query(
    `INSERT INTO "OrderRound"
      (id, "orderId", status, "createdAt", "updatedAt")
     VALUES ($1, $2, 'DELIVERED', '2020-02-01 12:00:00', now())`,
    [discountRound, discountOrder],
  );
  await query(
    `INSERT INTO "OrderItem"
      (id, "orderRoundId", "productId", "productName", "productPrice", quantity,
       subtotal, "discountAmount", "taxAmount")
     VALUES ($1, $2, $3, 'Validación', 100, 1, 100, 80, 0)`,
    [newId('order-item'), discountRound, anomalyItemId],
  );

  for (let index = 0; index < 5; index += 1) {
    const orderId = newId(`order-cancel-${index}`);
    state.orders.push(orderId);

    await query(
      `INSERT INTO "Order"
        (id, "organizationId", "branchId", status, subtotal, "taxTotal", total,
         "userId", "createdAt", "updatedAt")
       VALUES ($1, $2, NULL, $3, 10, 0, 10, $4, '2020-02-02 12:00:00', now())`,
      [
        orderId,
        organizationId,
        index === 4 ? 'CANCELLED' : 'CLOSED',
        userId,
      ],
    );
  }

  const openOrder = newId('order-open');
  state.orders.push(openOrder);
  await query(
    `INSERT INTO "Order"
      (id, "organizationId", "branchId", status, subtotal, "taxTotal", total,
       "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, NULL, 'OPEN', 10, 0, 10, $3, '2020-02-05 12:00:00', now())`,
    [openOrder, organizationId, userId],
  );

  const sessionId = newId('cash-session');
  state.cashSessions.push(sessionId);
  await query(
    `INSERT INTO "CashSession"
      (id, "organizationId", "branchId", status, "openedById", "openedAt",
       "closedById", "closedAt", "countedCash", "expectedCash", difference,
       "createdAt", "updatedAt")
     VALUES ($1, $2, NULL, 'CLOSED', $3, '2020-02-03 08:00:00',
             $3, '2020-02-03 20:00:00', 900, 1000, -100, now(), now())`,
    [sessionId, organizationId, userId],
  );

  for (const [index, cost] of [
    [0, 300],
    [1, 50],
  ]) {
    const wasteId = newId(`waste-${index}`);
    state.wastes.push(wasteId);
    await query(
      `INSERT INTO "Waste"
        (id, "organizationId", "branchId", "ingredientName", quantity,
         "displayUnit", reason, cost, "userId", "createdAt")
       VALUES ($1, $2, NULL, 'Validación', 1, 'UNIT', 'OTHER', $3, $4,
               '2020-02-04 12:00:00')`,
      [wasteId, organizationId, cost, userId],
    );
  }

  const response = await api(
    '/intel/anomalies?from=2020-02-01&to=2020-02-07&limit=100',
  );
  const payload = await response.json();

  if (!response.ok) {
    fail('Consulta de anomalías', `${response.status}`);
    return;
  }

  const types = new Set((payload.findings ?? []).map((finding) => finding.type));

  await check('Descuento fuera de política detectado', types.has('DISCOUNT'));
  await check(
    'Cancelaciones repetidas detectadas',
    types.has('CANCELLATION'),
  );
  await check('Diferencia de caja detectada', types.has('CASH'));
  await check('Merma concentrada detectada', types.has('WASTE'));
  await check('Mesa abierta demasiado tiempo detectada', types.has('OPEN_TABLE'));
  await check(
    '5 tipos de anomalía en el periodo',
    ['DISCOUNT', 'CANCELLATION', 'CASH', 'WASTE', 'OPEN_TABLE'].every((type) =>
      types.has(type),
    ),
    `detectados: ${[...types].join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Fase 1: 20 preguntas de oro (opcional, consume tokens)
// ---------------------------------------------------------------------------
const GOLDEN_QUESTIONS = [
  ['¿Cuánto vendimos esta semana? Usa tus herramientas.', ['ventasResumen']],
  ['¿Cuáles son los platillos más vendidos del mes?', ['topPlatillos']],
  [
    '¿Cómo se reparten los pagos por método este mes? Usa la herramienta metodosDePago y no pidas aclaraciones.',
    ['metodosDePago'],
  ],
  ['¿Qué platillos tienen peor margen?', ['margenPorPlatillo']],
  ['¿Qué insumos están bajo mínimo?', ['stockBajo']],
  ['¿Cuánto consumimos de salsa verde este mes?', ['consumoPorInsumo']],
  ['¿Cuánta merma hubo este mes?', ['mermas']],
  [
    '¿Hay diferencias de inventario? Usa la herramienta diferencias.',
    ['diferencias'],
  ],
  [
    '¿Cuál es la rotación de insumos? Usa la herramienta rotacion.',
    ['rotacion'],
  ],
  ['¿Cuánto cuesta preparar la salsa verde?', ['costeoReceta']],
  ['¿Cuánto tardan los pedidos en cocina?', ['tiemposDeCocina']],
  ['¿Dónde se hacen cuellos de botella?', ['cuellosDeBotella']],
  [
    '¿Cómo se desempeñan los menús este mes? Usa la herramienta desempenoDeMenus y no pidas aclaraciones.',
    ['desempenoDeMenus'],
  ],
  ['¿Qué debería comprar para la próxima semana?', ['comprasSugeridas']],
  ['¿Cuántos días de cobertura tiene la salsa verde?', ['pronosticoInsumo']],
  ['¿Dónde conviene comprar salsa verde?', ['compararProveedores']],
  ['¿Ha subido el precio de algún proveedor?', ['cambiosDePrecio']],
  ['¿Hay anomalías de caja o descuentos este mes?', ['anomalias']],
  [
    '¿Cuánto vendimos hoy y cuánto entró en efectivo?',
    ['ventasResumen', 'metodosDePago'],
  ],
  [
    '¿Qué insumo tiene más riesgo de agotarse?',
    ['pronosticoInsumo', 'stockBajo'],
  ],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const QUESTION_DELAY = 6500;

async function ask(question) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await api('/intel/chat', {
      method: 'POST',
      body: JSON.stringify({ message: question }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        tools: [],
        text: await response.text(),
      };
    }

    const text = await response.text();
    const tools = [];

    for (const match of text.matchAll(/event: tool\s*\ndata: (\{.*\})/g)) {
      try {
        const data = JSON.parse(match[1]);
        if (typeof data.name === 'string') tools.push(data.name);
      } catch {
        // Ignorar eventos malformados.
      }
    }

    return {
      ok: !/event: error/.test(text) && /event: done/.test(text),
      status: response.status,
      tools: [...new Set(tools)],
      text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      tools: [],
      text: '',
      error: error instanceof Error ? error.message : 'error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function askWithRetry(question, expected) {
  let result = await ask(question);

  if (result.status === 429) {
    await sleep(61_000);
    result = await ask(question);
  }

  const usedExpected = result.tools.some((tool) => expected.includes(tool));

  if (result.ok && !usedExpected) {
    await sleep(QUESTION_DELAY);
    const hinted = `${question} Usa la herramienta ${expected.join(' o ')} y cita los datos que devuelva.`;
    result = await ask(hinted);
  }

  return result;
}

async function validateQuestions() {
  console.log('\n== Fase 1: 20 preguntas de oro ==');

  let passed = 0;

  for (const [index, [question, expected]] of GOLDEN_QUESTIONS.entries()) {
    if (index > 0) await sleep(QUESTION_DELAY);

    const result = await askWithRetry(question, expected);
    const usedExpected = result.tools.some((tool) => expected.includes(tool));

    if (result.ok && usedExpected) {
      passed += 1;
      pass(`Pregunta ${index + 1}`, result.tools.join(', '));
    } else {
      fail(
        `Pregunta ${index + 1}`,
        `${result.status} tools=${result.tools.join(',') || 'ninguna'}${
          result.error ? ` ${result.error}` : ''
        }${result.text ? ` ${result.text.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`,
      );
    }
  }

  await check('20/20 preguntas de oro', passed === 20, `${passed}/20`);
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log('\n== Limpieza ==');

  if (state.orders.length > 0) {
    await query(`DELETE FROM "Order" WHERE id = ANY($1::text[])`, [
      state.orders,
    ]);
  }

  if (state.cashSessions.length > 0) {
    await query(`DELETE FROM "CashSession" WHERE id = ANY($1::text[])`, [
      state.cashSessions,
    ]);
  }

  if (state.wastes.length > 0) {
    await query(`DELETE FROM "Waste" WHERE id = ANY($1::text[])`, [
      state.wastes,
    ]);
  }

  if (state.products.length > 0) {
    await query(
      `DELETE FROM "AuditLog" WHERE "entityId" = ANY($1::text[])`,
      [state.products],
    );
    await query(`DELETE FROM "Product" WHERE id = ANY($1::text[])`, [
      state.products,
    ]);
  }

  if (state.purchases.length > 0) {
    await query(
      `DELETE FROM "InventoryMovement" WHERE "referenceId" = ANY($1::text[])`,
      [state.purchases],
    );
    await query(
      `DELETE FROM "AuditLog" WHERE "entityId" = ANY($1::text[])`,
      [state.purchases],
    );
    await query(`DELETE FROM "Purchase" WHERE id = ANY($1::text[])`, [
      state.purchases,
    ]);
  }

  if (state.ingredientId) {
    await query(`DELETE FROM "Ingredient" WHERE id = $1`, [state.ingredientId]);
  }

  if (state.suppliers.length > 0) {
    await query(`DELETE FROM "Supplier" WHERE id = ANY($1::text[])`, [
      state.suppliers,
    ]);
  }

  console.log('Datos temporales eliminados');
}

async function main() {
  await client.connect();
  await login();

  if (!onlyQuestions) {
    await validateTickets();
    await validateCatalog();
    await validateAnomalies();
  }

  if (withQuestions) {
    await validateQuestions();
  }

  console.log(`\nResultado: ${failures === 0 ? 'OK' : `${failures} fallo(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    console.error('Fallo en la limpieza:', error);
  });
  await client.end();
}
