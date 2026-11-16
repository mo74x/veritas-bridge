import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLedgerService, GENESIS_HASH } from './audit-ledger.service';

describe('AuditLedgerService', () => {
  const prisma = {
    $transaction: vi.fn(),
    syncAuditLedger: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  const downstreamClient = {
    upsertOrder: vi.fn(),
    restoreSnapshot: vi.fn(),
  };
  const redisLock = {
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  };

  let service: AuditLedgerService;

  beforeEach(() => {
    vi.clearAllMocks();
    redisLock.acquireLock.mockResolvedValue('lock-1');
    service = new AuditLedgerService(
      prisma as never,
      downstreamClient as never,
      redisLock as never,
    );
  });

  it('retries P2034 serialization conflicts in appendEntry', async () => {
    const createdRow = { id: 'audit-1', currentHash: 'h1' };
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockResolvedValueOnce(createdRow);

    const result = await service.appendEntry({
      idempotencyKey: 'k1',
      sourceSystem: 'ERP',
      sourceRecordId: 'R1',
      targetSystem: 'MODERN_CRM_API',
      targetRecordId: 'CRM-1',
      status: 'SYNCED',
      actor: 'DETERMINISTIC_FAST_PATH',
      rawInputPayload: { a: 1 },
      normalizedPayload: null,
      beforeState: null,
      afterState: null,
      modelVersion: 'v1',
      promptHash: 'ph',
      confidenceScore: 0.99,
      ambiguityFlags: [],
      latencyMs: 1,
    });

    expect(result).toEqual(createdRow);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('verifies legacy 4-field hashed entries during paginated verifyChainIntegrity', async () => {
    const { createHash } = await import('crypto');
    const legacyHash = createHash('sha256')
      .update(`${GENESIS_HASH}:k1:SYNCED:${JSON.stringify({})}`)
      .digest('hex');

    prisma.syncAuditLedger.findMany.mockResolvedValueOnce([
      {
        id: 'a1',
        previousHash: GENESIS_HASH,
        currentHash: legacyHash,
        idempotencyKey: 'k1',
        status: 'SYNCED',
        actor: 'DETERMINISTIC_FAST_PATH',
        targetRecordId: 'CRM-1',
        confidenceScore: 0.99,
        rawInputPayload: {},
        normalizedPayload: null,
        beforeState: null,
        afterState: null,
      },
    ]);

    const result = await service.verifyChainIntegrity();
    expect(result).toEqual({ valid: true, totalEntries: 1 });
  });

  it('returns existing ROLLED_BACK child idempotently without re-calling CRM', async () => {
    prisma.syncAuditLedger.findUnique.mockResolvedValue({
      id: 'audit-1',
      status: 'SYNCED',
      targetRecordId: 'CRM-1',
      idempotencyKey: 'k1',
    });
    const existingRollback = { id: 'audit-rb-1', status: 'ROLLED_BACK', parentAuditId: 'audit-1' };
    prisma.syncAuditLedger.findFirst.mockResolvedValue(existingRollback);

    const result = await service.rollbackEntry('audit-1');

    expect(result).toEqual(existingRollback);
    expect(downstreamClient.restoreSnapshot).not.toHaveBeenCalled();
    expect(redisLock.releaseLock).toHaveBeenCalledWith('rollback:audit-1', 'lock-1');
  });

  it('throws ConflictException when rollback lock is contended', async () => {
    redisLock.acquireLock.mockResolvedValue(null);
    await expect(service.rollbackEntry('audit-1')).rejects.toBeInstanceOf(ConflictException);
  });
});
