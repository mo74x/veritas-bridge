import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { RedisLockService } from './common/locks/redis-lock.service';
import { PrismaService } from './common/prisma/prisma.service';
import { AuditController } from './modules/audit/audit.controller';
import { AuditLedgerService } from './modules/audit/audit-ledger.service';
import { DOWNSTREAM_CRM_PORT } from './modules/downstream/downstream-crm.port';
import { HttpModernCrmClient } from './modules/downstream/http-modern-crm.client';
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
    HttpModernCrmClient,
    {
      provide: DOWNSTREAM_CRM_PORT,
      useFactory: (httpClient: HttpModernCrmClient, inMemoryClient: ModernCrmClient) => {
        if (process.env.CRM_BASE_URL) {
          return httpClient;
        }
        const env = process.env.NODE_ENV ?? 'development';
        if (env === 'test' || env === 'development') {
          return inMemoryClient;
        }
        throw new Error(
          `CRM_BASE_URL is required when NODE_ENV=${env} (in-memory fallback is restricted to test/development).`,
        );
      },
      inject: [HttpModernCrmClient, ModernCrmClient],
    },
    AuditLedgerService,
    SyncProcessor,
  ],
})
export class AppModule implements OnModuleInit {
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }

    const missing = ['CRM_BASE_URL', 'CRM_API_TOKEN', 'LLM_API_KEY'].filter(
      (key) => !process.env[key],
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing required production environment variable(s): ${missing.join(', ')}`,
      );
    }
  }
}