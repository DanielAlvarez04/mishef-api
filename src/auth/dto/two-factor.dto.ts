import { IsString, MaxLength, MinLength } from 'class-validator';

export class TwoFactorChallengeDto {
  @IsString()
  @MinLength(10)
  challengeId!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(20)
  code!: string;
}

export class DisableTwoFactorDto {
  @IsString()
  @MinLength(1)
  password!: string;
}

export class TotpCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}
