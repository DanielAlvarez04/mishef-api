import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class IntelChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsIn(['es-MX', 'en-US'])
  locale?: string;
}

export class IntelSettingsDto {
  @IsBoolean()
  enabled!: boolean;
}

export class IntelFeedbackDto {
  @IsString()
  messageId!: string;

  @IsInt()
  @Min(-1)
  @Max(1)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
