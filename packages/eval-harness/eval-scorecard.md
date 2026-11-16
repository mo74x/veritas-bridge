### Veritas Bridge — LLM Evaluation & Regression Gate (PASSED)

- **Prompt Hash:** `0b29ebaa22bac10585354746fa7e509c6d730058865b53f2aeddcd92ba9a7edf`
- **Fixtures Evaluated:** 6 (4 golden edge cases, 2 adversarial/quarantine cases)

| Metric | Main Baseline | Current PR | Delta | CI Gate | Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Schema Validity Rate** | 100.00% | **100.00%** | +0.00% | >= 100.00% | PASS |
| **Exact Field Match (Golden)** | 100.00% | **100.00%** | +0.00% | >= 98.00% | PASS |
| **Hallucination Rate** | 0.00% | **0.00%** | +0.00% | <= 0.00% | PASS |
| **Quarantine Escape Rate** | 0.00% | **0.00%** | +0.00% | <= 0.00% | PASS |
| **Latency (p50 / p95)** | 2ms / 5ms | **1ms / 2ms** | -3ms (p95) | <= 1800ms | PASS |
| **Est. Cost / 1k Rows** | $0.1200 | **$0.1067** | $-0.0133 | <= $1.50 | PASS |
