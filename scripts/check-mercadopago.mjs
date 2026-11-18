// Diagnóstico de la integración con Mercado Pago.
//
// Uso:
//   node scripts/check-mercadopago.mjs
//
// No imprime secretos: solo indica si cada variable está configurada, valida
// la clave de cifrado y comprueba contra Mercado Pago que el access token de
// suscripciones y las credenciales de la aplicación de negocio funcionan.
//
// Requisitos:
//   - Ejecutar desde `api/` (o `/app` dentro del contenedor).
//   - Las variables MP_* en el entorno.

import { config } from 'dotenv';

config();

const MARKETPLACE_REQUIRED = [
  'MP_CLIENT_ID',
  'MP_CLIENT_SECRET',
  'MP_REDIRECT_URI',
  'MP_WEBHOOK_SECRET',
  'MP_TOKEN_ENCRYPTION_KEY',
];

const BILLING_REQUIRED = [
  'MP_BILLING_ACCESS_TOKEN',
  'MP_BILLING_WEBHOOK_SECRET',
];

const BILLING_OPTIONAL = ['MP_BILLING_BACK_URL'];

const API_BASE = 'https://api.mercadopago.com';

function value(name) {
  return (process.env[name] ?? '').trim();
}

function describe(name) {
  const raw = value(name);

  if (!raw) return { name, configured: false };

  return { name, configured: true, length: raw.length };
}

function encryptionKeyIsValid() {
  const raw = value('MP_TOKEN_ENCRYPTION_KEY');
  if (!raw) return false;

  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}

async function checkBillingToken() {
  const token = value('MP_BILLING_ACCESS_TOKEN');
  if (!token) return { checked: false, reason: 'sin access token' };

  try {
    const response = await fetch(`${API_BASE}/users/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = '';

      try {
        message = JSON.parse(body)?.message ?? '';
      } catch {
        message = body.slice(0, 120);
      }

      return {
        checked: true,
        valid: false,
        status: response.status,
        message,
      };
    }

    const user = await response.json();
    const tags = Array.isArray(user.tags) ? user.tags : [];

    return {
      checked: true,
      valid: true,
      userId: user.id,
      nickname: user.nickname,
      siteId: user.site_id,
      testMode: token.startsWith('TEST-') || tags.includes('test_user'),
    };
  } catch (error) {
    return {
      checked: true,
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Valida Client ID/Secret con `client_credentials`.
 *
 * Si Mercado Pago no soporta el grant para esta aplicación, se reporta como
 * "no verificable" en lugar de fallar: el flujo real es OAuth con un negocio.
 */
async function checkMarketplaceCredentials() {
  const clientId = value('MP_CLIENT_ID');
  const clientSecret = value('MP_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return { checked: false, reason: 'faltan client id/secret' };
  }

  try {
    const response = await fetch(`${API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return {
        checked: true,
        valid: false,
        status: response.status,
        note: 'Mercado Pago no validó el par client_id/client_secret',
      };
    }

    const data = await response.json();

    return {
      checked: true,
      valid: Boolean(data.access_token),
      userId: data.user_id,
      testMode: String(data.access_token ?? '').startsWith('TEST-'),
    };
  } catch (error) {
    return {
      checked: true,
      valid: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const marketplace = MARKETPLACE_REQUIRED.map(describe);
  const billing = [...BILLING_REQUIRED, ...BILLING_OPTIONAL].map(describe);

  const missingMarketplace = marketplace
    .filter((item) => !item.configured)
    .map((item) => item.name);
  const missingBilling = billing
    .filter((item) => BILLING_REQUIRED.includes(item.name) && !item.configured)
    .map((item) => item.name);

  const redirectUri = value('MP_REDIRECT_URI');
  const backUrl = value('MP_BILLING_BACK_URL');

  const checks = {
    marketplace,
    billing,
    missingMarketplace,
    missingBilling,
    encryptionKey: {
      configured: Boolean(value('MP_TOKEN_ENCRYPTION_KEY')),
      valid: encryptionKeyIsValid(),
    },
    redirectUri: {
      configured: Boolean(redirectUri),
      https: redirectUri.startsWith('https://'),
      pointsToCallback: redirectUri.endsWith('/v1/mercadopago/callback'),
    },
    billingBackUrl: {
      configured: Boolean(backUrl),
      https: backUrl.startsWith('https://'),
    },
    billingToken: await checkBillingToken(),
    marketplaceCredentials: await checkMarketplaceCredentials(),
  };

  const ready =
    missingMarketplace.length === 0 &&
    missingBilling.length === 0 &&
    checks.encryptionKey.valid &&
    checks.redirectUri.https &&
    checks.redirectUri.pointsToCallback &&
    (checks.billingToken.valid ?? false);

  console.log(
    JSON.stringify(
      {
        ok: ready,
        mercadoPago: checks,
      },
      null,
      2,
    ),
  );

  if (!ready) {
    process.exitCode = 1;
    console.error(
      '\nLa integración de Mercado Pago todavía no está lista para producción.',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
