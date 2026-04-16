# hindsight-cf

A TypeScript port of [**hindsight**](https://github.com/vectorize-io/hindsight) to Cloudflare Workers, built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

[Hindsight](https://github.com/vectorize-io/hindsight) is an open-source AI agent memory system created by [Vectorize](https://vectorize.io). It gives LLM agents persistent, structured memory — enabling them to retain facts, recall relevant context, and reflect over accumulated knowledge. This port brings hindsight's full API to Cloudflare's edge infrastructure, replacing the original Python/FastAPI/PostgreSQL stack with TypeScript, Hono, D1, Vectorize, and Workers AI.

For full details on hindsight's memory model, architecture, and concepts (memory banks, disposition traits, directives, mental models, entity graphs, etc.), see the [original hindsight repository](https://github.com/vectorize-io/hindsight).

## Architecture

| Component | Original (hindsight) | This Port (hindsight-cf) |
|---|---|---|
| Language | Python | **TypeScript** |
| HTTP framework | FastAPI | **Hono** on Cloudflare Workers |
| Relational storage | PostgreSQL | **D1** (SQLite at the edge) |
| Vector search | pgvector | **Vectorize** |
| Full-text search | PostgreSQL tsvector | **D1 FTS5** |
| Embeddings | External API | **Workers AI** (`@cf/baai/bge-m3`) |
| Reranking | External API | **Workers AI** (`@cf/baai/bge-reranker-base`) |
| LLM | External API | **Workers AI** (default) or external API |
| Object storage | Local / S3 | **R2** |
| Background jobs | Celery / threads | **Queues** |

## Getting Started

Follow these steps from scratch. Every command is copy-pasteable.

### Step 1 — Install prerequisites

You need **Node.js** (>= 18) and **npm**. Node.js is only required for local development and the build toolchain — it does not run in production.

Check if you already have them:

```sh
node --version   # should print v18.x or higher
npm --version    # should print 9.x or higher
```

If not installed, download from [nodejs.org](https://nodejs.org/) (the LTS version is fine) or use a version manager like [nvm](https://github.com/nvm-sh/nvm):

```sh
# Option: install via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
```

### Step 2 — Create a Cloudflare account

If you don't already have one, sign up for a free account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).

The free tier includes Workers, D1, R2, Queues, Workers AI, and Vectorize — everything this project uses.

### Step 3 — Clone the repository

```sh
git clone https://github.com/enzinas/hindsight-cf.git
cd hindsight-cf
```

### Step 4 — Install dependencies

```sh
npm install
```

This installs the Hono framework, Wrangler CLI, TypeScript compiler, and all other dependencies.

### Step 5 — Log in to Cloudflare

```sh
npx wrangler login
```

This opens your browser. Authorize Wrangler to access your Cloudflare account. Once complete, the terminal will confirm you're logged in.

### Step 6 — Create Cloudflare resources

Run each command below. Each one creates a resource in your Cloudflare account and prints an ID. **Save the D1 database ID** — you'll need it in the next step.

```sh
# Create the D1 database (save the ID from the output!)
npx wrangler d1 create hindsight-db
```

You'll see output like:

```
✅ Successfully created DB 'hindsight-db'

[[d1_databases]]
binding = "DB"
database_name = "hindsight-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   <-- copy this
```

Now create the remaining resources:

```sh
# Create the Vectorize index (1024 dimensions for bge-m3, cosine similarity)
npx wrangler vectorize create hindsight-vectors --dimensions=1024 --metric=cosine

# Create the R2 storage bucket
npx wrangler r2 bucket create hindsight-files

# Create the job queue and its dead-letter queue
npx wrangler queues create hindsight-jobs
npx wrangler queues create hindsight-jobs-dlq
```

### Step 7 — Update wrangler.toml with your database ID

Open `wrangler.toml` and replace the placeholder `database_id` with the actual ID from Step 6:

```sh
# On macOS/Linux — replace the placeholder in one command:
sed -i.bak 's/TODO-replace-with-actual-id/YOUR_ACTUAL_DATABASE_ID/' wrangler.toml
```

Or open `wrangler.toml` in your editor and change this line:

```toml
database_id = "TODO-replace-with-actual-id"
```

to:

```toml
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # your actual ID
```

### Step 8 — Run database migrations

Apply the schema to your D1 database. This runs three migrations: the initial schema (tables, FTS5, triggers), the `api_keys` table for multi-tenant auth, and the webhooks/audit-logs tables.

```sh
# For local development
npm run db:migrate

# For production (remote D1)
npm run db:migrate:remote
```

### Step 9 — Verify locally

Start the local dev server:

```sh
npm run dev
```

The server starts at `http://localhost:8787`. Test it:

```sh
# Health check
curl http://localhost:8787/health
# → {"status":"ok"}

# Version info
curl http://localhost:8787/version
# → {"version":"0.1.0","runtime":"cloudflare-workers",...}

# Create a bank and get its profile (banks auto-create on first access)
curl http://localhost:8787/v1/default/banks/my-agent/profile
# → {"bank_id":"my-agent","name":"my-agent","disposition":{...},...}
```

Run the test suite:

```sh
npm run test
```

All 158 tests should pass, including the API compatibility suite that verifies route parity with the original hindsight API.

### Step 10 — Deploy to production

```sh
npm run deploy
```

Wrangler builds the TypeScript, uploads the Worker, and connects it to your D1, Vectorize, R2, and Queue resources. On success it prints your Worker's URL:

```
Published hindsight-cf (x.xx sec)
  https://hindsight-cf.<your-subdomain>.workers.dev
```

Apply the database schema to your production D1:

```sh
npm run db:migrate:remote
```

Verify the deployment:

```sh
curl https://hindsight-cf.<your-subdomain>.workers.dev/health
# → {"status":"ok"}
```

Your hindsight-cf instance is now live on Cloudflare's edge network.

## Development

### Useful commands

```sh
npm run dev              # Start local dev server (http://localhost:8787)
npm run test             # Run all 158 tests
npm run test:watch       # Run tests in watch mode
npm run typecheck        # TypeScript type checking
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format
npm run format:check     # Prettier check (CI-friendly)
npm run check            # All-in-one: format + lint + typecheck + tests
npm run db:migrate       # Apply migrations to local D1
npm run db:migrate:remote # Apply migrations to production D1
npm run deploy           # Deploy to Cloudflare Workers
```

### Custom domain (optional)

To use your own domain instead of `*.workers.dev`, add a custom domain in the [Cloudflare dashboard](https://dash.cloudflare.com/) under Workers & Pages > your worker > Settings > Domains & Routes.

## Configuration

### Environment variables (wrangler.toml `[vars]`)

These are set in `wrangler.toml` and can be changed before deploying:

| Variable | Default | Description |
|---|---|---|
| `HINDSIGHT_VERSION` | `0.1.0` | Reported version |
| `DEFAULT_LLM_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Workers AI model for reflect/retain (function calling, reasoning) |
| `DEFAULT_EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model (1024 dims, multilingual) |
| `DEFAULT_RERANKER_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI reranker model |
| `EMBEDDING_DIMENSIONS` | `1024` | Embedding vector dimensions |

### Secrets

```sh
# Set secrets (Wrangler will prompt you to enter the value securely)

# Auth — single global API key (see Authentication section below)
npx wrangler secret put HINDSIGHT_API_KEY

# Optional — metrics: enable Analytics Engine queries for GET /metrics
# (see Metrics section below)
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN

# Optional — external LLM providers (OpenAI, Anthropic, etc.)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EXTERNAL_LLM_BASE_URL
npx wrangler secret put EXTERNAL_LLM_MODEL
```

Secrets are encrypted and only available to your Worker at runtime. They are never stored in your code or `wrangler.toml`.

## Authentication

hindsight-cf supports optional Bearer-token authentication compatible with the [original Hindsight Python client](https://github.com/vectorize-io/hindsight). Clients send an `Authorization: Bearer <token>` header.

There are three auth modes, checked in priority order:

### Mode 1 — Open (default)

No configuration needed. All requests are allowed without authentication. This matches the original Hindsight OSS default where auth is not enforced.

### Mode 2 — Single key

Set one global API key via the `HINDSIGHT_API_KEY` secret. All tenants share this key.

```sh
npx wrangler secret put HINDSIGHT_API_KEY
# Enter your key when prompted
```

Every API request (under `/v1/...`) must include the header:

```
Authorization: Bearer <your-key>
```

Health, version, and metrics endpoints (`/health`, `/version`, `/metrics`) are never auth-gated.

**Error responses:**

| Scenario | Status | Body |
|---|---|---|
| Missing `Authorization` header | `401` | `{"error":"unauthorized","message":"Authorization header is required"}` |
| Non-Bearer scheme (e.g. `Basic`) | `401` | `{"error":"unauthorized","message":"Authorization header must use Bearer scheme"}` |
| Wrong token | `403` | `{"error":"forbidden","message":"Invalid API key"}` |

### Mode 3 — Multi-tenant

For hosting multiple tenants on one deployment, use the D1 `api_keys` table instead of (or in addition to) the env var. Each API key is scoped to a specific tenant.

**URL structure:** `/v1/:tenant/banks/...` — the `:tenant` segment identifies the tenant (e.g. `/v1/acme/banks`, `/v1/default/banks`).

**Setup:**

1. Run the migration (included in `migrations/0002_api_keys.sql`):

```sh
npm run db:migrate          # local
npm run db:migrate:remote   # production
```

2. Insert keys directly into D1:

```sh
# Insert a key for the "acme" tenant
npx wrangler d1 execute hindsight-db --command \
  "INSERT INTO api_keys (id, token, tenant_id, description) VALUES ('key-1', 'sk-acme-secret-token', 'acme', 'Acme production key')"
```

The `api_keys` table schema:

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (PK) | Auto-generated UUID |
| `token` | TEXT (UNIQUE) | The Bearer token value |
| `tenant_id` | TEXT | Tenant this key is scoped to (must match `:tenant` in URL) |
| `description` | TEXT | Human-readable label |
| `created_at` | TEXT | ISO 8601 timestamp (auto-set) |
| `expires_at` | TEXT or NULL | Optional expiry date; expired keys are rejected |

**Behavior:**

- When any rows exist in `api_keys`, auth is enforced for all API routes.
- A valid token for tenant `acme` can only access `/v1/acme/...` — requests to `/v1/beta/...` with an `acme` key return `403`.
- If `HINDSIGHT_API_KEY` (env var) is also set, it takes priority as a global key that works for any tenant.
- If no `Authorization` header is sent and no keys exist in D1, requests pass through (open mode).

**Error responses:**

| Scenario | Status | Body |
|---|---|---|
| Missing header (keys exist in D1) | `401` | `{"error":"unauthorized","message":"Authorization header is required"}` |
| Token not found in D1 | `403` | `{"error":"forbidden","message":"Invalid API key"}` |
| Token expired | `403` | `{"error":"forbidden","message":"API key has expired"}` |
| Token valid but wrong tenant | `403` | `{"error":"forbidden","message":"API key is not authorized for this tenant"}` |

### Client usage

Clients (including the official Hindsight Python SDK) send the key as a Bearer token:

```sh
# curl example
curl -H "Authorization: Bearer sk-acme-secret-token" \
  https://your-worker.workers.dev/v1/acme/banks

# Python client
from hindsight import Hindsight
client = Hindsight(base_url="https://your-worker.workers.dev", api_key="sk-acme-secret-token")
```

### Production recommendation: one deployment per tenant

The original hindsight uses PostgreSQL schemas for hard database-level tenant isolation. hindsight-cf runs on D1 (SQLite), which doesn't support schemas — tenant isolation relies on `WHERE bank_id = ?` filtering in every query rather than a database-level boundary.

For production multi-tenant use, **deploy a separate Worker and D1 database per tenant** instead of using the multi-tenant key table. Cloudflare Workers are cheap to deploy and each gets its own D1 database, Vectorize index, and R2 bucket — providing true infrastructure-level isolation with no risk of cross-tenant data leakage. Use Mode 2 (single key) to secure each deployment.

```
hindsight-acme.your-domain.workers.dev    → acme's D1, Vectorize, R2
hindsight-beta.your-domain.workers.dev    → beta's D1, Vectorize, R2
hindsight-gamma.your-domain.workers.dev   → gamma's D1, Vectorize, R2
```

Mode 3 (multi-tenant keys) is suitable for development, internal tools, or scenarios where tenants share a trust boundary.

## Metrics & Observability

hindsight-cf uses [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) for metrics collection. Every HTTP request and core operation (retain, recall, reflect, consolidate) is automatically instrumented.

**Write path** (automatic, zero-cost): Data points are written to Analytics Engine via the `ANALYTICS` binding on every request. This is fire-and-forget — no `await`, no latency impact. If the binding is missing, writes are silently skipped.

**Read path** (`GET /metrics`): Returns a JSON summary. If `CF_ACCOUNT_ID` and `CF_API_TOKEN` secrets are configured, the response includes Analytics Engine data (HTTP request counts, operation durations, LLM token usage) for the last 24 hours. D1 resource counts (banks, memories, entities, documents) are always included regardless of configuration.

### Setup (optional — metrics work without this, but /metrics returns only D1 counts)

The Analytics Engine dataset (`hindsight_metrics`) is created automatically on first deploy — no `wrangler` command needed. To enable the full `GET /metrics` response with operational data:

1. Create a Cloudflare API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with **Account Analytics:Read** permission.
2. Find your Account ID in the Cloudflare dashboard sidebar (any zone overview page).
3. Set both as secrets:

```sh
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

### Example response

Without Analytics Engine secrets (D1 counts only):

```json
{
  "analytics_engine": false,
  "period": "n/a",
  "http": null,
  "operations": null,
  "llm": null,
  "d1": {
    "banks": 3,
    "memory_units": 1247,
    "entities": 89,
    "documents": 12,
    "async_operations": 5
  }
}
```

With Analytics Engine secrets configured:

```json
{
  "analytics_engine": true,
  "period": "last 24 hours",
  "http": {
    "total_requests": 4821,
    "by_method": { "GET": 3102, "POST": 1580, "DELETE": 139 },
    "by_status": { "200": 4650, "404": 98, "500": 73 },
    "avg_duration_ms": 42
  },
  "operations": {
    "total": 312,
    "by_type": { "retain": 201, "recall": 89, "reflect": 15, "consolidate": 7 },
    "by_status": { "success": 298, "error": 14 },
    "avg_duration_ms": 1850
  },
  "llm": {
    "total_calls": 523,
    "total_input_tokens": 482910,
    "total_output_tokens": 67200,
    "avg_duration_ms": 920
  },
  "d1": {
    "banks": 3,
    "memory_units": 1247,
    "entities": 89,
    "documents": 12,
    "async_operations": 5
  }
}
```

### What's instrumented

| Event | Dimensions | Metrics |
|---|---|---|
| Every HTTP request | method, endpoint (normalized), status code | duration (ms) |
| retain, recall, reflect, consolidate | operation type, bank_id, success/error | duration (ms) |
| LLM calls (planned) | provider, model, success/error | duration (ms), input/output tokens |

Metrics are also visible in the [Cloudflare dashboard](https://dash.cloudflare.com/) under Workers & Pages > Analytics Engine, where you can build custom queries and visualizations.

## API Reference

This port targets 100% route and response-shape compatibility with the [original hindsight API](https://github.com/vectorize-io/hindsight). All core pipelines are implemented. See the [original hindsight documentation](https://github.com/vectorize-io/hindsight) for request/response schemas and usage details.

### Health & Monitoring

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (`{"status":"ok"}`) |
| GET | `/version` | Version info, feature flags, model config |
| GET | `/metrics` | JSON metrics summary (Analytics Engine + D1 counts — see Metrics section) |

### Bank Templates

| Method | Path | Description |
|---|---|---|
| GET | `/v1/bank-template-schema` | Get JSON Schema for bank template manifests (global, not tenant-scoped) |
| GET | `.../export` | Export bank template (memories, entities, directives, documents) |
| POST | `.../import` | Import bank template (supports `?dry_run=true` for validation-only) |

### Memory Operations

| Method | Path | Description |
|---|---|---|
| POST | `.../memories` | **Retain** — ingest content, extract facts, generate embeddings, resolve entities |
| POST | `.../memories/recall` | **Recall** — vector search + FTS5 + graph retrieval + reranking + fusion |
| POST | `.../reflect` | **Reflect** — agentic LLM loop with tool use over memory |
| GET | `.../memories/list` | List memory units (paginated, filterable by type) |
| GET | `.../memories/{id}` | Get a single memory unit |
| GET | `.../memories/{id}/history` | Get memory version history |
| DELETE | `.../memories/{id}` | Delete a memory unit (+ Vectorize cleanup) |
| DELETE | `.../memories/{id}/observations` | Delete observations linked to a memory |
| DELETE | `.../memories` | Clear all memories (optionally filtered by `?type=`) |

### Banks

| Method | Path | Description |
|---|---|---|
| GET | `/v1/{tenant}/banks` | List all banks (returns full bank objects) |
| POST | `/v1/{tenant}/banks` | Create bank (409 on conflict) |
| PUT | `.../banks/{bank_id}` | Update bank (returns updated bank object) |
| PATCH | `.../banks/{bank_id}` | Partial update bank (returns updated bank object) |
| DELETE | `.../banks/{bank_id}` | Delete bank (+ Vectorize cleanup) |
| GET | `.../banks/{bank_id}/profile` | Get bank profile |
| PUT | `.../banks/{bank_id}/profile` | Update full profile (disposition + mission) |
| PUT | `.../banks/{bank_id}/profile/disposition` | Update disposition traits |
| PUT | `.../banks/{bank_id}/profile/mission` | Set mission |
| POST | `.../banks/{bank_id}/background` | Merge background into mission |
| GET | `.../banks/{bank_id}/stats` | Bank statistics |
| GET | `.../banks/{bank_id}/config` | Get bank config (`{config, overrides}`) |
| PATCH | `.../banks/{bank_id}/config` | Update config overrides (merge) |
| DELETE | `.../banks/{bank_id}/config` | Reset config overrides to defaults |

### Entities

| Method | Path | Description |
|---|---|---|
| GET | `.../entities` | List entities (sorted by mention count) |
| GET | `.../entities/{id}` | Get entity detail with observations |
| POST | `.../entities/{id}/regenerate` | Regenerate entity summary via LLM |

### Documents & Chunks

| Method | Path | Description |
|---|---|---|
| GET | `.../documents` | List documents |
| GET | `.../documents/{id}` | Get document |
| PATCH | `.../documents/{id}` | Update document metadata (merge) |
| DELETE | `.../documents/{id}` | Delete document (+ memory units + Vectorize cleanup) |
| GET | `/v1/{tenant}/chunks/{id}` | Get chunk (top-level, not bank-scoped) |

### Directives

| Method | Path | Description |
|---|---|---|
| GET | `.../directives` | List directives |
| POST | `.../directives` | Create directive |
| GET | `.../directives/{id}` | Get directive |
| PATCH | `.../directives/{id}` | Update directive |
| DELETE | `.../directives/{id}` | Delete directive |

### Mental Models

| Method | Path | Description |
|---|---|---|
| GET | `.../mental-models` | List mental models |
| POST | `.../mental-models` | Create mental model |
| GET | `.../mental-models/{id}` | Get mental model |
| GET | `.../mental-models/{id}/history` | Get mental model version history |
| PATCH | `.../mental-models/{id}` | Update mental model |
| DELETE | `.../mental-models/{id}` | Delete mental model (+ Vectorize cleanup) |
| POST | `.../mental-models/{id}/refresh` | Refresh mental model via LLM |

### Consolidation & Observations

| Method | Path | Description |
|---|---|---|
| POST | `.../consolidate` | Trigger consolidation (cluster facts into observations via LLM) |
| GET | `.../observations` | List observations |
| GET | `.../observations/{model_id}` | Get observations linked to a mental model |
| DELETE | `.../observations` | Clear all observations (+ Vectorize cleanup) |
| POST | `.../consolidation-recover` | Reset stuck consolidation operations to failed |

### Operations

| Method | Path | Description |
|---|---|---|
| GET | `.../operations` | List async operations (filterable by status) |
| GET | `.../operations/{id}` | Get operation detail |
| POST | `.../operations/{id}/retry` | Retry a failed operation |
| DELETE | `.../operations/{id}` | Cancel pending operation |

### Webhooks

| Method | Path | Description |
|---|---|---|
| GET | `.../webhooks` | List webhooks |
| POST | `.../webhooks` | Create webhook (URL validated against SSRF) |
| PATCH | `.../webhooks/{id}` | Update webhook |
| DELETE | `.../webhooks/{id}` | Delete webhook |
| GET | `.../webhooks/{id}/deliveries` | List webhook deliveries (cursor paginated) |

### Audit Logs

| Method | Path | Description |
|---|---|---|
| GET | `.../audit-logs` | List audit logs (filterable by action, resource_type) |
| GET | `.../audit-logs/stats` | Audit log aggregates by action and resource_type |

### Stats

| Method | Path | Description |
|---|---|---|
| GET | `.../stats/memories-timeseries` | Memory count aggregated by date (configurable period) |

### Other

| Method | Path | Description |
|---|---|---|
| GET | `.../graph` | Entity co-occurrence graph (`{nodes, edges, total_nodes, total_edges}`) |
| GET | `.../tags` | List all tags |
| POST | `.../files/retain` | File upload (disabled — future release) |

> **Note:** Paths shown as `...` are relative to `/v1/{tenant}/banks/{bank_id}` unless otherwise noted. The `{tenant}` segment defaults to `default` for single-tenant deployments.

## Project Structure

```
hindsight-cf/
├── migrations/
│   ├── 0001_initial_schema.sql        # D1 schema (10 tables + FTS5)
│   ├── 0002_api_keys.sql             # API keys table for multi-tenant auth
│   └── 0003_webhooks_audit_logs.sql  # Webhooks, deliveries, audit logs tables
├── src/
│   ├── index.ts                       # Entry point, Hono app, queue consumer
│   ├── env.ts                         # Cloudflare bindings type definition
│   ├── types.ts                       # Shared request/response types
│   ├── vectorize-utils.ts             # Batched Vectorize delete helper
│   ├── metrics.ts                     # Analytics Engine write/read helpers
│   ├── middleware/
│   │   └── auth.ts                    # Bearer auth middleware (3 modes)
│   ├── engine/
│   │   ├── consolidate/
│   │   │   └── orchestrator.ts        # Semantic clustering + LLM synthesis
│   │   ├── entity-regenerate.ts       # Entity summary regeneration
│   │   ├── mental-model-refresh.ts    # Mental model refresh via LLM
│   │   ├── recall/
│   │   │   ├── orchestrator.ts        # Multi-signal recall pipeline
│   │   │   ├── vector-search.ts       # Vectorize similarity search
│   │   │   ├── fts-search.ts          # D1 FTS5 full-text search
│   │   │   ├── graph-retrieval.ts     # Entity graph traversal
│   │   │   ├── fusion.ts             # Result fusion (RRF)
│   │   │   ├── reranking.ts           # Workers AI reranking
│   │   │   └── types.ts
│   │   ├── reflect/
│   │   │   ├── agent.ts               # Agentic LLM loop
│   │   │   ├── prompts.ts             # System prompts
│   │   │   ├── tools-schema.ts        # Tool definitions for LLM
│   │   │   ├── tools.ts               # Tool implementations
│   │   │   └── types.ts
│   │   └── retain/
│   │       ├── orchestrator.ts        # Full retain pipeline
│   │       ├── fact-extraction.ts     # LLM fact extraction
│   │       ├── fact-storage.ts        # D1 + Vectorize storage
│   │       ├── chunk-storage.ts       # Document chunking
│   │       ├── deduplication.ts       # Semantic dedup
│   │       ├── entity-processing.ts   # Entity resolution
│   │       ├── link-creation.ts       # Temporal/semantic/causal links
│   │       └── types.ts
│   ├── providers/
│   │   ├── embeddings.ts              # Workers AI embeddings
│   │   ├── llm.ts                     # LLM provider (Workers AI / external)
│   │   └── llm-tools.ts              # LLM with tool-use support
│   └── routes/
│       ├── health.ts                  # /health, /version, /metrics
│       ├── banks.ts                   # Bank CRUD, profile, config
│       ├── memories.ts                # Retain, recall, list/get/delete
│       ├── entities.ts                # Entity list + detail
│       ├── documents.ts               # Document + chunk CRUD
│       ├── directives.ts              # Directive CRUD
│       ├── mental-models.ts           # Mental model CRUD
│       ├── operations.ts              # Async operation tracking
│       ├── graph.ts                   # Entity co-occurrence graph
│       ├── tags.ts                    # Tag listing
│       ├── files.ts                   # File upload (disabled)
│       ├── webhooks.ts                # Webhook CRUD + delivery listing
│       └── audit-logs.ts             # Audit log listing + stats
├── tests/
│   ├── helpers.ts                     # In-memory D1/Vectorize/AI mocks
│   ├── health.test.ts                 # Health/version endpoint tests
│   ├── banks.test.ts                  # Bank CRUD + config tests
│   ├── directives.test.ts            # Directive CRUD tests
│   ├── memories.test.ts               # Memory retain/recall/delete tests
│   ├── auth.test.ts                   # Auth middleware tests (all 3 modes)
│   ├── integration.test.ts            # End-to-end retain → recall tests
│   └── api-compatibility.test.ts      # 158 tests verifying API parity with original
├── .prettierrc                        # Prettier config (120 width, single quotes)
├── eslint.config.js                   # ESLint flat config (TS + Prettier)
├── wrangler.toml                      # Cloudflare Worker config
├── vitest.config.ts                   # Test configuration
├── package.json
├── tsconfig.json
└── PLAN.md                            # Architecture and implementation plan
```

## Acknowledgments

This project is a port of [**hindsight**](https://github.com/vectorize-io/hindsight) by [Vectorize](https://vectorize.io). All credit for the memory architecture, API design, and concepts (memory banks, disposition-based recall, directives, mental models, entity graphs, consolidation) belongs to the original hindsight authors. This port aims to make hindsight's capabilities available on Cloudflare's edge platform while maintaining full API compatibility.

This TypeScript port was developed with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.

## License

Like [hindsight](https://github.com/vectorize-io/hindsight) this is MIT licensed
