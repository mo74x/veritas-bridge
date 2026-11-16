# Veritas Bridge — Token Economics & Operational ROI Model

## 1. Baseline Manual Workflow vs. Veritas Bridge

| Operational Metric | Legacy Manual Workflow | Veritas Bridge (Hybrid Pipeline) | Delta / Impact |
| :--- | :--- | :--- | :--- |
| **Daily Batch Volume** | 1,000 rows / business day (~22,000 / month) | 1,000 rows / business day (~22,000 / month) | Same throughput capacity |
| **Processing Time** | 4.0 hours / batch (manual cleanup & entry) | ~1.2 seconds / record (parallel BullMQ workers) | **> 99% latency reduction** |
| **Monthly Labor Effort** | ~88 hours / month @ $50/hr loaded ops cost | ~4 hours / month (quarantine exception review) | **84 hours/month reclaimed** |
| **Gross Monthly Cost** | $4,400 / month ($52,800 / year) | ~$200 / month labor + ~$26.40 / month LLM spend | **$4,173.60 / month saved** |
| **Annualized Net Savings** | Baseline | **$48,000+ / year net savings** (after infra) | **< 1 month payback period** |

---

## 2. Unit Token Economics (`gpt-4o-mini` Pricing Tier)

- **Pricing Assumptions:** `$0.15 / 1M` input tokens and `$0.60 / 1M` output tokens.
- **Average LLM Path Payload:** ~310 prompt tokens + ~135 completion tokens per messy row.
- **Cost per LLM-Extracted Row:**
  $$\left(\frac{310}{1,000,000} \times \$0.15\right) + \left(\frac{135}{1,000,000} \times \$0.60\right) = \$0.0000465 + \$0.0000810 = \$0.0001275 \text{ (raw model)}$$
- **Blended Production Budget (including judge & retry headroom):** Capped at **$0.0012 per row** (`$1.20 per 1,000 rows`), enforced by `PRODUCTION_CI_GATES.maxCostPer1kRecordsUsd = 1.50`.
- **Deterministic Fast-Path Multiplier:** Clean rows matching `CanonicalOrderRecordSchema` execute in `< 5ms` at **$0.00 token cost**, reducing total monthly LLM spend proportionally to clean-data share.