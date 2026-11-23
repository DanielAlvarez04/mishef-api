import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';

import { AppModule } from './app.module';
import { IntelDigestService } from './intel/digest/intel-digest.service';
import { TicketExtractionWorker } from './purchases/ticket-extraction.worker';
import { TICKET_EXTRACT_QUEUE } from './purchases/ticket-queue.service';

/**
 * Worker de Intel.
 *
 * Es un proceso aparte del API para que los digests, la extracción de tickets
 * y los pronósticos no compitan con el POS. Usa la misma base de datos y la
 * cola vive en Postgres (`pg-boss`), sin Redis.
 *
 * El contexto de Nest se crea sin servidor HTTP para reutilizar los servicios
 * de la API (dashboard, inventario, mermas, correo) sin duplicar consultas.
 */

const envPath = [
  resolve(process.cwd(), '.env'),
  resolve(__dirname, '..', '..', '.env'),
  resolve(__dirname, '..', '.env'),
].find((candidate) => existsSync(candidate));

config(envPath ? { path: envPath } : {});

const logger = new Logger('IntelWorker');
const HEARTBEAT_QUEUE = 'intel-heartbeat';
const DIGEST_QUEUE = 'intel-digest';

async function bootstrap() {
  // El worker consume la cola; no debe abrir otra instancia de pg-boss desde
  // TicketQueueService al crear el contexto de Nest.
  process.env.INTEL_WORKER = '1';

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Falta DATABASE_URL para el worker de Intel');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const digest = app.get(IntelDigestService);
  const tickets = app.get(TicketExtractionWorker);

  const boss = new PgBoss(connectionString);
  boss.on('error', (error) => logger.error(error));

  await boss.start();
  await boss.createQueue(HEARTBEAT_QUEUE);
  await boss.createQueue(DIGEST_QUEUE);
  await boss.createQueue(TICKET_EXTRACT_QUEUE, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
  });

  await boss.work(HEARTBEAT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      logger.log(
        `Heartbeat ${job.id} recibido (${JSON.stringify(job.data ?? {})})`,
      );
    }
  });

  await boss.work(TICKET_EXTRACT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as {
        purchaseId?: string;
        organizationId?: string;
      };

      if (!data.purchaseId || !data.organizationId) {
        logger.warn(`Job ${job.id} sin purchaseId/organizationId`);
        continue;
      }

      try {
        await tickets.process(data.organizationId, data.purchaseId);
        logger.log(`Ticket ${data.purchaseId} procesado por el worker`);
      } catch (error) {
        logger.warn(
          `Ticket ${data.purchaseId} falló; pg-boss lo reintentará: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
        throw error;
      }
    }
  });

  await boss.work(DIGEST_QUEUE, async () => {
    logger.log('Generando digest diario...');
    const result = await digest.generateForAllOrganizations();
    logger.log(
      `Digest listo: ${result.organizations} organizaciones, ${result.notifications} notificaciones, ${result.emailed} correos.`,
    );
  });

  await boss.schedule(HEARTBEAT_QUEUE, '*/5 * * * *', {
    source: 'schedule',
  });
  // 07:00 hora local del servidor (America/Mexico_City en producción).
  await boss.schedule(DIGEST_QUEUE, '0 7 * * *', { source: 'schedule' });

  if (process.env.INTEL_WORKER_SELF_TEST === '1') {
    await boss.send(HEARTBEAT_QUEUE, { source: 'self-test' });
    await boss.send(DIGEST_QUEUE, { source: 'self-test' });
    logger.log('Self-test encolado');
  }

  logger.log(
    `Worker listo. Colas: ${HEARTBEAT_QUEUE}, ${DIGEST_QUEUE}, ${TICKET_EXTRACT_QUEUE}`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`Cerrando worker por ${signal}...`);
    await boss.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error(error);
  process.exit(1);
});
