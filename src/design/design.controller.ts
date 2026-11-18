import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { DesignService } from './design.service';
import { UpdateDesignTokensDto } from './dto/design-tokens.dto';

@ApiTags('design')
@Controller('design')
export class DesignController {
  constructor(private readonly design: DesignService) {}

  @ApiOperation({ summary: 'Tokens visuales globales' })
  @UseGuards(JwtAuthGuard)
  @Get()
  get() {
    return this.design.get();
  }

  @ApiOperation({ summary: 'Guardar tokens visuales globales' })
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @Put()
  save(@Body() dto: UpdateDesignTokensDto) {
    return this.design.save(dto.tokens);
  }

  @ApiOperation({ summary: 'Restablecer los estilos de la app' })
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @Delete()
  reset() {
    return this.design.reset();
  }
}
