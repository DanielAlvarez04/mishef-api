import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const VERIFY_TIMEOUT_MS = 8_000;

interface VerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * Verificación anti-bots con Cloudflare Turnstile.
 *
 * Se activa sola cuando `TURNSTILE_SECRET` tiene valor. Si la variable no
 * existe (desarrollo, o un despliegue que aún no la tiene) la comprobación se
 * omite y se avisa una vez en el log: así el registro no se rompe por una
 * variable ausente.
 *
 * Si Cloudflare no responde, se deja pasar y se registra el error. Es
 * deliberado: preferimos un registro legítimo de más que dejar fuera a un
 * cliente por un fallo de red de un tercero. El rate limit por IP sigue
 * actuando como segunda barrera.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private warnedMissingSecret = false;

  constructor(private readonly config: ConfigService) {}

  private get secret(): string {
    return this.config.get<string>('TURNSTILE_SECRET')?.trim() ?? '';
  }

  get enabled(): boolean {
    return this.secret.length > 0;
  }

  async verify(token: string | undefined, remoteIp?: string): Promise<boolean> {
    if (!this.enabled) {
      if (!this.warnedMissingSecret) {
        this.warnedMissingSecret = true;
        this.logger.warn(
          'TURNSTILE_SECRET vacío: la verificación anti-bots está desactivada',
        );
      }

      return true;
    }

    if (!token || token.length > 2048) {
      return false;
    }

    try {
      const body = new URLSearchParams({
        secret: this.secret,
        response: token,
      });

      if (remoteIp) body.set('remoteip', remoteIp);

      const response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      const data = (await response.json().catch(() => ({}))) as VerifyResponse;

      if (data.success !== true) {
        this.logger.warn(
          `Turnstile rechazó el token (${(data['error-codes'] ?? []).join(', ') || 'sin detalle'})`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `No se pudo contactar a Turnstile: ${(error as Error).message}`,
      );
      return true;
    }
  }
}
