import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicMenuController } from './public-menu.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PublicMenuController],
})
export class PublicModule {}
