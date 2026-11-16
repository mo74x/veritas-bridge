import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CONFIDENCE_AUTO_SYNC_THRESHOLD, LegacyRawRow } from '@veritas/contracts';
import { ExtractionAgentService } from '@veritas/extraction-agent';
import { Job } from 'bullmq';
import { RedisLockService } from '../../common/locks/redis-lock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLedgerService } from '../audit/audit-ledger.service';
import { ModernCrmClient } from '../downstream/modern-crm.client';

export const RAW_MUTATION_QUEUE = 'raw-mutation-queue';

@Processor(RAW_MUTATION_QUEUE)
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);
  private readonly extractionAgent = new ExtractionAgentService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly auditLedger: AuditLedgerService,
    private readonly downstreamClient: ModernCrmClient,
  ) {
    super();
  }

  async process(job: Job<LegacyRawRow>): Promise<void> {
    const rawRow = job.data;
    const idempotencyKey = this.redisLock.computeIdempotencyKey(
      rawRow.sourceSystem,
      rawRow.rowId,
      rawRow.payload,
    );

    // 1. Acquire distributed lock to prevent echo loops or duplicate workers
    const lockToken = await this.redisLock.acquireLock(idempotencyKey);
    if (!lockToken) {
      this.logger.warn(`Skipping row ${rawRow.rowId}: lock already held.`);
      return;
    }

    try {
      // 2. Database idempotency check
      const existing = await this.prisma.syncAuditLedger.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.log(`Row ${rawRow.rowId} already processed (${existing.status}).`);
        return;
      }

      // 3. Run Hybrid Extraction Agent (Deterministic Fast-Path -> Structured LLM)
      const envelope = await this.extractionAgent.extractRow(rawRow);
      const actor =
        envelope.resolutionMethod === 'DETERMINISTIC_FAST_PATH'
          ? 'DETERMINISTIC_FAST_PATH'
          : 'AI_EXTRACTION_AGENT';

      // 4. Confidence Gate: Route < 0.92 or security-flagged rows to Human Quarantine
      if (
        envelope.confidenceScore < CONFIDENCE_AUTO_SYNC_THRESHOLD ||
        envelope.ambiguityFlags.includes('ADVERSARIAL_PROMPT_INJECTION_DETECTED')
      ) {
        await this.auditLedger.appendEntry({
          idempotencyKey,
          sourceSystem: rawRow.sourceSystem,
          sourceRecordId: rawRow.rowId,
          targetSystem: 'MODERN_CRM_API',
          targetRecordId: null,
          status: 'QUARANTINED_LOW_CONFIDENCE',
          actor,
          rawInputPayload: rawRow.payload,
          normalizedPayload: envelope.record,
          beforeState: null,
          afterState: null,
          modelVersion: envelope.modelVersion,
          promptHash: envelope.promptHash,
          confidenceScore: envelope.confidenceScore,
          ambiguityFlags: envelope.ambiguityFlags,
          latencyMs: envelope.latencyMs,
        });

        this.logger.warn(
          `Quarantined row ${rawRow.rowId} (confidence: ${envelope.confidenceScore}).`,
        );
        return;
      }

      // 5. High-confidence sync to Modern CRM API
      const syncResult = await this.downstreamClient.upsertOrder(envelope.record);

      await this.auditLedger.appendEntry({
        idempotencyKey,
        sourceSystem: rawRow.sourceSystem,
        sourceRecordId: rawRow.rowId,
        targetSystem: 'MODERN_CRM_API',
        targetRecordId: syncResult.targetRecordId,
        status: 'SYNCED',
        actor,
        rawInputPayload: rawRow.payload,
        normalizedPayload: envelope.record,
        beforeState: syncResult.beforeState,
        afterState: syncResult.afterState,
        modelVersion: envelope.modelVersion,
        promptHash: envelope.promptHash,
        confidenceScore: envelope.confidenceScore,
        ambiguityFlags: envelope.ambiguityFlags,
        latencyMs: envelope.latencyMs,
      });

      this.logger.log(
        `Synced row ${rawRow.rowId} -> ${syncResult.targetRecordId} (${envelope.resolutionMethod}).`,
      );
    } finally {
      await this.redisLock.releaseLock(idempotencyKey, lockToken);
    }
  }
}