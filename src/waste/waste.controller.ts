import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateWasteDto, PresignWastePhotoDto } from './dto/waste.dto';
import { WasteService } from './waste.service';

@ApiTags('waste')
@Controller('waste')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WasteController {
  constructor(private readonly waste: WasteService) {}

  @ApiOperation({ summary: 'Firmar la subida de la foto de una merma' })
  @RequirePermissions('inventory:adjust')
  @HttpCode(200)
  @Post('photo')
  presignPhoto(
    @CurrentUser() user: JwtUser,
    @Body() dto: PresignWastePhotoDto,
  ) {
    return this.waste.presignPhoto(
      user.organizationId,
      dto.contentType,
      dto.size ?? 0,
    );
  }

  @ApiOperation({ summary: 'Registrar una merma' })
  @RequirePermissions('inventory:adjust')
  @Post()
  create(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateWasteDto,
  ) {
    return this.waste.create(user.organizationId, user.sub, branchId, dto);
  }

  @ApiOperation({ summary: 'Mermas del periodo con totales por motivo' })
  @RequirePermissions('inventory:manage')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.waste.list(user.organizationId, branchId, from, to);
  }
}
