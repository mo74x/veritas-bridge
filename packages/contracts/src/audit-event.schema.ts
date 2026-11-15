import { z } from 'zod';
import { CanonicalOrderRecordSchema } from './canonical-record.schema';

export const CONFIDENCE_AUTO_SYNC_THRESHOLD = 0.92;

export const SyncStatusEnum = z.enum([
  'SYNCED',
  'QUARANTINED_LOW_CONFIDENCE',
  'QUARANTINED_SCHEMA_FAILURE',
  'FAILED_DOWNSTREAM_API',
  'ROLLED_BACK',
]);

export type SyncStatus = z.infer<typeof SyncStatusEnum>;

export const ActorTypeEnum = z.enum([
  'DETERMINISTIC_FAST_PATH',
  'AI_EXTRACTION_AGENT',
  'HUMAN_QUARANTINE_OVERRIDE',
  'SYSTEM_ROLLBACK',
]);

export type ActorType = z.infer<typeof ActorTypeEnum>;

export const ChainedAuditEntrySchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().length(64), // SHA-256 hex
  sourceSystem: z.string(),
  sourceRecordId: z.string(),
  targetSystem: z.string(),
  targetRecordId: z.string().nullable(),
  status: SyncStatusEnum,
  actor: ActorTypeEnum,
  rawInputPayload: z.record(z.string(), z.unknown()),
  normalizedPayload: CanonicalOrderRecordSchema.nullable(),
  beforeState: z.record(z.string(), z.unknown()).nullable(),
  afterState: z.record(z.string(), z.unknown()).nullable(),
  modelVersion: z.string(),
  promptHash: z.string(),
  confidenceScore: z.number().min(0).max(1),
  ambiguityFlags: z.array(z.string()),
  latencyMs: z.number().int().nonnegative(),
  previousHash: z.string().length(64),
  currentHash: z.string().length(64),
  createdAt: z.string().datetime(),
});

export type ChainedAuditEntry = z.infer<typeof ChainedAuditEntrySchema>;