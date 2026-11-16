import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CanonicalOrderRecordSchema } from '@veritas/contracts';
import { createHash } from 'crypto';
import { canonicalizeJson, RedisLockService } from '../../common/locks/redis-lock.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLedgerService } from '../audit/audit-ledger.service';
import { DOWNSTREAM_CRM_PORT, DownstreamCrmPort } from '../downstream/downstream-crm.port';

@Controller('quarantine')
export class QuarantineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLedger: AuditLedgerService,
    @Inject(DOWNSTREAM_CRM_PORT) private readonly downstreamClient: DownstreamCrmPort,
    private readonly redisLock: RedisLockService,
  ) {}

  @Get()
  async listQuarantined() {
    return this.prisma.syncAuditLedger.findMany({
      where: {
        status: {
          in: ['QUARANTINED_LOW_CONFIDENCE', 'QUARANTINED_SCHEMA_FAILURE'],
        },
        childAudits: {
          none: {
            status: { in: ['SYNCED', 'ROLLED_BACK'] },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post(':auditId/approve')
  async approveAndSync(@Param('auditId') auditId: string, @Body() body: unknown) {
    const parsedRecord = CanonicalOrderRecordSchema.safeParse(body);
    if (!parsedRecord.success) {
      throw new BadRequestException(parsedRecord.error.flatten());
    }

    const lockKey = `override:${auditId}`;
    const lockToken = await this.redisLock.acquireLock(lockKey);
    if (!lockToken) {
      throw new ConflictException(`Approval already in progress for audit entry ${auditId}.`);
    }

    try {
      const entry = await this.prisma.syncAuditLedger.findUnique({
        where: { id: auditId },
      });

      if (!entry) {
        throw new NotFoundException(`Quarantined audit entry ${auditId} not found.`);
      }

      const payloadHash = createHash('sha256')
        .update(JSON.stringify(canonicalizeJson(parsedRecord.data)))
        .digest('hex');

      const existingChild = await this.prisma.syncAuditLedger.findFirst({
        where: { parentAuditId: auditId, status: 'SYNCED' },
      });
      if (existingChild) {
        const existingHash = createHash('sha256')
          .update(JSON.stringify(canonicalizeJson(existingChild.normalizedPayload ?? {})))
          .digest('hex');
        if (existingHash === payloadHash) {
          return existingChild;
        }
        throw new ConflictException(
          `Audit entry ${auditId} was already approved with a different payload.`,
        );
      }

      if (
        entry.status !== 'QUARANTINED_LOW_CONFIDENCE' &&
        entry.status !== 'QUARANTINED_SCHEMA_FAILURE'
      ) {
        throw new ConflictException(
          `Audit entry ${auditId} cannot be approved from status ${entry.status}.`,
        );
      }

      const overrideKey = createHash('sha256')
        .update(`OVERRIDE:${entry.idempotencyKey}:${payloadHash}`)
        .digest('hex');

      const syncResult = await this.downstreamClient.upsertOrder(parsedRecord.data, overrideKey);

      return this.auditLedger.appendEntry({
        idempotencyKey: overrideKey,
        sourceSystem: entry.sourceSystem,
        sourceRecordId: entry.sourceRecordId,
        targetSystem: entry.targetSystem,
        targetRecordId: syncResult.targetRecordId,
        status: 'SYNCED',
        actor: 'HUMAN_QUARANTINE_OVERRIDE',
        rawInputPayload: entry.rawInputPayload as Record<string, unknown>,
        normalizedPayload: parsedRecord.data,
        beforeState: syncResult.beforeState,
        afterState: syncResult.afterState,
        modelVersion: entry.modelVersion,
        promptHash: entry.promptHash,
        confidenceScore: 1.0,
        ambiguityFlags: ['APPROVED_BY_HUMAN_OPERATOR'],
        latencyMs: 10,
        parentAuditId: entry.id,
      });
    } finally {
      await this.redisLock.releaseLock(lockKey, lockToken);
    }
  }
}