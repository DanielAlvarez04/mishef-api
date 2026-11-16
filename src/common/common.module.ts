import { Global, Module } from '@nestjs/common';
import { QuantityConverter } from './quantity-converter.service';
import { TurnstileService } from './turnstile.service';

@Global()
@Module({
  providers: [QuantityConverter, TurnstileService],
  exports: [QuantityConverter, TurnstileService],
})
export class CommonModule {}
