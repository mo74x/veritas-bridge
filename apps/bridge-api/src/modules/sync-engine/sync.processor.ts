import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { CONFIDENCE_AUTO_SYNC_THRESHOLD, ExtractionEnvelope, LegacyRawRow } from '@veritas/contracts';
import { ExtractionAgentService, getPromptHash, TransientLLMError } from '@veritas/extraction-agent';
import { Job } from 'bullmq';
import { ZodError } from 'zod';
import { RedisLockService } from '../../common/locks/redis-lock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLedgerService } from '../audit/audit-ledger.service';
import {
  DOWNSTREAM_CRM_PORT,
  DownstreamCrmPort,
  PermanentDownstreamError,
  TransientDownstreamError,
} from '../downstream/downstream-crm.port';

export const RAW_MUTATION_QUEUE = 'raw-mutation-queue';

export class LockContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockContentionError';
  }
}

@Processor(RAW_MUTATION_QUEUE)
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);
  private readonly extractionAgent = new ExtractionAgentService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly auditLedger: AuditLedgerService,
    @Inject(DOWNSTREAM_CRM_PORT) private readonly downstreamClient: DownstreamCrmPort,
  ) {
    super();
  }

  async process(job: Job<LegacyRawRow>): Promise<void> {
    const rawRow = job.data;
    const startTime = Date.now();
    const idempotencyKey = this.redisLock.computeIdempotencyKey(
      rawRow.sourceSystem,
      rawRow.rowId,
      rawRow.payload,
    );

    // 1. Acquire distributed lock to prevent echo loops or duplicate workers
    const lockToken = await this.redisLock.acquireLock(idempotencyKey);
    if (!lockToken) {
      throw new LockContentionError(`Lock already held for row ${rawRow.rowId}.`);
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
      let envelope: ExtractionEnvelope;
      try {
        envelope = await this.extractionAgent.extractRow(rawRow);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ZodError) {
          await this.auditLedger.appendEntry({
            idempotencyKey,
            sourceSystem: rawRow.sourceSystem,
            sourceRecordId: rawRow.rowId,
            targetSystem: 'MODERN_CRM_API',
            targetRecordId: null,
            status: 'QUARANTINED_SCHEMA_FAILURE',
            actor: 'AI_EXTRACTION_AGENT',
            rawInputPayload: rawRow.payload,
            normalizedPayload: null,
            beforeState: null,
            afterState: null,
            modelVersion: process.env.LLM_MODEL_VERSION ?? 'unknown',
            promptHash: getPromptHash(),
            confidenceScore: 0,
            ambiguityFlags: ['SCHEMA_PARSE_FAILURE', error.message],
            latencyMs: Math.max(1, Date.now() - startTime),
          });
          this.logger.warn(`Quarantined row ${rawRow.rowId} due to schema/parse failure.`);
          return;
        }
        if (error instanceof TransientLLMError) {
          throw error;
        }
        throw error;
      }

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
      try {
        const syncResult = await this.downstreamClient.upsertOrder(
          envelope.record,
          idempotencyKey,
        );

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
      } catch (error) {
        if (error instanceof PermanentDownstreamError) {
          await this.auditLedger.appendEntry({
            idempotencyKey,
            sourceSystem: rawRow.sourceSystem,
            sourceRecordId: rawRow.rowId,
            targetSystem: 'MODERN_CRM_API',
            targetRecordId: null,
            status: 'FAILED_DOWNSTREAM_API',
            actor,
            rawInputPayload: rawRow.payload,
            normalizedPayload: envelope.record,
            beforeState: null,
            afterState: null,
            modelVersion: envelope.modelVersion,
            promptHash: envelope.promptHash,
            confidenceScore: envelope.confidenceScore,
            ambiguityFlags: [...envelope.ambiguityFlags, 'PERMANENT_DOWNSTREAM_ERROR', error.message],
            latencyMs: Math.max(1, Date.now() - startTime),
          });
          this.logger.error(`Permanent downstream failure for row ${rawRow.rowId}: ${error.message}`);
          return;
        }

        if (
          error instanceof TransientDownstreamError &&
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
        ) {
          await this.auditLedger.appendEntry({
            idempotencyKey,
            sourceSystem: rawRow.sourceSystem,
            sourceRecordId: rawRow.rowId,
            targetSystem: 'MODERN_CRM_API',
            targetRecordId: null,
            status: 'FAILED_DOWNSTREAM_API',
            actor,
            rawInputPayload: rawRow.payload,
            normalizedPayload: envelope.record,
            beforeState: null,
            afterState: null,
            modelVersion: envelope.modelVersion,
            promptHash: envelope.promptHash,
            confidenceScore: envelope.confidenceScore,
            ambiguityFlags: [
              ...envelope.ambiguityFlags,
              'TRANSIENT_DOWNSTREAM_EXHAUSTED',
              error.message,
            ],
            latencyMs: Math.max(1, Date.now() - startTime),
          });
        }

        throw error;
      }
    } finally {
      await this.redisLock.releaseLock(idempotencyKey, lockToken);
    }
  }
}