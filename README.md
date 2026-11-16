# Veritas Bridge

**Hybrid confidence-gated data synchronization pipeline** that normalizes messy, bilingual (Arabic/English) legacy ERP exports and spreadsheets into modern CRM/ERP APIs—combining a zero-cost deterministic fast-path, a structured LLM extraction agent, human-in-the-loop quarantine, and a SHA-256 hash-chained PostgreSQL audit ledger.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Legacy["Legacy Data Sources"]
        CSV["Legacy ERP CSV / SFTP"]
        Sheets["Google Sheets Manifests"]
        SQL["Aging On-Prem SQL (CDC)"]
    end

    subgraph BridgeAPI["apps/bridge-api (NestJS + Prisma 7 + BullMQ + Redis)"]
        Ingest["POST /ingest/rows"]
        Lock["Redis Distributed Lock (45s TTL)\n& Recursive SHA-256 Idempotency"]
        Queue["BullMQ: raw-mutation-queue"]
        Router{"Confidence >= 0.92\n& No Injection Flag?"}
        CRM["Downstream CRM Client\n(HttpModernCrmClient / Dev Fallback)"]
        Quarantine["Quarantine Queue\n(GET /quarantine, POST /approve)"]
        Ledger[("PostgreSQL 16 (Prisma 7)\nSyncAuditLedger Hash Chain\n(previousHash + currentHash + parentAuditId)")]
    end

    subgraph SharedCore["packages/extraction-agent"]
        FastPath["1. Deterministic Fast-Path (< 5ms, $0)"]
        LLM["2. Structured LLM (15s timeout)"]
        Sanitizer["3. Deterministic JSON Sanitizer"]
        ZodGate["4. @veritas/contracts Zod Gate"]
    end

    subgraph EvalCI["packages/eval-harness (GitHub Actions CI Gate)"]
        Fixtures["Golden & Adversarial JSONL"]
        Graders["Deterministic + LLM-Judge Graders"]
        PRGate["PR Scorecard & Release Gates"]
    end

    CSV & Sheets & SQL --> Ingest --> Lock --> Queue --> FastPath
    FastPath -- "Valid Canonical Row" --> ZodGate
    FastPath -- "Messy / Bilingual Row" --> LLM --> Sanitizer --> ZodGate
    ZodGate --> Router
    Router -- "Yes (>= 0.92)" --> CRM
    Router -- "No (< 0.92 or Injection)" --> Quarantine
    CRM -- "Before/After Snapshots" --> Ledger
    Quarantine -- "Idempotent Override" --> CRM
    Quarantine -- "parentAuditId Link" --> Ledger

    Fixtures --> FastPath
    ZodGate -. "CI Evaluation" .-> Graders --> PRGate
```

---

## Worker Error Routing & State Transitions

```mermaid
flowchart TD
    Job["BullMQ Job (LegacyRawRow)"] --> Lock{"RedisLockService.acquireLock\n(TTL 45s)"}
    Lock -- "Contended (null)" --> RetryLock["Throw LockContentionError\n(BullMQ retries with backoff)"]
    Lock -- "Acquired" --> Idem{"SyncAuditLedger\nfindUnique(idempotencyKey)"}
    Idem -- "Exists" --> Skip["Skip (Already Processed)"]
    Idem -- "New" --> Extract["ExtractionAgentService.extractRow\n(15s timeout)"]

    Extract -- "SyntaxError / ZodError" --> QSchema["Append QUARANTINED_SCHEMA_FAILURE\n(Complete Job)"]
    Extract -- "TransientLLMError (429/5xx)" --> RetryErr["Rethrow for BullMQ Retry"]
    Extract -- "Confidence < 0.92 or Injection" --> QConf["Append QUARANTINED_LOW_CONFIDENCE\n(Complete Job)"]
    Extract -- "High Confidence" --> CRM["DownstreamCrmPort.upsertOrder\n(Idempotency-Key, 10s timeout)"]

    CRM -- "Permanent 4xx" --> FailDB["Append FAILED_DOWNSTREAM_API\n(Complete Job)"]
    CRM -- "Transient 408/429/5xx" --> Final{"attemptsMade + 1 >= max?"}
    Final -- "No" --> RetryErr
    Final -- "Yes" --> FailExhaust["Append FAILED_DOWNSTREAM_API\n& Rethrow"]
    CRM -- "200 / 201" --> Synced["Append SYNCED\n(Serializable + P2034/40001 retry)"]
