import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** Claves de régimen fiscal del SAT aceptadas en la captura. */
export const TAX_REGIMES = [
  '601',
  '603',
  '605',
  '606',
  '607',
  '608',
  '609',
  '610',
  '611',
  '612',
  '614',
  '615',
  '616',
  '620',
  '621',
  '622',
  '623',
  '624',
  '625',
  '626',
] as const;

/** Usos de CFDI más comunes para suscripciones y servicios. */
export const CFDI_USES = [
  'G01',
  'G03',
  'I08',
  'D01',
  'P01',
  'S01',
  'CP01',
] as const;

export class UpsertFiscalProfileDto {
  @IsString()
  @Matches(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, {
    message: 'El RFC no tiene un formato válido',
  })
  rfc!: string;

  @IsString()
  @Length(2, 200)
  legalName!: string;

  @IsIn([...TAX_REGIMES])
  taxRegime!: string;

  @Matches(/^\d{5}$/, { message: 'El código postal debe tener 5 dígitos' })
  zipCode!: string;

  @IsOptional()
  @IsIn([...CFDI_USES])
  cfdiUse?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
