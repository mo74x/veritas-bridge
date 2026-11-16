import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActorType, Prisma, SyncAuditLedger, SyncStatus } from '@prisma/client';
import { CanonicalOrderRecord } from '@veritas/contracts';
import { createHash } from 'crypto';
import { canonicalizeJson, RedisLockService } from '../../common/locks/redis-lock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOWNSTREAM_CRM_PORT, DownstreamCrmPort } from '../downstream/downstream-crm.port';

export const GENESIS_HASH = '0'.repeat(64);
const MAX_SERIALIZATION_RETRIES = 5;
const VERIFY_BATCH_SIZE = 500;

export interface AppendAuditParams {
  idempotencyKey: string;
  sourceSystem: string;
  sourceRecordId: string;
  targetSystem: string;
  targetRecordId: string | null;
  status: SyncStatus;
  actor: ActorType;
  rawInputPayload: Record<string, unknown>;
  normalizedPayload: CanonicalOrderRecord | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  modelVersion: string;
  promptHash: string;
  confidenceScore: number;
  ambiguityFlags: string[];
  latencyMs: number;
  parentAuditId?: string | null;
}

@Injectable()
export class AuditLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOWNSTREAM_CRM_PORT) private readonly downstreamClient: DownstreamCrmPort,
    private readonly redisLock: RedisLockService,
  ) {}

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private computeEntryHash(params: {
    previousHash: string;
    idempotencyKey: string;
    status: SyncStatus;
    actor: ActorType;
    targetRecordId: string | null;
    confidenceScore: number;
    rawInputPayload: Record<string, unknown>;
    normalizedPayload: CanonicalOrderRecord | null;
    beforeState: Record<string, unknown> | null;
    afterState: Record<string, unknown> | null;
  }): string {
    const serialized = JSON.stringify(
      canonicalizeJson({
        previousHash: params.previousHash,
        idempotencyKey: params.idempotencyKey,
        status: params.status,
        actor: params.actor,
        targetRecordId: params.targetRecordId ?? '',
        confidenceScore: params.confidenceScore,
        rawInputPayload: params.rawInputPayload,
        normalizedPayload: params.normalizedPayload ?? {},
        beforeState: params.beforeState ?? null,
        afterState: params.afterState ?? null,
      }),
    );

    return createHash('sha256').update(serialized).digest('hex');
  }

  private computeLegacyEntryHash(
    previousHash: string,
    idempotencyKey: string,
    status: SyncStatus,
    normalizedPayload: CanonicalOrderRecord | null,
  ): string {
    return createHash('sha256')
      .update(
        `${previousHash}:${idempotencyKey}:${status}:${JSON.stringify(normalizedPayload ?? {})}`,
      )
      .digest('hex');
  }

  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const code = (error as { code?: string }).code;
    return code === 'P2034' || code === '40001';
  }

  /**
   * Appends a tamper-evident entry to the cryptographic hash chain, retrying Postgres 40001/P2034 conflicts.
   */
  async appendEntry(params: AppendAuditParams): Promise<SyncAuditLedger> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const latest = await tx.syncAuditLedger.findFirst({
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { currentHash: true },
            });

            const previousHash = latest?.currentHash ?? GENESIS_HASH;
            const currentHash = this.computeEntryHash({
              previousHash,
              idempotencyKey: params.idempotencyKey,
              status: params.status,
              actor: params.actor,
              targetRecordId: params.targetRecordId,
              confidenceScore: params.confidenceScore,
              rawInputPayload: params.rawInputPayload,
              normalizedPayload: params.normalizedPayload,
              beforeState: params.beforeState,
              afterState: params.afterState,
            });

            return tx.syncAuditLedger.create({
              data: {
                idempotencyKey: params.idempotencyKey,
                sourceSystem: params.sourceSystem,
                sourceRecordId: params.sourceRecordId,
                targetSystem: params.targetSystem,
                targetRecordId: params.targetRecordId,
                status: params.status,
                actor: params.actor,
                rawInputPayload: this.toJsonValue(params.rawInputPayload),
                normalizedPayload: params.normalizedPayload
                  ? this.toJsonValue(params.normalizedPayload)
                  : Prisma.JsonNull,
                beforeState: params.beforeState
                  ? this.toJsonValue(params.beforeState)
                  : Prisma.JsonNull,
                afterState: params.afterState
                  ? this.toJsonValue(params.afterState)
                  : Prisma.JsonNull,
                modelVersion: params.modelVersion,
                promptHash: params.promptHash,
                confidenceScore: params.confidenceScore,
                ambiguityFlags: this.toJsonValue(params.ambiguityFlags),
                latencyMs: params.latencyMs,
                previousHash,
                currentHash,
                parentAuditId: params.parentAuditId ?? null,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!this.isSerializationConflict(error) || attempt === MAX_SERIALIZATION_RETRIES - 1) {
          throw error;
        }
        lastError = error;
        const backoffMs = 20 * 2 ** attempt + Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError;
  }

  /**
   * Verifies the entire SHA-256 hash chain in 500-row cursor batches from genesis to the latest record.
   */
  async verifyChainIntegrity(): Promise<{
    valid: boolean;
    totalEntries: number;
    brokenAtId?: string;
  }> {
    let expectedPreviousHash = GENESIS_HASH;
    let totalEntries = 0;
    let cursorId: string | undefined;

    while (true) {
      const batch = await this.prisma.syncAuditLedger.findMany({
        take: VERIFY_BATCH_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      if (batch.length === 0) {
        break;
      }

      for (const entry of batch) {
        totalEntries++;
        if (entry.previousHash !== expectedPreviousHash) {
          return { valid: false, totalEntries, brokenAtId: entry.id };
        }

        const v2Hash = this.computeEntryHash({
          previousHash: entry.previousHash,
          idempotencyKey: entry.idempotencyKey,
          status: entry.status,
          actor: entry.actor,
          targetRecordId: entry.targetRecordId,
          confidenceScore: entry.confidenceScore,
          rawInputPayload: (entry.rawInputPayload as Record<string, unknown>) ?? {},
          normalizedPayload: (entry.normalizedPayload as CanonicalOrderRecord | null) ?? null,
          beforeState: (entry.beforeState as Record<string, unknown> | null) ?? null,
          afterState: (entry.afterState as Record<string, unknown> | null) ?? null,
        });

        const legacyHash = this.computeLegacyEntryHash(
          entry.previousHash,
          entry.idempotencyKey,
          entry.status,
          (entry.normalizedPayload as CanonicalOrderRecord | null) ?? null,
        );

        if (v2Hash !== entry.currentHash && legacyHash !== entry.currentHash) {
          return { valid: false, totalEntries, brokenAtId: entry.id };
        }

        expectedPreviousHash = entry.currentHash;
      }

      cursorId = batch[batch.length - 1]?.id;
      if (batch.length < VERIFY_BATCH_SIZE) {
        break;
      }
    }

    return { valid: true, totalEntries };
  }

  /**
   * 1-Click Rollback: Restores the downstream API state to `beforeState` and appends a ROLLED_BACK entry idempotently.
   */
  async rollbackEntry(auditId: string): Promise<SyncAuditLedger> {
    const lockKey = `rollback:${auditId}`;
    const lockToken = await this.redisLock.acquireLock(lockKey);
    if (!lockToken) {
      throw new ConflictException(`Rollback already in progress for audit entry ${auditId}.`);
    }

    try {
      const targetEntry = await this.prisma.syncAuditLedger.findUnique({
        where: { id: auditId },
      });

      if (!targetEntry) {
        throw new NotFoundException(`Audit entry ${auditId} not found.`);
      }

      if (targetEntry.status !== 'SYNCED' || !targetEntry.targetRecordId) {
        throw new BadRequestException(
          `Only SYNCED records with a targetRecordId can be rolled back (current status: ${targetEntry.status}).`,
        );
      }

      const existingRollback = await this.prisma.syncAuditLedger.findFirst({
        where: { parentAuditId: targetEntry.id, status: 'ROLLED_BACK' },
      });
      if (existingRollback) {
        return existingRollback;
      }

      const priorSnapshot = (targetEntry.beforeState as Record<string, unknown> | null) ?? null;
      const expectedAfterState = (targetEntry.afterState as Record<string, unknown> | null) ?? null;
      const rollbackIdempotencyKey = createHash('sha256')
        .update(`ROLLBACK:${targetEntry.idempotencyKey}`)
        .digest('hex');

      await this.downstreamClient.restoreSnapshot(
        targetEntry.targetRecordId,
        priorSnapshot,
        expectedAfterState,
        rollbackIdempotencyKey,
      );

      return this.appendEntry({
        idempotencyKey: rollbackIdempotencyKey,
        sourceSystem: targetEntry.sourceSystem,
        sourceRecordId: targetEntry.sourceRecordId,
        targetSystem: targetEntry.targetSystem,
        targetRecordId: targetEntry.targetRecordId,
        status: 'ROLLED_BACK',
        actor: 'SYSTEM_ROLLBACK',
        rawInputPayload: targetEntry.rawInputPayload as Record<string, unknown>,
        normalizedPayload: (targetEntry.normalizedPayload as CanonicalOrderRecord | null) ?? null,
        beforeState: expectedAfterState,
        afterState: priorSnapshot,
        modelVersion: targetEntry.modelVersion,
        promptHash: targetEntry.promptHash,
        confidenceScore: targetEntry.confidenceScore,
        ambiguityFlags: ['ROLLED_BACK_BY_OPERATOR'],
        latencyMs: 5,
        parentAuditId: targetEntry.id,
      });
    } finally {
      await this.redisLock.releaseLock(lockKey, lockToken);
    }
  }
}