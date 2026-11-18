import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DesignEditorGuard } from './design-editor.guard';
import { DesignService } from './design.service';
import { UpdateDesignTokensDto } from './dto/design-tokens.dto';

@ApiTags('design')
@Controller('design')
export class DesignController {
  constructor(private readonly design: DesignService) {}

  @ApiOperation({ summary: 'Tokens aplicados y borrador' })
  @UseGuards(JwtAuthGuard)
  @Get()
  get() {
    return this.design.get();
  }

  @ApiOperation({ summary: 'Guardar borrador de estilos' })
  @UseGuards(JwtAuthGuard, DesignEditorGuard)
  @Put('draft')
  saveDraft(@Body() dto: UpdateDesignTokensDto) {
    return this.design.saveDraft(dto.tokens);
  }

  @ApiOperation({ summary: 'Aplicar estilos a toda la app' })
  @UseGuards(JwtAuthGuard, DesignEditorGuard)
  @Post('apply')
  apply(@Body() dto: UpdateDesignTokensDto) {
    return this.design.apply(dto.tokens);
  }

  @ApiOperation({ summary: 'Restablecer los estilos de la app' })
  @UseGuards(JwtAuthGuard, DesignEditorGuard)
  @Delete()
  reset() {
    return this.design.reset();
  }
}
