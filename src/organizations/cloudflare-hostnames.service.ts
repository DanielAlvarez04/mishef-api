import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Alta automática de dominios propios en Cloudflare for SaaS.
 *
 * Cuando un negocio verifica su dominio, Cloudflare necesita registrar ese
 * hostname como "custom hostname" para emitir el certificado y enrutarlo al
 * fallback origin. Sin esta pieza, el cliente tendría que hacerlo a mano.
 *
 * Se activa sola si existen `CF_SAAS_TOKEN` y `CF_SAAS_ZONE_ID`. Sin esas
 * variables (desarrollo) no hace nada y el flujo sigue funcionando con el DNS
 * del propio cliente.
 */
@Injectable()
export class CloudflareHostnamesService {
  private readonly logger = new Logger(CloudflareHostnamesService.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string {
    return this.config.get<string>('CF_SAAS_TOKEN')?.trim() ?? '';
  }

  private get zoneId(): string {
    return this.config.get<string>('CF_SAAS_ZONE_ID')?.trim() ?? '';
  }

  get enabled(): boolean {
    return Boolean(this.token && this.zoneId);
  }

  /** Registra el hostname y devuelve su id en Cloudflare (o `null`). */
  async create(hostname: string): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            hostname,
            ssl: { method: 'http', type: 'dv' },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        result?: { id?: string };
        errors?: Array<{ message?: string }>;
      };

      if (!response.ok || !data.success || !data.result?.id) {
        this.logger.warn(
          `Cloudflare rechazó ${hostname}: ${data.errors?.[0]?.message ?? response.status}`,
        );
        return null;
      }

      return data.result.id;
    } catch (error) {
      this.logger.error(
        `No se pudo registrar ${hostname} en Cloudflare: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Revoca el hostname (al desconectar el dominio). */
  async remove(id: string): Promise<void> {
    if (!this.enabled) return;

    try {
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames/${id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo revocar ${id} en Cloudflare: ${(error as Error).message}`,
      );
    }
  }
}
