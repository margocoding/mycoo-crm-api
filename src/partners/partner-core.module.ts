import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PartnerService } from './partner.service.js';

@Module({ imports: [PrismaModule], providers: [PartnerService], exports: [PartnerService] })
export class PartnerCoreModule {}
