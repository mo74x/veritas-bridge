import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RedisLockService } from './common/locks/redis-lock.service';
import { PrismaService } from './common/prisma/prisma.service';
import { AuditController } from './modules/audit/audit.controller';
import { AuditLedgerService } from './modules/audit/audit-ledger.service';
import { ModernCrmClient } from './modules/downstream/modern-crm.client';
import { IngestController } from './modules/ingest/ingest.controller';
import { QuarantineController } from './modules/quarantine/quarantine.controller';
import { RAW_MUTATION_QUEUE, SyncProcessor } from './modules/sync-engine/sync.processor';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({
      name: RAW_MUTATION_QUEUE,
    }),
  ],
  controllers: [IngestController, QuarantineController, AuditController],
  providers: [
    PrismaService,
    RedisLockService,
    ModernCrmClient,
    AuditLedgerService,
    SyncProcessor,
  ],
})
export class AppModule {}