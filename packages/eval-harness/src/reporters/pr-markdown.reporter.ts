import { EvalGateThresholds } from '../gate.config';
import { EvalRunSummary } from '../runner'

export interface BaselineMetrics {
  schemaValidityRate: number;
  exactFieldMatchRate: number;
  hallucinationRate: number;
  quarantineEscapeRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costPer1kRecordsUsd: number;
}

export function generatePrMarkdownReport(
  summary: EvalRunSummary,
  baseline: BaselineMetrics,
  gates: EvalGateThresholds,
): string {
  const m = summary.metrics;
  const statusBadge = summary.passed ? 'PASSED' : 'FAILED';

  const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const fmtDeltaPct = (curr: number, base: number) => {
    const diff = (curr - base) * 100;
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%`;
  };

  const rows = [
    `| **Schema Validity Rate** | ${fmtPct(baseline.schemaValidityRate)} | **${fmtPct(m.schemaValidityRate)}** | ${fmtDeltaPct(m.schemaValidityRate, baseline.schemaValidityRate)} | >= ${fmtPct(gates.minSchemaValidityRate)} | ${m.schemaValidityRate >= gates.minSchemaValidityRate ? 'PASS' : 'FAIL'} |`,
    `| **Exact Field Match (Golden)** | ${fmtPct(baseline.exactFieldMatchRate)} | **${fmtPct(m.exactFieldMatchRate)}** | ${fmtDeltaPct(m.exactFieldMatchRate, baseline.exactFieldMatchRate)} | >= ${fmtPct(gates.minExactFieldMatchRate)} | ${m.exactFieldMatchRate >= gates.minExactFieldMatchRate ? 'PASS' : 'FAIL'} |`,
    `| **Hallucination Rate** | ${fmtPct(baseline.hallucinationRate)} | **${fmtPct(m.hallucinationRate)}** | ${fmtDeltaPct(m.hallucinationRate, baseline.hallucinationRate)} | <= ${fmtPct(gates.maxHallucinationRate)} | ${m.hallucinationRate <= gates.maxHallucinationRate ? 'PASS' : 'FAIL'} |`,
    `| **Quarantine Escape Rate** | ${fmtPct(baseline.quarantineEscapeRate)} | **${fmtPct(m.quarantineEscapeRate)}** | ${fmtDeltaPct(m.quarantineEscapeRate, baseline.quarantineEscapeRate)} | <= ${fmtPct(gates.maxQuarantineEscapeRate)} | ${m.quarantineEscapeRate <= gates.maxQuarantineEscapeRate ? 'PASS' : 'FAIL'} |`,
    `| **Latency (p50 / p95)** | ${baseline.p50LatencyMs}ms / ${baseline.p95LatencyMs}ms | **${m.p50LatencyMs}ms / ${m.p95LatencyMs}ms** | ${m.p95LatencyMs - baseline.p95LatencyMs >= 0 ? '+' : ''}${m.p95LatencyMs - baseline.p95LatencyMs}ms (p95) | <= ${gates.maxP95LatencyMs}ms | ${m.p95LatencyMs <= gates.maxP95LatencyMs ? 'PASS' : 'FAIL'} |`,
    `| **Est. Cost / 1k Rows** | $${baseline.costPer1kRecordsUsd.toFixed(4)} | **$${m.costPer1kRecordsUsd.toFixed(4)}** | $${(m.costPer1kRecordsUsd - baseline.costPer1kRecordsUsd).toFixed(4)} | <= $${gates.maxCostPer1kRecordsUsd.toFixed(2)} | ${m.costPer1kRecordsUsd <= gates.maxCostPer1kRecordsUsd ? 'PASS' : 'FAIL'} |`,
  ];

  let md = `### Veritas Bridge — LLM Evaluation & Regression Gate (${statusBadge})\n\n`;
  md += `- **Prompt Hash:** \`${summary.promptHash}\`\n`;
  md += `- **Fixtures Evaluated:** ${summary.totalCases} (${summary.goldenCases} golden edge cases, ${summary.adversarialCases} adversarial/quarantine cases)\n\n`;
  md += `| Metric | Main Baseline | Current PR | Delta | CI Gate | Status |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;
  md += rows.join('\n') + '\n';

  if (summary.failures.length > 0) {
    md += `\n#### Gate Violations\n`;
    for (const failure of summary.failures) {
      md += `- ${failure}\n`;
    }
  }

  return md;
}