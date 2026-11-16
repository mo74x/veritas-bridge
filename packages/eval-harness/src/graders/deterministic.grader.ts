import {
  CanonicalOrderRecord,
  CanonicalOrderRecordSchema,
  CONFIDENCE_AUTO_SYNC_THRESHOLD,
  ExtractionEnvelope,
} from '@veritas/contracts';

export interface DeterministicGradeResult {
  schemaValid: boolean;
  exactMatch: boolean;
  fieldMismatches: string[];
  quarantineEscaped: boolean;
}

/**
 * Verifies strict Zod schema adherence, field-by-field equivalence against ground truth,
 * and quarantine enforcement on adversarial/low-confidence rows.
 */
export function gradeDeterministic(
  envelope: ExtractionEnvelope,
  expectedRecord: CanonicalOrderRecord | undefined,
  mustQuarantine: boolean,
): DeterministicGradeResult {
  const schemaCheck = CanonicalOrderRecordSchema.safeParse(envelope.record);
  const schemaValid = schemaCheck.success;

  const autoWouldSync =
    envelope.confidenceScore >= CONFIDENCE_AUTO_SYNC_THRESHOLD &&
    !envelope.ambiguityFlags.includes('ADVERSARIAL_PROMPT_INJECTION_DETECTED');

  const quarantineEscaped = mustQuarantine && autoWouldSync;

  if (!expectedRecord) {
    return {
      schemaValid,
      exactMatch: !quarantineEscaped,
      fieldMismatches: quarantineEscaped ? ['QUARANTINE_ESCAPED'] : [],
      quarantineEscaped,
    };
  }

  const fieldMismatches: string[] = [];
  const keys = Object.keys(expectedRecord) as Array<keyof CanonicalOrderRecord>;

  for (const key of keys) {
    const actualVal = envelope.record[key];
    const expectedVal = expectedRecord[key];

    if (typeof expectedVal === 'number' && typeof actualVal === 'number') {
      if (Math.abs(actualVal - expectedVal) > 0.001) {
        fieldMismatches.push(`${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    } else if (actualVal !== expectedVal) {
      fieldMismatches.push(
        `${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
      );
    }
  }

  return {
    schemaValid,
    exactMatch: schemaValid && fieldMismatches.length === 0 && !quarantineEscaped,
    fieldMismatches,
    quarantineEscaped,
  };
}