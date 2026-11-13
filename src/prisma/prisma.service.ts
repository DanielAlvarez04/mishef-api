import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // El pool se comparte entre todas las peticiones del proceso. Con un
    // contenedor y 2 vCPU, 10 conexiones sobran; el límite real es la CPU de
    // Postgres. `idleTimeoutMillis` libera conexiones ociosas en lugar de
    // mantenerlas abiertas contra `max_connections`.
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
