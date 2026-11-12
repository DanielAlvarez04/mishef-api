import { IsIn } from 'class-validator';

export class SetTerminalModeDto {
  @IsIn(['PDV', 'SELF_SERVICE'])
  operatingMode!: 'PDV' | 'SELF_SERVICE';
}
