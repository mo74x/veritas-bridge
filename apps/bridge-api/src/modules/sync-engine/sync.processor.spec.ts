import { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermanentDownstreamError, TransientDownstreamError } from '../downstream/downstream-crm.port';
import { LockContentionError, SyncProcessor } from './sync.processor';

const messyJob = (attemptsMade = 0, attempts = 3) =>
  ({
    data: {
      sourceSystem: 'LEGACY_ERP',
      rowId: 'ROW-100',
      payload: { rawText: 'Order ORD-100 from Acme for $50' },
      receivedAt: '2026-11-16T00:00:00.000Z',
    },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job;

const cleanEnvelope = {
  record: {
    externalOrderRef: 'ORD-100',
    vendorName: 'Acme',
    currency: 'USD',
    amountCents: 5000,
    orderDate: '2026-11-16T00:00:00.000Z',
    lineItems: [{ sku: 'S1', description: 'Item', quantity: 1, unitPriceCents: 5000 }],
  },
  confidenceScore: 0.98,
  ambiguityFlags: [],
  reasoningSummary: 'ok',
  resolutionMethod: 'DETERMINISTIC_FAST_PATH' as const,
  modelVersion: 'deterministic-rule-v1',
  promptHash: 'abc',
  latencyMs: 2,
  tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
};

describe('SyncProcessor', () => {
  const prisma = {
    syncAuditLedger: { findUnique: vi.fn() },
  };
  const redisLock = {
    computeIdempotencyKey: vi.fn().mockReturnValue('idem-1'),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  };
  const auditLedger = {
    appendEntry: vi.fn(),
  };
  const downstreamClient = {
    upsertOrder: vi.fn(),
    restoreSnapshot: vi.fn(),
  };

  let processor: SyncProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    redisLock.acquireLock.mockResolvedValue('lock-token');
    prisma.syncAuditLedger.findUnique.mockResolvedValue(null);
    processor = new SyncProcessor(
      prisma as never,
      redisLock as never,
      auditLedger as never,
      downstreamClient as never,
    );
  });

  it('throws LockContentionError when acquireLock returns null', async () => {
    redisLock.acquireLock.mockResolvedValue(null);
    await expect(processor.process(messyJob())).rejects.toBeInstanceOf(LockContentionError);
    expect(auditLedger.appendEntry).not.toHaveBeenCalled();
  });

  it('records QUARANTINED_SCHEMA_FAILURE on SyntaxError without retrying', async () => {
    (processor as unknown as { extractionAgent: { extractRow: unknown } }).extractionAgent = {
      extractRow: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    };

    await processor.process(messyJob());

    expect(auditLedger.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'QUARANTINED_SCHEMA_FAILURE' }),
    );
    expect(downstreamClient.upsertOrder).not.toHaveBeenCalled();
    expect(redisLock.releaseLock).toHaveBeenCalledWith('idem-1', 'lock-token');
  });

  it('records FAILED_DOWNSTREAM_API on PermanentDownstreamError without rethrowing', async () => {
    (processor as unknown as { extractionAgent: { extractRow: unknown } }).extractionAgent = {
      extractRow: vi.fn().mockResolvedValue(cleanEnvelope),
    };
    downstreamClient.upsertOrder.mockRejectedValue(new PermanentDownstreamError('Bad request', 400));

    await processor.process(messyJob());

    expect(auditLedger.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED_DOWNSTREAM_API' }),
    );
  });

  it('records FAILED_DOWNSTREAM_API on final TransientDownstreamError attempt and rethrows', async () => {
    (processor as unknown as { extractionAgent: { extractRow: unknown } }).extractionAgent = {
      extractRow: vi.fn().mockResolvedValue(cleanEnvelope),
    };
    downstreamClient.upsertOrder.mockRejectedValue(new TransientDownstreamError('503', 503));

    await expect(processor.process(messyJob(2, 3))).rejects.toBeInstanceOf(
      TransientDownstreamError,
    );
    expect(auditLedger.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED_DOWNSTREAM_API' }),
    );
  });
});
