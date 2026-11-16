import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageService } from './storage.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
