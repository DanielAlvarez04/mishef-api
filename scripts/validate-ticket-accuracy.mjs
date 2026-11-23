/**
 * Arnés de accuracy para tickets reales.
 *
 * Coloca las fotos y un `expected.json` en `validation/tickets/` y ejecuta:
 *   node scripts/validate-ticket-accuracy.mjs
 *
 * Requiere el API y el worker de Intel corriendo. Cada ticket se sube por el
 * flujo real (presign → R2 → createTicket → worker) y se compara contra el
 * manifiesto. No aprueba compras ni toca inventario.
 *
 * Para comprobar el arnés sin dataset real:
 *   node scripts/validate-ticket-accuracy.mjs --self-test
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import sharp from 'sharp';

const { Client } = pg;

const API = process.env.API_URL ?? 'http://localhost:3001/v1';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://np_user:np_password@localhost:55432/np_db';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const DATASET =
  process.env.INTEL_TICKET_DATASET ??
  join(process.cwd(), 'validation', 'tickets');
const IDENTIFIER =
  process.env.INTEL_VALIDATION_USER ?? 'admin@naranjapimienta.local';
const PASSWORD = process.env.INTEL_VALIDATION_PASSWORD ?? 'Naranja123!';

const args = new Set(process.argv.slice(2));
const selfTest = args.has('--self-test');
const keep = args.has('--keep');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const r2 = new S3Client({
  region: 'auto',
  endpoint:
    process.env.R2_ENDPOINT ??
    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

const db = new Client({ connectionString: DATABASE_URL });
let cookie = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function textMatches(expected, actual) {
  const left = normalize(expected);
  const right = normalize(actual);

  if (!left || !right) return false;
  if (right.includes(left) || left.includes(right)) return true;

  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  const union = new Set([...leftTokens, ...rightTokens]).size;

  return union > 0 && intersection.length / union >= 0.6;
}

function money(value) {
  return Number(value ?? 0).toFixed(2);
}

async function api(path, options = {}) {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      cookie,
      origin: WEB_ORIGIN,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function login() {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
  });

  if (!response.ok) throw new Error(`Login falló (${response.status})`);

  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

  const me = await (await api('/auth/me')).json();
  if (!me.organizationId) throw new Error('Sesión sin organización');

  return me.organizationId;
}

async function uploadAndCreate(fileBuffer, fileName, mimeType) {
  const presignResponse = await api('/purchases/tickets/presign', {
    method: 'POST',
    body: JSON.stringify({ contentType: mimeType, size: fileBuffer.length }),
  });
  const presign = await presignResponse.json();

  if (!presignResponse.ok || !presign.uploadUrl) {
    throw new Error(`Presign falló (${presignResponse.status})`);
  }

  const upload = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: fileBuffer,
  });

  if (!upload.ok) throw new Error(`Subida a R2 falló (${upload.status})`);

  const created = await api('/purchases/tickets', {
    method: 'POST',
    body: JSON.stringify({
      documentKey: presign.key,
      documentMime: mimeType,
    }),
  });
  const purchase = await created.json();

  if (!created.ok || !purchase.id) {
    throw new Error(
      `No se pudo crear la compra (${created.status}): ${JSON.stringify(purchase).slice(0, 160)}`,
    );
  }

  return { purchaseId: purchase.id, key: presign.key };
}

async function waitForExtraction(purchaseId) {
  const started = Date.now();

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(2000);
    const response = await api(`/purchases/${purchaseId}`);
    const purchase = await response.json();

    if (!response.ok) continue;
    if (purchase.status !== 'PROCESSING') {
      return {
        purchase,
        durationMs: Date.now() - started,
      };
    }
  }

  throw new Error(
    'El ticket siguió en PROCESSING. ¿Está corriendo el worker (`npm run intel:worker:dev`)?',
  );
}

async function cleanup(purchaseId, key) {
  if (keep) {
    console.log(
      `  Conservado: compra ${purchaseId}, R2 ${key} (--keep)`,
    );
    return;
  }

  await db.query(`DELETE FROM "AiDocument" WHERE "purchaseId" = $1`, [
    purchaseId,
  ]);
  await db.query(`DELETE FROM "AuditLog" WHERE "entityId" = $1`, [
    purchaseId,
  ]);
  await db.query(`DELETE FROM "Purchase" WHERE id = $1`, [purchaseId]);

  if (key && process.env.R2_ACCESS_KEY_ID) {
    await r2
      .send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET ?? 'mishef-public',
          Key: key,
        }),
      )
      .catch(() => undefined);
  }
}

function compareTicket(expected, purchase) {
  const extractedLines = purchase.items ?? [];
  const expectedLines = expected.lines ?? [];
  const used = new Set();

  let matchedLines = 0;

  for (const line of expectedLines) {
    const index = extractedLines.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;

      const descriptionOk = textMatches(
        line.description,
        candidate.rawDescription,
      );
      const quantityOk =
        line.quantity === undefined ||
        Math.abs(Number(candidate.quantity) - Number(line.quantity)) <= 0.01;
      const totalOk =
        line.lineTotal === undefined ||
        Math.abs(
          Number(candidate.lineTotalGross) - Number(line.lineTotal),
        ) <= 1;

      return descriptionOk && quantityOk && totalOk;
    });

    if (index >= 0) {
      used.add(index);
      matchedLines += 1;
    }
  }

  const supplierOk =
    Boolean(expected.supplier) &&
    Boolean(purchase.supplier?.name) &&
    textMatches(expected.supplier, purchase.supplier.name);

  const dateOk =
    Boolean(expected.date) &&
    purchase.purchasedAt?.slice(0, 10) === expected.date;

  const totalOk =
    expected.total === undefined ||
    Math.abs(Number(purchase.total) - Number(expected.total)) <= 1;

  return {
    supplierOk,
    dateOk,
    totalOk,
    headerOk: supplierOk && dateOk && totalOk,
    matchedLines,
    expectedLines: expectedLines.length,
    extractedLines: extractedLines.length,
    lineRecall:
      expectedLines.length > 0 ? matchedLines / expectedLines.length : 0,
    linePrecision:
      extractedLines.length > 0 ? matchedLines / extractedLines.length : 0,
  };
}

async function buildSelfTestDataset() {
  const directory = join(tmpdir(), `intel-ticket-selftest-${Date.now()}`);
  await mkdir(directory, { recursive: true });

  const folio = `F-${Date.now()}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900">
  <rect width="100%" height="100%" fill="white"/>
  <g font-family="Courier New, monospace" font-size="24" fill="black">
    <text x="45" y="80">WALMART SUPERCENTER</text>
    <text x="45" y="120">FOLIO ${folio}</text>
    <text x="45" y="160">FECHA 2026-11-23</text>
    <text x="45" y="240">SALSA VERDE 1 L</text>
    <text x="45" y="275">1 x 35.00            35.00</text>
    <text x="45" y="500">TOTAL                35.00</text>
  </g>
</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(join(directory, 'ticket-selftest.png'), png);
  await writeFile(
    join(directory, 'expected.json'),
    JSON.stringify(
      [
        {
          file: 'ticket-selftest.png',
          supplier: 'Walmart',
          date: '2026-11-23',
          total: 35,
          lines: [
            {
              description: 'SALSA VERDE 1 L',
              quantity: 1,
              lineTotal: 35,
            },
          ],
        },
      ],
      null,
      2,
    ),
  );

  return directory;
}

async function main() {
  await db.connect();
  await login();

  let dataset = DATASET;

  if (selfTest) {
    dataset = await buildSelfTestDataset();
    console.log(`Self-test: ${dataset}`);
  }

  const manifestPath = join(dataset, 'expected.json');

  if (!existsSync(manifestPath)) {
    console.log(
      `No hay dataset en ${dataset}. Crea expected.json con las fotos y vuelve a ejecutar.\n` +
        'Formato: https://github.com/…/validation/tickets/README.md',
    );
    process.exitCode = 2;
    return;
  }

  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  const tickets = (limit ? expected.slice(0, limit) : expected).filter(
    (entry) => entry.file,
  );

  if (tickets.length === 0) {
    console.log('El manifiesto no tiene tickets.');
    process.exitCode = 2;
    return;
  }

  const results = [];
  let headerOk = 0;
  let expectedLines = 0;
  let matchedLines = 0;
  let extractedLines = 0;

  console.log(
    `\nTickets: ${tickets.length}${selfTest ? ' (self-test sintético)' : ''}\n`,
  );

  for (const [index, entry] of tickets.entries()) {
    const filePath = join(dataset, entry.file);
    const mimeType = CONTENT_TYPES[extname(entry.file).toLowerCase()];

    if (!mimeType || !existsSync(filePath)) {
      console.log(`SKIP  ${entry.file} (archivo o formato no válido)`);
      continue;
    }

    const buffer = await readFile(filePath);
    let purchaseId = null;
    let key = null;

    try {
      const created = await uploadAndCreate(buffer, entry.file, mimeType);
      purchaseId = created.purchaseId;
      key = created.key;

      const { purchase, durationMs } = await waitForExtraction(purchaseId);
      const comparison = compareTicket(entry, purchase);

      results.push({ entry, purchase, comparison, durationMs });
      headerOk += comparison.headerOk ? 1 : 0;
      expectedLines += comparison.expectedLines;
      matchedLines += comparison.matchedLines;
      extractedLines += comparison.extractedLines;

      console.log(
        `${String(index + 1).padStart(2, '0')}. ${entry.file}  ` +
          `status=${purchase.status}  ` +
          `proveedor=${comparison.supplierOk ? 'OK' : 'X'}  ` +
          `fecha=${comparison.dateOk ? 'OK' : 'X'}  ` +
          `total=${comparison.totalOk ? 'OK' : 'X'} (${money(purchase.total)})  ` +
          `líneas=${comparison.matchedLines}/${comparison.expectedLines}  ` +
          `${(durationMs / 1000).toFixed(1)}s`,
      );
    } catch (error) {
      results.push({
        entry,
        comparison: {
          headerOk: false,
          supplierOk: false,
          dateOk: false,
          totalOk: false,
          matchedLines: 0,
          expectedLines: entry.lines?.length ?? 0,
          extractedLines: 0,
          lineRecall: 0,
          linePrecision: 0,
        },
        durationMs: 0,
        error: error instanceof Error ? error.message : 'error',
      });
      expectedLines += entry.lines?.length ?? 0;

      console.log(`FAIL  ${entry.file}: ${error instanceof Error ? error.message : error}`);
    } finally {
      if (purchaseId) await cleanup(purchaseId, key);
    }
  }

  const completed = results.length;
  const headerAccuracy = completed > 0 ? headerOk / completed : 0;
  const lineRecall = expectedLines > 0 ? matchedLines / expectedLines : 0;
  const linePrecision =
    extractedLines > 0 ? matchedLines / extractedLines : 0;
  const durations = results
    .map((row) => row.durationMs)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const p95 =
    durations.length > 0
      ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]
      : 0;

  console.log('\n== Resultado ==');
  console.log(
    `Proveedor/fecha/total: ${(headerAccuracy * 100).toFixed(1)}% (${headerOk}/${completed}) [objetivo ≥95%]`,
  );
  console.log(
    `Líneas (recall): ${(lineRecall * 100).toFixed(1)}% (${matchedLines}/${expectedLines}) [objetivo ≥85%]`,
  );
  console.log(
    `Líneas (precision): ${(linePrecision * 100).toFixed(1)}% (${matchedLines}/${extractedLines})`,
  );
  console.log(`p95: ${(p95 / 1000).toFixed(1)}s [objetivo <60s]`);

  const sampleOk = selfTest || completed >= 50;
  const accuracyOk = headerAccuracy >= 0.95 && lineRecall >= 0.85;
  const latencyOk = p95 < 60_000;

  if (!sampleOk) {
    console.log(
      `\nMuestra insuficiente: ${completed}/50 tickets reales. El arnés está listo; falta el dataset.`,
    );
  }

  process.exitCode =
    sampleOk && accuracyOk && latencyOk ? 0 : selfTest ? 0 : 1;

  if (selfTest) {
    console.log(
      '\nSelf-test del arnés: la extracción pasó por el worker y se comparó contra el manifiesto.',
    );
    await rm(dataset, { recursive: true, force: true }).catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}
