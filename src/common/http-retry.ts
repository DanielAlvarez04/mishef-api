/** Códigos HTTP de Mercado Pago que conviene reintentar. */
export const RETRYABLE_HTTP_STATUSES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

interface RetryOptions {
  /** Número total de intentos (incluye el primero). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Inyectable para pruebas. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Ejecuta `fn` con reintentos exponenciales y jitter.
 *
 * No envuelve el error: el último fallo se propaga tal cual para que la capa
 * que llama pueda distinguir un 400 definitivo de un timeout ambiguo.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 2_000;
  const sleep = options.sleepFn ?? sleepMs;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !options.shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(max, base * 2 ** (attempt - 1));
      const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));

      options.onRetry?.(error, attempt, jittered);
      await sleep(jittered);
    }
  }

  throw lastError;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
