/**
 * Configuración de Intel por variables de entorno.
 *
 * En Fase 0 la configuración es de plataforma. La configuración por
 * organización (`AiProviderConfig`) se activa en una fase posterior; cuando
 * exista, esta lectura queda como respaldo.
 */
export interface IntelSettings {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string | null;
  fastModel: string | null;
  visionModel: string | null;
  monthlyTokenLimit: number;
  configured: boolean;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MONTHLY_TOKEN_LIMIT = 500_000;

export function readIntelSettings(): IntelSettings {
  const baseUrl = (
    process.env.INTEL_BASE_URL?.trim() || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const apiKey = process.env.INTEL_API_KEY?.trim() || null;
  const model = process.env.INTEL_MODEL?.trim() || null;
  const fastModel = process.env.INTEL_FAST_MODEL?.trim() || null;
  const visionModel = process.env.INTEL_VISION_MODEL?.trim() || null;
  const provider = process.env.INTEL_PROVIDER?.trim() || 'openrouter';

  const parsedLimit = Number(process.env.INTEL_MONTHLY_TOKEN_LIMIT);
  const monthlyTokenLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.floor(parsedLimit)
      : DEFAULT_MONTHLY_TOKEN_LIMIT;

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    fastModel,
    visionModel,
    monthlyTokenLimit,
    configured: Boolean(apiKey && model),
  };
}
