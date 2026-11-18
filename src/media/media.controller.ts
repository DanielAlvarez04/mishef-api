import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  FinalizeMediaDto,
  MediaEntityDto,
  PresignMediaDto,
} from './dto/media.dto';
import { MediaService } from './media.service';

@ApiTags('media')
@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @ApiOperation({ summary: 'Galería de una entidad' })
  @RequirePermissions('catalog:manage')
  @Get()
  list(@CurrentUser() user: JwtUser, @Query() dto: MediaEntityDto) {
    return this.media.list(organizationId(user), dto);
  }

  @ApiOperation({ summary: 'Firmar subida de imagen o video' })
  @RequirePermissions('catalog:manage')
  @Post('presign')
  presign(@CurrentUser() user: JwtUser, @Body() dto: PresignMediaDto) {
    return this.media.presign(organizationId(user), dto);
  }

  @ApiOperation({ summary: 'Guardar archivo subido en la galería' })
  @RequirePermissions('catalog:manage')
  @Post('finalize')
  finalize(@CurrentUser() user: JwtUser, @Body() dto: FinalizeMediaDto) {
    return this.media.finalize(organizationId(user), dto);
  }

  @ApiOperation({ summary: 'Eliminar archivo de la galería' })
  @RequirePermissions('catalog:manage')
  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.media.remove(organizationId(user), id);
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene un negocio activo');
  }

  return user.organizationId;
}
