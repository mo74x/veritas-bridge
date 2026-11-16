import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ActorType, Prisma, SyncAuditLedger, SyncStatus } from '@prisma/client';
import { CanonicalOrderRecord } from '@veritas/contracts';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModernCrmClient } from '../downstream/modern-crm.client';

export const GENESIS_HASH = '0'.repeat(64);

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
}

@Injectable()
export class AuditLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly downstreamClient: ModernCrmClient,
  ) {}

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private computeEntryHash(
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

  /**
   * Appends a tamper-evident entry to the cryptographic hash chain and writes an outbox event.
   */
  async appendEntry(params: AppendAuditParams): Promise<SyncAuditLedger> {
    return this.prisma.$transaction(
      async (tx) => {
        const latest = await tx.syncAuditLedger.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { currentHash: true },
        });

        const previousHash = latest?.currentHash ?? GENESIS_HASH;
        const currentHash = this.computeEntryHash(
          previousHash,
          params.idempotencyKey,
          params.status,
          params.normalizedPayload,
        );

        const created = await tx.syncAuditLedger.create({
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
          },
        });

        await tx.transactionalOutbox.create({
          data: {
            aggregateId: created.id,
            eventType: `AUDIT_${params.status}`,
            payload: this.toJsonValue({
              auditId: created.id,
              sourceRecordId: created.sourceRecordId,
              targetRecordId: created.targetRecordId,
              status: created.status,
              currentHash: created.currentHash,
            }),
          },
        });

        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Verifies the entire SHA-256 hash chain from genesis to the latest record.
   */
  async verifyChainIntegrity(): Promise<{
    valid: boolean;
    totalEntries: number;
    brokenAtId?: string;
  }> {
    const entries = await this.prisma.syncAuditLedger.findMany({
      orderBy: { createdAt: 'asc' },
    });

    let expectedPreviousHash = GENESIS_HASH;

    for (const entry of entries) {
      if (entry.previousHash !== expectedPreviousHash) {
        return { valid: false, totalEntries: entries.length, brokenAtId: entry.id };
      }

      const recomputed = this.computeEntryHash(
        entry.previousHash,
        entry.idempotencyKey,
        entry.status,
        (entry.normalizedPayload as CanonicalOrderRecord | null) ?? null,
      );

      if (recomputed !== entry.currentHash) {
        return { valid: false, totalEntries: entries.length, brokenAtId: entry.id };
      }

      expectedPreviousHash = entry.currentHash;
    }

    return { valid: true, totalEntries: entries.length };
  }

  /**
   * 1-Click Rollback: Restores the downstream API state to `beforeState` and appends a ROLLED_BACK entry.
   */
  async rollbackEntry(auditId: string): Promise<SyncAuditLedger> {
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

    const priorSnapshot = (targetEntry.beforeState as Record<string, unknown> | null) ?? null;
    await this.downstreamClient.restoreSnapshot(targetEntry.targetRecordId, priorSnapshot);

    const rollbackIdempotencyKey = createHash('sha256')
      .update(`ROLLBACK:${targetEntry.idempotencyKey}:${Date.now()}`)
      .digest('hex');

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
      beforeState: (targetEntry.afterState as Record<string, unknown> | null) ?? null,
      afterState: priorSnapshot,
      modelVersion: targetEntry.modelVersion,
      promptHash: targetEntry.promptHash,
      confidenceScore: targetEntry.confidenceScore,
      ambiguityFlags: ['ROLLED_BACK_BY_OPERATOR'],
      latencyMs: 5,
    });
  }
}