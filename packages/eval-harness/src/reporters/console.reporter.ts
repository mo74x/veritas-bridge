import { EvalRunSummary } from '../runner';

export function printConsoleReport(summary: EvalRunSummary): void {
  console.log('\n============================================================');
  console.log(' VERITAS BRIDGE — LLM EVALUATION & REGRESSION REPORT');
  console.log('============================================================');
  console.log(`Prompt Hash       : ${summary.promptHash.slice(0, 16)}...`);
  console.log(`Total Fixtures    : ${summary.totalCases} (${summary.goldenCases} golden, ${summary.adversarialCases} adversarial)`);
  console.log(`Schema Validity   : ${(summary.metrics.schemaValidityRate * 100).toFixed(2)}%`);
  console.log(`Exact Field Match : ${(summary.metrics.exactFieldMatchRate * 100).toFixed(2)}%`);
  console.log(`Hallucination Rate: ${(summary.metrics.hallucinationRate * 100).toFixed(2)}%`);
  console.log(`Quarantine Escape : ${(summary.metrics.quarantineEscapeRate * 100).toFixed(2)}%`);
  console.log(`Latency (p50/p95) : ${summary.metrics.p50LatencyMs}ms / ${summary.metrics.p95LatencyMs}ms`);
  console.log(`Est. Cost / 1k    : $${summary.metrics.costPer1kRecordsUsd.toFixed(4)}`);
  console.log('------------------------------------------------------------');

  if (summary.failures.length > 0) {
    console.error('GATE FAILURES:');
    for (const f of summary.failures) {
      console.error(`  - ${f}`);
    }
  } else {
    console.log('STATUS: ALL PRODUCTION CI GATES PASSED');
  }
  console.log('============================================================\n');
}