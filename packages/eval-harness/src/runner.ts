import { CanonicalOrderRecord, LegacyRawRow, LegacyRawRowSchema } from '@veritas/contracts';
import { ExtractionAgentService, getPromptHash } from '@veritas/extraction-agent';
import * as fs from 'fs';
import * as path from 'path';
import baseline from './baseline.json';
import { PRODUCTION_CI_GATES } from './gate.config';
import { gradeDeterministic } from './graders/deterministic.grader';
import { gradeFaithfulnessAndHallucination } from './graders/llm-judge.grader';
import { printConsoleReport } from './reporters/console.reporter';
import { generatePrMarkdownReport } from './reporters/pr-markdown.reporter';

interface EvalFixture {
  id: string;
  category: string;
  mustQuarantine: boolean;
  expectedFlag?: string;
  input: LegacyRawRow;
  expected?: CanonicalOrderRecord;
}

export interface EvalRunSummary {
  passed: boolean;
  promptHash: string;
  totalCases: number;
  goldenCases: number;
  adversarialCases: number;
  metrics: {
    schemaValidityRate: number;
    exactFieldMatchRate: number;
    hallucinationRate: number;
    quarantineEscapeRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    costPer1kRecordsUsd: number;
  };
  failures: string[];
}

function loadJsonlFixtures(filePath: string): EvalFixture[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as EvalFixture;
      LegacyRawRowSchema.parse(parsed.input);
      return parsed;
    });
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))] ?? 0;
}

async function runEvaluation(): Promise<void> {
  const datasetsDir = path.resolve(__dirname, '../datasets');
  const goldenFixtures = loadJsonlFixtures(path.join(datasetsDir, 'golden-legacy-rows.jsonl'));
  const adversarialFixtures = loadJsonlFixtures(
    path.join(datasetsDir, 'adversarial-injections.jsonl'),
  );
  const allFixtures = [...goldenFixtures, ...adversarialFixtures];

  const agent = new ExtractionAgentService();
  const latencies: number[] = [];
  let totalCostUsd = 0;
  let schemaValidCount = 0;
  let goldenExactMatchCount = 0;
  let hallucinationCount = 0;
  let quarantineEscapeCount = 0;
  const caseErrors: string[] = [];

  await Promise.all(
    allFixtures.map(async (fixture) => {
      const envelope = await agent.extractRow(fixture.input);
      latencies.push(envelope.latencyMs);
      totalCostUsd += envelope.tokenUsage.estimatedCostUsd;

      const detGrade = gradeDeterministic(envelope, fixture.expected, fixture.mustQuarantine);
      const judgeGrade = await gradeFaithfulnessAndHallucination(fixture.input, envelope);

      if (detGrade.schemaValid) schemaValidCount += 1;
      if (!fixture.mustQuarantine && detGrade.exactMatch) goldenExactMatchCount += 1;
      if (judgeGrade.hallucinated) hallucinationCount += 1;
      if (detGrade.quarantineEscaped) quarantineEscapeCount += 1;

      if (!detGrade.exactMatch || judgeGrade.hallucinated) {
        caseErrors.push(
          `[${fixture.id}] ${detGrade.fieldMismatches.join('; ')} ${judgeGrade.hallucinated ? judgeGrade.rationale : ''}`.trim(),
        );
      }
    }),
  );

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const metrics = {
    schemaValidityRate: schemaValidCount / allFixtures.length,
    exactFieldMatchRate: goldenExactMatchCount / Math.max(1, goldenFixtures.length),
    hallucinationRate: hallucinationCount / allFixtures.length,
    quarantineEscapeRate: quarantineEscapeCount / Math.max(1, adversarialFixtures.length),
    p50LatencyMs: percentile(sortedLatencies, 50),
    p95LatencyMs: percentile(sortedLatencies, 95),
    costPer1kRecordsUsd: (totalCostUsd / allFixtures.length) * 1000,
  };

  const failures: string[] = [...caseErrors];
  if (metrics.schemaValidityRate < PRODUCTION_CI_GATES.minSchemaValidityRate) {
    failures.push(`Schema validity rate ${metrics.schemaValidityRate} below threshold.`);
  }
  if (metrics.exactFieldMatchRate < PRODUCTION_CI_GATES.minExactFieldMatchRate) {
    failures.push(`Exact field match rate ${metrics.exactFieldMatchRate} below threshold.`);
  }
  if (metrics.hallucinationRate > PRODUCTION_CI_GATES.maxHallucinationRate) {
    failures.push(`Hallucination rate ${metrics.hallucinationRate} exceeded 0.0%.`);
  }
  if (metrics.quarantineEscapeRate > PRODUCTION_CI_GATES.maxQuarantineEscapeRate) {
    failures.push(`Quarantine escape rate ${metrics.quarantineEscapeRate} exceeded 0.0%.`);
  }
  if (metrics.p95LatencyMs > PRODUCTION_CI_GATES.maxP95LatencyMs) {
    failures.push(`p95 latency ${metrics.p95LatencyMs}ms exceeded ${PRODUCTION_CI_GATES.maxP95LatencyMs}ms.`);
  }
  if (metrics.costPer1kRecordsUsd > PRODUCTION_CI_GATES.maxCostPer1kRecordsUsd) {
    failures.push(`Cost per 1k records $${metrics.costPer1kRecordsUsd.toFixed(4)} exceeded budget.`);
  }

  const summary: EvalRunSummary = {
    passed: failures.length === 0,
    promptHash: getPromptHash(),
    totalCases: allFixtures.length,
    goldenCases: goldenFixtures.length,
    adversarialCases: adversarialFixtures.length,
    metrics,
    failures,
  };

  printConsoleReport(summary);

  const markdownReport = generatePrMarkdownReport(summary, baseline, PRODUCTION_CI_GATES);
  const reportOutputPath = path.resolve(process.cwd(), 'eval-scorecard.md');
  fs.writeFileSync(reportOutputPath, markdownReport, 'utf-8');

  if (!summary.passed) {
    process.exit(1);
  }
}

void runEvaluation();
