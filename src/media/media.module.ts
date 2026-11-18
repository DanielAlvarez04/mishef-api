import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [MediaService, JwtAuthGuard, RolesGuard],
  exports: [MediaService],
})
export class MediaModule {}
