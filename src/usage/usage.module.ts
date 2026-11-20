import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { UsageService } from './usage.service.js';

@Global()
@Module({ imports: [PrismaModule], providers: [UsageService], exports: [UsageService] })
export class UsageModule {}
