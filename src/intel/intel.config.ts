/**
 * Configuración de Intel por variables de entorno.
 *
 * En Fase 0 la configuración es de plataforma. La configuración por
 * organización (`AiProviderConfig`) se activa en una fase posterior; cuando
 * exista, esta lectura queda como respaldo.
 *
 * La cadena se arma en este orden:
 *   1. proveedor principal + modelo principal;
 *   2. modelos de respaldo del mismo proveedor (`INTEL_FALLBACK_MODELS`);
 *   3. proveedor secundario (`INTEL_FALLBACK_*`), opcional.
 */
export interface IntelModelTarget {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface IntelSettings {
  targets: IntelModelTarget[];
  monthlyTokenLimit: number;
  configured: boolean;
}

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MONTHLY_TOKEN_LIMIT = 500_000;

function readKey(
  envName: string | undefined,
  inline: string | undefined,
): string | null {
  const direct = inline?.trim();
  if (direct) return direct;

  const name = envName?.trim();
  if (!name) return null;

  return process.env[name]?.trim() || null;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function readIntelSettings(): IntelSettings {
  const provider = process.env.INTEL_PROVIDER?.trim() || 'nvidia';
  const baseUrl = normalizeBaseUrl(
    process.env.INTEL_BASE_URL?.trim() || DEFAULT_BASE_URL,
  );
  const apiKey = readKey(
    process.env.INTEL_API_KEY_ENV,
    process.env.INTEL_API_KEY,
  );
  const model = process.env.INTEL_MODEL?.trim() || null;
  const fallbackModels = parseList(process.env.INTEL_FALLBACK_MODELS);

  const targets: IntelModelTarget[] = [];

  if (apiKey && model) {
    targets.push({ provider, baseUrl, apiKey, model });

    for (const fallbackModel of fallbackModels) {
      if (fallbackModel === model) continue;
      targets.push({ provider, baseUrl, apiKey, model: fallbackModel });
    }
  }

  const secondaryProvider = process.env.INTEL_FALLBACK_PROVIDER?.trim();
  const secondaryBaseUrl = process.env.INTEL_FALLBACK_BASE_URL?.trim();
  const secondaryKey = readKey(
    process.env.INTEL_FALLBACK_API_KEY_ENV,
    process.env.INTEL_FALLBACK_API_KEY,
  );
  const secondaryModel = process.env.INTEL_FALLBACK_MODEL?.trim();

  if (secondaryProvider && secondaryBaseUrl && secondaryKey && secondaryModel) {
    targets.push({
      provider: secondaryProvider,
      baseUrl: normalizeBaseUrl(secondaryBaseUrl),
      apiKey: secondaryKey,
      model: secondaryModel,
    });
  }

  const parsedLimit = Number(process.env.INTEL_MONTHLY_TOKEN_LIMIT);
  const monthlyTokenLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.floor(parsedLimit)
      : DEFAULT_MONTHLY_TOKEN_LIMIT;

  return {
    targets,
    monthlyTokenLimit,
    configured: targets.length > 0,
  };
}
