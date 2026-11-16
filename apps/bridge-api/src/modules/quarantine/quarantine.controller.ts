import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CanonicalOrderRecordSchema } from '@veritas/contracts';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLedgerService } from '../audit/audit-ledger.service';
import { ModernCrmClient } from '../downstream/modern-crm.client';

@Controller('quarantine')
export class QuarantineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLedger: AuditLedgerService,
    private readonly downstreamClient: ModernCrmClient,
  ) {}

  @Get()
  async listQuarantined() {
    return this.prisma.syncAuditLedger.findMany({
      where: {
        status: {
          in: ['QUARANTINED_LOW_CONFIDENCE', 'QUARANTINED_SCHEMA_FAILURE'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post(':auditId/approve')
  async approveAndSync(@Param('auditId') auditId: string, @Body() body: unknown) {
    const entry = await this.prisma.syncAuditLedger.findUnique({
      where: { id: auditId },
    });

    if (!entry) {
      throw new NotFoundException(`Quarantined audit entry ${auditId} not found.`);
    }

    const parsedRecord = CanonicalOrderRecordSchema.safeParse(body);
    if (!parsedRecord.success) {
      throw new BadRequestException(parsedRecord.error.flatten());
    }

    const syncResult = await this.downstreamClient.upsertOrder(parsedRecord.data);
    const overrideKey = createHash('sha256')
      .update(`OVERRIDE:${entry.idempotencyKey}:${Date.now()}`)
      .digest('hex');

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
    });
  }
}