import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

/**
 * Worker de Intel.
 *
 * Es un proceso aparte del API para que los digests, la extracción de tickets
 * y los pronósticos no compitan con el POS. Usa la misma base de datos y la
 * cola vive en Postgres (`pg-boss`), sin Redis.
 *
 * En Fase 0 solo corre un heartbeat y un self-test opcional. Las colas reales
 * (`intel-digest`, `intel-ticket`, `intel-forecast`) se registran en las
 * siguientes fases.
 */

const envPath = [
  resolve(process.cwd(), '.env'),
  resolve(__dirname, '..', '..', '.env'),
  resolve(__dirname, '..', '.env'),
].find((candidate) => existsSync(candidate));

config(envPath ? { path: envPath } : {});

const logger = new Logger('IntelWorker');
const HEARTBEAT_QUEUE = 'intel-heartbeat';

async function bootstrap() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Falta DATABASE_URL para el worker de Intel');
  }

  const boss = new PgBoss(connectionString);
  boss.on('error', (error) => logger.error(error));

  await boss.start();
  await boss.createQueue(HEARTBEAT_QUEUE);

  await boss.work(HEARTBEAT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      logger.log(
        `Heartbeat ${job.id} recibido (${JSON.stringify(job.data ?? {})})`,
      );
    }
  });

  await boss.schedule(HEARTBEAT_QUEUE, '*/5 * * * *', {
    source: 'schedule',
  });

  if (process.env.INTEL_WORKER_SELF_TEST === '1') {
    await boss.send(HEARTBEAT_QUEUE, { source: 'self-test' });
    logger.log('Self-test encolado');
  }

  logger.log(`Worker listo. Cola: ${HEARTBEAT_QUEUE}`);

  const shutdown = async (signal: string) => {
    logger.log(`Cerrando worker por ${signal}...`);
    await boss.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error(error);
  process.exit(1);
});
