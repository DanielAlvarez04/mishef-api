import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/** Cola de extracción de tickets (pg-boss sobre Postgres, sin Redis). */
export const TICKET_EXTRACT_QUEUE = 'ticket-extract';

/**
 * Encola la extracción de tickets para el worker de Intel.
 *
 * El API solo publica trabajos; el proceso `intel-worker` es quien llama a la
 * visión. Si la cola no está disponible, `enqueue` devuelve `false` y el
 * llamador puede caer a la extracción síncrona.
 */
@Injectable()
export class TicketQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TicketQueueService.name);
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss | null> | null = null;

  async onModuleInit() {
    await this.start();
  }

  async onModuleDestroy() {
    if (!this.boss) return;

    try {
      await this.boss.stop();
    } catch (error) {
      this.logger.warn(
        `No se pudo detener pg-boss: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
    }
  }

  async enqueue(purchaseId: string, organizationId: string): Promise<boolean> {
    const boss = await this.start();

    if (!boss) return false;

    try {
      await boss.send(
        TICKET_EXTRACT_QUEUE,
        { purchaseId, organizationId },
        {
          retryLimit: 2,
          retryDelay: 30,
          retryBackoff: true,
          retryDelayMax: 300,
          expireInSeconds: 300,
          // Evita jobs duplicados si la petición se reintenta.
          singletonKey: purchaseId,
          singletonSeconds: 60,
        },
      );

      return true;
    } catch (error) {
      this.logger.warn(
        `No se pudo encolar el ticket ${purchaseId}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );

      return false;
    }
  }

  private async start(): Promise<PgBoss | null> {
    // El proceso worker crea su propia instancia para consumir la cola.
    if (process.env.INTEL_WORKER === '1') return null;

    if (this.boss) return this.boss;
    if (this.starting) return this.starting;

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      this.logger.warn('Falta DATABASE_URL; la cola de tickets no se inicia');
      return null;
    }

    this.starting = (async () => {
      const boss = new PgBoss(connectionString);
      boss.on('error', (error) => this.logger.error(error));

      await boss.start();
      await boss.createQueue(TICKET_EXTRACT_QUEUE, {
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 300,
      });

      this.boss = boss;
      this.logger.log(`Cola ${TICKET_EXTRACT_QUEUE} lista`);

      return boss;
    })()
      .catch((error) => {
        this.logger.warn(
          `No se pudo iniciar pg-boss para tickets: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );

        return null;
      })
      .finally(() => {
        this.starting = null;
      });

    return this.starting;
  }
}
