import { Module } from '@nestjs/common';
import { GigachatService } from './gigachat.service.js';

@Module({
  providers: [GigachatService],
  exports: [GigachatService]
})
export class GigachatModule {}
