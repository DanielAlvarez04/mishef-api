import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { DiningTablesController } from './dining-tables.controller';
import { DiningTablesService } from './dining-tables.service';

@Module({
  imports: [PrismaModule],
  controllers: [DiningTablesController],
  providers: [DiningTablesService],
  exports: [DiningTablesService],
})
export class DiningTablesModule {}
