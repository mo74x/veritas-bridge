import { ConflictException } from '@nestjs/common';
import { CanonicalOrderRecord } from '@veritas/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuarantineController } from './quarantine.controller';

const validPayload: CanonicalOrderRecord = {
  externalOrderRef: 'ORD-200',
  customerNormalizedName: 'Beta Corp',
  customerOriginalRaw: 'Beta Corp LLC',
  destinationIsoCountry: 'EG',
  destinationCity: 'Cairo',
  totalWeightKg: 12.5,
  invoiceAmountCents: 10000,
  currencyCode: 'USD',
  normalizedStatus: 'PENDING_DISPATCH',
  isHazardousMaterial: false,
  extractedSpecialInstructions: null,
};

describe('QuarantineController', () => {
  const prisma = {
    syncAuditLedger: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  const auditLedger = { appendEntry: vi.fn() };
  const downstreamClient = { upsertOrder: vi.fn(), restoreSnapshot: vi.fn() };
  const redisLock = { acquireLock: vi.fn(), releaseLock: vi.fn() };

  let controller: QuarantineController;

  beforeEach(() => {
    vi.clearAllMocks();
    redisLock.acquireLock.mockResolvedValue('lock-1');
    controller = new QuarantineController(
      prisma as never,
      auditLedger as never,
      downstreamClient as never,
      redisLock as never,
    );
  });

  it('excludes entries with resolved SYNCED/ROLLED_BACK child audits in listQuarantined', async () => {
    prisma.syncAuditLedger.findMany.mockResolvedValue([]);
    await controller.listQuarantined();

    expect(prisma.syncAuditLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          childAudits: { none: { status: { in: ['SYNCED', 'ROLLED_BACK'] } } },
        }),
      }),
    );
  });

  it('replays existing SYNCED child idempotently when payload matches', async () => {
    prisma.syncAuditLedger.findUnique.mockResolvedValue({
      id: 'q1',
      status: 'QUARANTINED_LOW_CONFIDENCE',
      idempotencyKey: 'k1',
    });
    const existingChild = {
      id: 'c1',
      status: 'SYNCED',
      parentAuditId: 'q1',
      normalizedPayload: validPayload,
    };
    prisma.syncAuditLedger.findFirst.mockResolvedValue(existingChild);

    const result = await controller.approveAndSync('q1', validPayload);

    expect(result).toEqual(existingChild);
    expect(downstreamClient.upsertOrder).not.toHaveBeenCalled();
    expect(redisLock.releaseLock).toHaveBeenCalledWith('override:q1', 'lock-1');
  });

  it('throws ConflictException when already approved with a different payload', async () => {
    prisma.syncAuditLedger.findUnique.mockResolvedValue({
      id: 'q1',
      status: 'QUARANTINED_LOW_CONFIDENCE',
      idempotencyKey: 'k1',
    });
    prisma.syncAuditLedger.findFirst.mockResolvedValue({
      id: 'c1',
      status: 'SYNCED',
      parentAuditId: 'q1',
      normalizedPayload: { ...validPayload, invoiceAmountCents: 99999 },
    });

    await expect(controller.approveAndSync('q1', validPayload)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws ConflictException when override lock is contended', async () => {
    redisLock.acquireLock.mockResolvedValue(null);
    await expect(controller.approveAndSync('q1', validPayload)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
