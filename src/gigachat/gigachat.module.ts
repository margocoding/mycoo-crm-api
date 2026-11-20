import { Module } from '@nestjs/common';
import { GigachatService } from './gigachat.service.js';
import { UsageModule } from '../usage/usage.module.js';

@Module({
  imports: [UsageModule],
  providers: [GigachatService],
  exports: [GigachatService]
})
export class GigachatModule {}
