import { Injectable, Logger } from '@nestjs/common';
import { CanonicalOrderRecord } from '@veritas/contracts';
import { DownstreamCrmPort, DownstreamSyncResult } from './downstream-crm.port';

export type { DownstreamSyncResult };

@Injectable()
export class ModernCrmClient implements DownstreamCrmPort {
  private readonly logger = new Logger(ModernCrmClient.name);
  // In-memory state store representing the downstream modern API (test/dev fallback)
  private readonly remoteStore = new Map<string, Record<string, unknown>>();

  async upsertOrder(
    record: CanonicalOrderRecord,
    _idempotencyKey?: string,
  ): Promise<DownstreamSyncResult> {
    const targetRecordId = `CRM-${record.externalOrderRef}`;
    const existing = this.remoteStore.get(targetRecordId) ?? null;
    const beforeState = existing ? { ...existing } : null;

    const afterState: Record<string, unknown> = {
      id: targetRecordId,
      ...record,
      syncedAt: new Date().toISOString(),
    };

    this.remoteStore.set(targetRecordId, afterState);
    this.logger.log(`Upserted ${targetRecordId} into downstream Modern CRM API.`);

    return {
      targetRecordId,
      beforeState,
      afterState,
    };
  }

  async restoreSnapshot(
    targetRecordId: string,
    beforeState: Record<string, unknown> | null,
    _expectedAfterState?: Record<string, unknown> | null,
    _idempotencyKey?: string,
  ): Promise<void> {
    if (beforeState === null) {
      this.remoteStore.delete(targetRecordId);
      this.logger.warn(`Rolled back ${targetRecordId}: deleted newly created record.`);
    } else {
      this.remoteStore.set(targetRecordId, { ...beforeState });
      this.logger.warn(`Rolled back ${targetRecordId}: restored prior snapshot.`);
    }
  }
}