```

---

## Monorepo Structure

| Package / App | Role | Key Technologies |
| :--- | :--- | :--- |
| [`apps/bridge-api`](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/apps/bridge-api) | NestJS API, BullMQ sync worker, Redis locks, Prisma 7 audit ledger, HTTP CRM connector | NestJS 10, BullMQ 5, ioredis, Prisma 7 (`@prisma/adapter-pg`), Vitest |
| [`packages/contracts`](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/packages/contracts) | Shared Zod schemas (`LegacyRawRowSchema`, `CanonicalOrderRecordSchema`, `ExtractionEnvelopeSchema`) | TypeScript, Zod |
| [`packages/extraction-agent`](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/packages/extraction-agent) | Hybrid deterministic fast-path + structured LLM normalizer + JSON repair sanitizer | TypeScript, Zod, `fetch` (`AbortSignal.timeout`) |
| [`packages/eval-harness`](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/packages/eval-harness) | CI regression runner with golden + adversarial JSONL datasets and release gates | ts-node, deterministic & LLM-judge graders |
| [`docs/executive-handoff`](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/docs/executive-handoff) | Architecture Decision Record (`ADR-001`) and unit token economics (`roi-cost-model.md`) | Markdown, Mermaid |

---

## API Endpoints (`apps/bridge-api`)

| Method & Path | Description |
| :--- | :--- |
| `POST /ingest/rows` | Validates a batch of `LegacyRawRow` payloads and enqueues jobs onto `raw-mutation-queue` (3 attempts, exponential backoff). |
| `GET /quarantine` | Lists unresolved `QUARANTINED_LOW_CONFIDENCE` and `QUARANTINED_SCHEMA_FAILURE` entries (excluding entries with a resolved `SYNCED` / `ROLLED_BACK` child). |
| `POST /quarantine/:auditId/approve` | Validates a corrected `CanonicalOrderRecord`, acquires a Redis lock (`override:<auditId>`), idempotently upserts to the CRM, and appends a `SYNCED` child linked via `parentAuditId`. |
| `GET /audit` | Returns the latest 50 entries from `SyncAuditLedger`. |
| `GET /audit/verify` | Walks the entire SHA-256 hash chain in 500-row cursor batches to verify tamper-evidence. |
| `POST /audit/:id/rollback` | Acquires a Redis lock (`rollback:<id>`), verifies no prior rollback exists, restores `beforeState` via `If-Match` or pre-rollback drift check, and appends a `ROLLED_BACK` child. |

---

## Reliability, Security & Audit Guarantees

- **Deterministic Idempotency:** `canonicalizeJson` recursively sorts object keys at all nesting levels before SHA-256 hashing (`sourceSystem + sourceRecordId + canonicalPayload`). Operator overrides (`OVERRIDE:...`) and rollbacks (`ROLLBACK:...`) use deterministic keys and `parentAuditId` links instead of timestamps.
- **Tamper-Evident Hash Chain:** `SyncAuditLedger` links `previousHash` -> `currentHash` inside `Serializable` PostgreSQL transactions with bounded retries (`P2034` / `40001`), hashing payload, snapshots, actor, target ID, and confidence score.
- **Production Fail-Fast Guardrails:** When `NODE_ENV=production`, startup fails fast if `CRM_BASE_URL`, `CRM_API_TOKEN`, or `LLM_API_KEY` is missing—preventing silent fallback to in-memory or heuristic stubs.
- **Timeout & Lock Alignment:** `15s` LLM timeout + `10s` CRM HTTP timeout sit safely inside the `45s` Redis lock TTL.

---

## Economics & CI Quality Gates

From [ADR-001](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/docs/executive-handoff/ADR-001-hybrid-sync-architecture.md) and [roi-cost-model.md](file:///c:/Users/3rafa/Desktop/projects/veritas-bridge/docs/executive-handoff/roi-cost-model.md):

| Metric | Legacy Manual Workflow | Veritas Bridge (Hybrid Pipeline) |
| :--- | :--- | :--- |
| **Processing Latency** | ~4.0 hours / batch | **~1.2s / record** (`< 5ms` on deterministic fast-path) |
| **Blended AI Cost** | N/A | **\$0.0012 / row** capped (`\$0.00` on fast-path) |
| **Annualized Savings** | Baseline (\$52,800/yr) | **\$48,000+ / year net savings** |
| **CI Release Gates** | Manual spot checks | `>= 98.0%` exact match, `0.0%` hallucination, `0.0%` quarantine escape |

---

## Quickstart

### 1. Prerequisites
- Node.js 20+ & `pnpm@9.12.0`
- PostgreSQL 16 & Redis 7 (via `docker compose up -d` or local services like DBngin)

### 2. Install & Start Infrastructure
```powershell
pnpm install
pnpm infra:up
```

### 3. Configure Environment (`apps/bridge-api/.env`)
| Variable | Default / Example | Required in Prod |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://veritas:veritas_secret_password@localhost:5432/veritas_bridge?schema=public` | Yes |
| `REDIS_HOST` | `localhost` | Yes |
| `REDIS_PORT` | `6379` | Yes |
| `PORT` | `3000` | No |
| `LLM_API_KEY` | OpenAI-compatible API key (heuristic fallback in dev/CI when unset) | Yes |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | No |
| `LLM_MODEL_VERSION` | `gpt-4o-mini-2024-07-18` | No |
| `CRM_BASE_URL` | Target CRM base URL (in-memory fallback in `test`/`development` when unset) | Yes |
| `CRM_API_TOKEN` | Bearer token for `HttpModernCrmClient` | Yes |

### 4. Migrate, Build & Verify
```powershell
pnpm db:migrate
pnpm build
pnpm typecheck
pnpm test
pnpm eval:ci
```

### 5. Run in Development
```powershell
pnpm dev
```
