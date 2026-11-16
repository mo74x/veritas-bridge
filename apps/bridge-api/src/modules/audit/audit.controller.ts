import { Controller, Get, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLedgerService } from './audit-ledger.service';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLedger: AuditLedgerService,
  ) {}

  @Get()
  async listEntries() {
    return this.prisma.syncAuditLedger.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Get('verify')
  async verifyChain() {
    return this.auditLedger.verifyChainIntegrity();
  }

  @Post(':id/rollback')
  async rollback(@Param('id') id: string) {
    return this.auditLedger.rollbackEntry(id);
  }
}