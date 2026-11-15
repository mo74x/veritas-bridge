import { z } from 'zod';

/**
 * Raw row ingested from a legacy CSV, Google Sheet, or aging SQL table.
 * Fields are loosely typed because legacy exports frequently shift columns or mix formats.
 */
export const LegacyRawRowSchema = z.object({
  rowId: z.string().min(1),
  sourceSystem: z.enum(['LEGACY_ERP_CSV', 'GOOGLE_SHEETS_MANIFEST', 'LEGACY_SQL_POLL']),
  rawExportTimestamp: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type LegacyRawRow = z.infer<typeof LegacyRawRowSchema>;

/**
 * The strict, canonical schema required by the modern target API.
 * Every AI extraction output MUST pass this schema before touching the downstream API.
 */
export const CanonicalOrderRecordSchema = z.object({
  externalOrderRef: z
    .string()
    .regex(/^[A-Z0-9-]+$/, 'Order ref must be normalized uppercase alphanumeric with hyphens'),
  customerNormalizedName: z
    .string()
    .min(2, 'Customer name must be normalized and stripped of legal noise'),
  customerOriginalRaw: z.string(),
  destinationIsoCountry: z
    .string()
    .length(2, 'Must be a valid 2-letter ISO-3166 country code (e.g., EG, SA, AE)'),
  destinationCity: z.string().min(2),
  totalWeightKg: z
    .number()
    .positive('Weight must be converted to positive kilograms'),
  invoiceAmountCents: z
    .number()
    .int('Invoice amount must be integer minor units (cents/piastres) to prevent float drift')
    .nonnegative(),
  currencyCode: z.enum(['EGP', 'USD', 'SAR', 'AED']),
  normalizedStatus: z.enum([
    'PENDING_DISPATCH',
    'IN_TRANSIT',
    'DELIVERED',
    'CUSTOMS_HOLD',
    'CANCELLED',
  ]),
  isHazardousMaterial: z.boolean(),
  extractedSpecialInstructions: z.string().nullable(),
});

export type CanonicalOrderRecord = z.infer<typeof CanonicalOrderRecordSchema>;

/**
 * Envelope returned by @veritas/extraction-agent containing both the canonical record
 * and the telemetry/confidence metadata needed for routing and auditing.
 */
export const ExtractionEnvelopeSchema = z.object({
  record: CanonicalOrderRecordSchema,
  confidenceScore: z.number().min(0).max(1),
  ambiguityFlags: z.array(z.string()),
  reasoningSummary: z.string(),
  resolutionMethod: z.enum(['DETERMINISTIC_FAST_PATH', 'LLM_STRUCTURED_EXTRACTION']),
  modelVersion: z.string(),
  promptHash: z.string(),
  latencyMs: z.number().int().nonnegative(),
  tokenUsage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }),
});

export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelopeSchema>;