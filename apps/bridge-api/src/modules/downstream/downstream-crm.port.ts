import { CanonicalOrderRecord } from '@veritas/contracts';

export const DOWNSTREAM_CRM_PORT = Symbol('DOWNSTREAM_CRM_PORT');

export interface DownstreamSyncResult {
  targetRecordId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown>;
}

export class PermanentDownstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'PermanentDownstreamError';
  }
}

export class TransientDownstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'TransientDownstreamError';
  }
}

export interface DownstreamCrmPort {
  upsertOrder(record: CanonicalOrderRecord, idempotencyKey?: string): Promise<DownstreamSyncResult>;
  restoreSnapshot(
    targetRecordId: string,
    beforeState: Record<string, unknown> | null,
    expectedAfterState?: Record<string, unknown> | null,
    idempotencyKey?: string,
  ): Promise<void>;
}
