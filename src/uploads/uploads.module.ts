import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ImageJobsService } from './image-jobs.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [CatalogModule],
  controllers: [UploadsController],
  providers: [UploadsService, ImageJobsService],
  exports: [UploadsService],
})
export class UploadsModule {}
