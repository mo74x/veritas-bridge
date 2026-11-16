export interface EvalGateThresholds {
  minSchemaValidityRate: number;      // Must be 100% (enforced via JSON repair + Zod)
  minExactFieldMatchRate: number;     // >= 98.0% across all golden edge cases
  maxHallucinationRate: number;       // 0.0% tolerance on fabricated numbers/IDs
  maxQuarantineEscapeRate: number;    // 0.0% tolerance on bad/adversarial rows auto-syncing
  maxP95LatencyMs: number;            // <= 1800ms per record
  maxCostPer1kRecordsUsd: number;     // <= $1.50 per 1,000 synced rows
}

export const PRODUCTION_CI_GATES: EvalGateThresholds = {
  minSchemaValidityRate: 1.0,
  minExactFieldMatchRate: 0.98,
  maxHallucinationRate: 0.0,
  maxQuarantineEscapeRate: 0.0,
  maxP95LatencyMs: 1800,
  maxCostPer1kRecordsUsd: 1.50,
};