import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { DesignController } from './design.controller';
import { DesignEditorGuard } from './design-editor.guard';
import { DesignService } from './design.service';

@Module({
  imports: [PrismaModule],
  controllers: [DesignController],
  providers: [DesignService, DesignEditorGuard, JwtAuthGuard],
})
export class DesignModule {}
