# hindsight-cf

A TypeScript port of [**hindsight**](https://github.com/vectorize-io/hindsight) to Cloudflare Workers, built with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

[Hindsight](https://github.com/vectorize-io/hindsight) is an open-source AI agent memory system created by [Vectorize](https://vectorize.io). It gives LLM agents persistent, structured memory — enabling them to retain facts, recall relevant context, and reflect over accumulated knowledge. This port brings hindsight's full API to Cloudflare's edge infrastructure, replacing the original Python/FastAPI/PostgreSQL stack with TypeScript, Hono, D1, Vectorize, and Workers AI.

This port targets API compatibility with **hindsight v0.5.2**. For full details on hindsight's memory model, architecture, and concepts (memory banks, disposition traits, directives, mental models, entity graphs, etc.), see the [original hindsight repository](https://github.com/vectorize-io/hindsight).

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
| LLM | External API | **Workers AI** (default, per-request model override supported) or external API |
| Object storage | Local / S3 | **R2** |
| Background jobs | Celery / threads | **Queues** |

## Quickstart

For experienced Cloudflare developers. See [Full Getting Started](#getting-started) below for detailed instructions.

**Prerequisites:** Node.js >= 18, a Cloudflare account with a [Workers paid plan](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month — required for Vectorize).

```sh
git clone https://github.com/enzinas/hindsight-cf.git && cd hindsight-cf
npm install
npx wrangler login

# Create resources
npx wrangler d1 create hindsight-db
npx wrangler vectorize create hindsight-vectors --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create hindsight-files
npx wrangler queues create hindsight-jobs
npx wrangler queues create hindsight-jobs-dlq

# Update wrangler.toml with your D1 database_id, then:
npm run db:migrate:remote
npm run deploy

# Secure it
npx wrangler secret put HINDSIGHT_API_KEY

# Verify
curl https://hindsight-cf.<you>.workers.dev/health
```

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

If you don't already have one, sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).

**A Workers paid plan ($5/month) is required.** Vectorize (vector search) is only available on the paid plan, and hindsight-cf depends on it for recall and reflect. The paid plan also significantly increases limits on the other services hindsight-cf uses:

| Service | Free Tier | Paid Plan ($5/mo) |
|---|---|---|
| **Vectorize** | Not available | Included (per-query pricing) |
| **Workers** | 100K requests/day | 10M requests/month included |
| **D1** | 5M rows read, 100K written/day | 25B rows read, 50M written/month |
| **Queues** | 10K operations/day | 1M operations/month included |
| **Workers AI** | 10K neurons/day | Usage-based pricing |
| **R2** | 10 GB storage | 10 GB free, then $0.015/GB |
| **Analytics Engine** | 100K writes/day | 10M writes/month included |

*Limits shown are approximate as of April 2026 and may change. See [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current details.*

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
Successfully created DB 'hindsight-db'

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

Open `wrangler.toml` and replace the `database_id` value with the actual ID from Step 6:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hindsight-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # paste your actual ID here
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
# -> {"status":"ok"}

# Version info
curl http://localhost:8787/version
# -> {"version":"0.1.0","runtime":"cloudflare-workers",...}

# Create a bank and get its profile (banks auto-create on first access)
curl http://localhost:8787/v1/default/banks/my-agent/profile
# -> {"bank_id":"my-agent","name":"my-agent","disposition":{...},...}
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

### Step 11 — Secure your deployment

Set an API key to protect your instance:

```sh
npx wrangler secret put HINDSIGHT_API_KEY
# Enter a strong key when prompted — all API requests will require this as a Bearer token
```

Optionally, set an admin key for the backup/restore page:

```sh
npx wrangler secret put HINDSIGHT_ADMIN_KEY
```

### Step 12 — Verify the deployment

Test that the full stack (Workers AI, D1, Vectorize) is working end-to-end:

```sh
BASE=https://hindsight-cf.<your-subdomain>.workers.dev/v1/default/banks/my-agent
AUTH="Authorization: Bearer <your-api-key>"

# Health check
curl https://hindsight-cf.<your-subdomain>.workers.dev/health
# -> {"status":"ok"}

# Store a memory
curl -X POST "$BASE/memories" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"items":[{"content":"The team decided to use Rust for the new service."}]}'
# -> {"success":true,"items_count":1,...}

# Wait a moment for Vectorize indexing, then recall
sleep 3
curl -X POST "$BASE/memories/recall" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"What language is the new service using?"}'
# -> {"results":[{"text":"...Rust...","type":"world",...}]}

# Reflect (agentic retrieval with LLM reasoning)
curl -X POST "$BASE/reflect" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"What technical decisions have been made?"}'
# -> {"text":"Based on your memories, the team decided to use Rust..."}
```

If all three return meaningful results, your hindsight-cf instance is fully operational on Cloudflare's edge network.

## Configuration

### Environment variables (wrangler.toml `[vars]`)

These are set in `wrangler.toml` and can be changed before deploying:

| Variable | Default | Description |
|---|---|---|
| `HINDSIGHT_VERSION` | `0.1.0` | Reported version |
| `DEFAULT_LLM_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Workers AI model for reflect/retain (function calling, reasoning) |
| `DEFAULT_EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model (1024 dims, multilingual) |
| `DEFAULT_RERANKER_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI reranker model |
| `DEFAULT_VISION_MODEL` | `@cf/meta/llama-3.2-11b-vision-instruct` | Workers AI vision model for file retain (PDF/PPTX/image visual analysis) |
| `DEFAULT_SPEECH_MODEL` | `@cf/openai/whisper` | Workers AI speech-to-text model for audio file transcription |
| `EMBEDDING_DIMENSIONS` | `1024` | Embedding vector dimensions |

### Secrets

```sh
# Set secrets (Wrangler will prompt you to enter the value securely)

# Auth — single global API key (see Authentication section below)
npx wrangler secret put HINDSIGHT_API_KEY

# Admin — key for the backup/restore admin page (see Admin Backup section below)
npx wrangler secret put HINDSIGHT_ADMIN_KEY

# Optional — metrics: enable Analytics Engine queries for GET /metrics
# (see Metrics section below)
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN

# Optional — external LLM provider (see External LLM section below)
npx wrangler secret put EXTERNAL_LLM_BASE_URL
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put EXTERNAL_LLM_MODEL
```

Secrets are encrypted and only available to your Worker at runtime. They are never stored in your code or `wrangler.toml`.

### External LLM providers

By default, hindsight-cf uses Cloudflare Workers AI for all LLM tasks (fact extraction, reflect reasoning, entity regeneration). You can optionally route LLM calls to any OpenAI-compatible API instead:

```sh
npx wrangler secret put EXTERNAL_LLM_BASE_URL    # e.g. https://api.openai.com/v1
npx wrangler secret put OPENAI_API_KEY            # API key for the external provider
npx wrangler secret put EXTERNAL_LLM_MODEL        # e.g. gpt-4o, claude-sonnet-4-6, etc.
```

When `EXTERNAL_LLM_BASE_URL` and `OPENAI_API_KEY` are both set, LLM calls (retain fact extraction, reflect agent loop, mental model refresh) are routed to the external provider. Embeddings, reranking, vision, and speech-to-text always use Workers AI regardless of this setting.

Any provider that exposes an OpenAI-compatible `/chat/completions` endpoint will work, including:

- **OpenAI** — `https://api.openai.com/v1`
- **Azure OpenAI** — `https://<resource>.openai.azure.com/openai/deployments/<model>/v1`
- **Together AI** — `https://api.together.xyz/v1`
- **Groq** — `https://api.groq.com/openai/v1`
- **Ollama** (self-hosted) — `http://localhost:11434/v1`
- **Any OpenAI-compatible proxy** — including OpenRouter, LiteLLM, etc.

This is useful when you need a more capable model for complex reasoning tasks, or want to use a provider with higher rate limits. For reflect with tool use, the external model must support the OpenAI function-calling format.

### Authentication

hindsight-cf supports optional Bearer-token authentication compatible with the [original Hindsight Python client](https://github.com/vectorize-io/hindsight). Clients send an `Authorization: Bearer <token>` header.

There are three auth modes, checked in priority order:

#### Mode 1 — Open (default)

No configuration needed. All requests are allowed without authentication. This matches the original Hindsight OSS default where auth is not enforced.

#### Mode 2 — Single key

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

#### Mode 3 — Multi-tenant

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

**Client usage:**

```sh
# curl example
curl -H "Authorization: Bearer sk-acme-secret-token" \
  https://your-worker.workers.dev/v1/acme/banks

# Python client
from hindsight import Hindsight
client = Hindsight(base_url="https://your-worker.workers.dev", api_key="sk-acme-secret-token")
```

**Production recommendation: one deployment per tenant.** The original hindsight uses PostgreSQL schemas for hard database-level tenant isolation. hindsight-cf runs on D1 (SQLite), which doesn't support schemas — tenant isolation relies on `WHERE bank_id = ?` filtering in every query rather than a database-level boundary.

For production multi-tenant use, **deploy a separate Worker and D1 database per tenant** instead of using the multi-tenant key table. Cloudflare Workers are cheap to deploy and each gets its own D1 database, Vectorize index, and R2 bucket — providing true infrastructure-level isolation with no risk of cross-tenant data leakage. Use Mode 2 (single key) to secure each deployment.

```
hindsight-acme.your-domain.workers.dev    -> acme's D1, Vectorize, R2
hindsight-beta.your-domain.workers.dev    -> beta's D1, Vectorize, R2
hindsight-gamma.your-domain.workers.dev   -> gamma's D1, Vectorize, R2
```

Mode 3 (multi-tenant keys) is suitable for development, internal tools, or scenarios where tenants share a trust boundary.

## Features

### File Upload

`POST .../files/retain` accepts multipart file uploads (max **20MB per file**) and processes them asynchronously. Files are stored in R2, then a queue consumer extracts text and feeds it through the standard retain pipeline (chunking, fact extraction, embedding, storage).

**Two-step extraction for visual formats:**

| Format | Text Extraction | + Vision Model | Notes |
|--------|----------------|---------------|-------|
| PDF (`.pdf`) | `env.AI.toMarkdown()` | Yes | Captures charts, scans, diagrams |
| PPTX (`.pptx`) | `env.AI.toMarkdown()` | Yes | Slides are inherently visual |
| Images (`.jpg`, `.png`, `.webp`, `.svg`) | `env.AI.toMarkdown()` | Yes | OCR + semantic description |
| DOCX (`.docx`) | `env.AI.toMarkdown()` | No | Text-centric |
| Excel (`.xlsx`, `.xls`, `.xlsm`, `.xlsb`) | `env.AI.toMarkdown()` | No | Text-centric |
| CSV, HTML, XML | `env.AI.toMarkdown()` | No | Text-centric |
| Audio (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.webm`) | Whisper speech-to-text | No | Transcription via `@cf/openai/whisper` |
| Plain text, Markdown, JSON, YAML | Direct read | No | No conversion needed |

**Usage:**
```bash
# Upload a single file
curl -X POST "$BASE/files/retain" \
  -F "files=@document.pdf"

# Upload with metadata
curl -X POST "$BASE/files/retain" \
  -F "files=@report.pdf" \
  -F 'request={"files_metadata":[{"context":"Q4 report","tags":["finance"]}]}'

# Upload multiple files
curl -X POST "$BASE/files/retain" \
  -F "files=@file1.pdf" \
  -F "files=@file2.png"
```

**With a named strategy:**
```bash
curl -X POST "$BASE/files/retain" \
  -F "files=@meeting.pdf" \
  -F 'request={"files_metadata":[{"strategy":"meeting_notes","tags":["meetings"]}]}'
```

**Response:** `{ "operation_ids": ["uuid1", "uuid2"] }` — one operation per file. Track progress via `GET .../operations/{id}`.

#### Strategies

Named strategies are retain pipeline presets stored in bank config under the `strategies` key. They override defaults for how text is chunked and facts are extracted.

**Setting up a strategy via bank config:**
```bash
curl -X PATCH "$BASE/config" \
  -H "Content-Type: application/json" \
  -d '{
    "strategies": {
      "meeting_notes": {
        "chunk_size": 2000,
        "extraction_mode": "verbatim",
        "retain_mission": "Extract action items, decisions, and attendee commitments",
        "custom_instructions": "Pay special attention to deadlines and owners",
        "extract_causal_links": true
      },
      "research_paper": {
        "chunk_size": 6000,
        "extraction_mode": "concise",
        "retain_mission": "Extract key findings, methodology, and conclusions"
      }
    }
  }'
```

**Strategy fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `chunk_size` | number | 4000 | Text chunk size in characters before fact extraction |
| `extraction_mode` | `"concise"` \| `"verbatim"` | `"concise"` | `concise` extracts only facts worth remembering long-term; `verbatim` extracts exhaustively |
| `retain_mission` | string | bank mission | Override the bank's mission for extraction focus |
| `custom_instructions` | string | _(none)_ | Additional instructions appended to the extraction prompt |
| `extract_causal_links` | boolean | false | Whether to detect causal relationships between facts |

Reference a strategy by name in `files_metadata[].strategy` when uploading files.

#### Parser field

Upstream hindsight has a pluggable parser registry with per-file fallback chains (iris, markitdown). The `parser` field is accepted in `files_metadata` for API compatibility but has no effect in hindsight-cf. Cloudflare's native `env.AI.toMarkdown()` replaces all upstream parsers with a single extraction API that handles every supported format — there is no benefit to routing through different parsers.

### Bank Templates (Import/Export)

Export and import bank configuration as upstream-compatible `BankTemplateManifest` documents. This covers bank config, mental models, and directives — not raw memory data (see [Admin Backup](#admin-backup--restore) for full data dumps).

The template format matches upstream hindsight's `BankTemplateManifest`:

```json
{
  "version": "1",
  "bank": {
    "reflect_mission": "You are helping an agent remember...",
    "disposition_empathy": 5,
    "enable_observations": true
  },
  "mental_models": [
    { "id": "sentiment-overview", "name": "Sentiment Overview", "source_query": "What is the sentiment trend?" }
  ],
  "directives": [
    { "name": "Be empathetic", "content": "Always respond with empathy.", "priority": 10 }
  ]
}
```

**Export:** `GET .../export` returns only non-empty sections.

**Import:** `POST .../import` validates the manifest (version, unique IDs/names, non-empty fields, valid config values), then upserts mental models by ID and directives by name. Use `?dry_run=true` to preview what would change. Returns a detailed response showing what was created vs updated.

### Budget Levels

Both **Recall** and **Reflect** accept a `budget` parameter that controls the depth of retrieval:

| Budget | Recall behavior | Reflect behavior |
|---|---|---|
| `low` (default) | Fewer candidates, faster | Up to 4 LLM iterations |
| `mid` | Moderate depth | Up to 7 LLM iterations |
| `high` | Maximum candidates, all signals | Up to 10 LLM iterations |

```json
{ "query": "What happened last week?", "budget": "mid" }
```

### Per-Request Model Override (Reflect)

The reflect endpoint accepts a `model` parameter to override the default Workers AI model for that request. This is useful for testing different models or using a more capable model for complex queries:

```json
{
  "query": "Analyze the patterns in my recent observations",
  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```

Supported models must have function-calling (tool use) support. Tested models include:

| Model | Response shape |
|---|---|
| `@cf/qwen/qwen3-30b-a3b-fp8` (default) | OpenAI-compatible `tool_calls` |
| `@cf/google/gemma-3-12b-it` | OpenAI-compatible `tool_calls` |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Legacy flat `tool_calls` |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Legacy flat `tool_calls` |

### Structured Output (Reflect)

Reflect can return structured JSON by passing a `response_schema`. The LLM generates its natural-language answer first, then a second pass extracts data matching your schema:

```json
{
  "query": "What are the key decisions and their owners?",
  "response_schema": {
    "type": "object",
    "properties": {
      "decisions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "decision": { "type": "string" },
            "owner": { "type": "string" },
            "date": { "type": "string" }
          }
        }
      }
    }
  }
}
```

The response includes both `text` (natural language) and `structured_output` (parsed JSON matching your schema).

### Tag Filtering

Both **Recall** and **Reflect** endpoints support two tag filtering mechanisms:

**Flat tags** — simple array + match mode:

```json
{
  "query": "project status",
  "tags": ["frontend", "backend"],
  "tags_match": "any"
}
```

`tags_match` values: `any` (OR, includes untagged), `all` (AND, includes untagged), `any_strict` (OR, excludes untagged), `all_strict` (AND, excludes untagged).

**Tag groups** — recursive boolean expressions (AND / OR / NOT):

```json
{
  "query": "project status",
  "tag_groups": [
    {
      "and": [
        { "tags": ["frontend"], "match": "any" },
        { "not": { "tags": ["deprecated"] } }
      ]
    }
  ]
}
```

Tag groups support arbitrary nesting:

| Operator | Shape | Semantics |
|---|---|---|
| Leaf | `{ "tags": [...], "match": "any" }` | Flat tag match |
| AND | `{ "and": [TagGroup, ...] }` | All children must match |
| OR | `{ "or": [TagGroup, ...] }` | Any child must match |
| NOT | `{ "not": TagGroup }` | Child must NOT match |

When both `tags` and `tag_groups` are provided, both must pass (AND). Multiple top-level tag groups are also combined with AND.

### Trace Output (Reflect)

Pass `include.tool_calls` to see which tools the reflect agent used and how long each step took:

```json
{
  "query": "What do I know about octopuses?",
  "include": { "tool_calls": {} }
}
```

The response `trace` field shows each tool call (search_mental_models, search_observations, recall, done), its input/output, duration, and iteration number.

### Admin Backup & Restore

hindsight-cf includes a built-in admin page for full data backup and restore at `/admin/backup`. Unlike the API-level template export/import (which handles bank configuration only), the admin backup exports **all data** — memories, entities, directives, and documents.

**Setup:**

```sh
npx wrangler secret put HINDSIGHT_ADMIN_KEY
```

**Usage:** Navigate to `https://your-worker.workers.dev/admin/backup` in your browser. The page prompts for your admin key and bank ID, then provides:

- **Export** — downloads the full bank data as a JSON file
- **Dry Run** — validates an import file and shows what would be imported without writing
- **Import** — restores data from a previously exported JSON file

The admin page is served without authentication; only the data endpoints (`/admin/backup/export` and `/admin/backup/import`) require the `HINDSIGHT_ADMIN_KEY` Bearer token.

**Note:** Import inserts raw data without re-embedding. Existing records with the same ID are skipped (INSERT OR IGNORE). To get vector search working on imported memories, you'll need to re-run the retain pipeline on them.

### Workers AI Resilience

hindsight-cf includes automatic retry logic for transient Cloudflare Workers AI errors:

| Error | Description | Retries | Delay |
|---|---|---|---|
| `3043` | Undocumented transient upstream error | 3 | 100ms |
| `3040` | Rate limit / capacity exceeded | 1 | 5s |

All `env.AI.run` calls go through `aiRunWithRetry` (`src/providers/ai-retry.ts`), which transparently retries and logs recovery events to Analytics Engine. Retry statistics are included in `GET /metrics` when Analytics Engine is configured.

### Metrics & Observability

hindsight-cf uses [Cloudflare Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) for metrics collection. Every HTTP request and core operation (retain, recall, reflect, consolidate) is automatically instrumented.

**Write path** (automatic, zero-cost): Data points are written to Analytics Engine via the `ANALYTICS` binding on every request. This is fire-and-forget — no `await`, no latency impact. If the binding is missing, writes are silently skipped.

**Read path** (`GET /metrics`): Returns a JSON summary. If `CF_ACCOUNT_ID` and `CF_API_TOKEN` secrets are configured, the response includes Analytics Engine data (HTTP request counts, operation durations, LLM token usage) for the last 24 hours. D1 resource counts (banks, memories, entities, documents) are always included regardless of configuration.

**Setup (optional — metrics work without this, but /metrics returns only D1 counts):**

The Analytics Engine dataset (`hindsight_metrics`) is created automatically on first deploy — no `wrangler` command needed. To enable the full `GET /metrics` response with operational data:

1. Create a Cloudflare API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with **Account Analytics:Read** permission.
2. Find your Account ID in the Cloudflare dashboard sidebar (any zone overview page).
3. Set both as secrets:

```sh
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

**What's instrumented:**

| Event | Dimensions | Metrics |
|---|---|---|
| Every HTTP request | method, endpoint (normalized), status code | duration (ms) |
| retain, recall, reflect, consolidate | operation type, bank_id, success/error | duration (ms) |
| LLM calls | scope, model | duration (ms) |
| AI retry events | model, error code (3043/3040), outcome (recovered/exhausted) | duration (ms), attempt count |

Metrics are also visible in the [Cloudflare dashboard](https://dash.cloudflare.com/) under Workers & Pages > Analytics Engine, where you can build custom queries and visualizations.

## API Reference

This port targets 100% route and response-shape compatibility with the [original hindsight API](https://github.com/vectorize-io/hindsight). All core pipelines are implemented. See the [original hindsight documentation](https://github.com/vectorize-io/hindsight) for request/response schemas and usage details.

### Health & Monitoring

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (`{"status":"ok"}`) |
| GET | `/version` | Version info, feature flags, model config |
| GET | `/metrics` | JSON metrics summary (Analytics Engine + D1 counts) |

### Bank Templates

| Method | Path | Description |
|---|---|---|
| GET | `/v1/bank-template-schema` | Get JSON Schema for bank template manifests (global, not tenant-scoped) |
| GET | `.../export` | Export bank as `BankTemplateManifest` (config, mental models, directives) |
| POST | `.../import` | Import a `BankTemplateManifest` — upserts by ID/name (`?dry_run=true` supported) |

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
| POST | `.../consolidation/recover` | Reset stuck consolidation operations to failed |

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

### Stats & Other

| Method | Path | Description |
|---|---|---|
| GET | `.../stats/memories-timeseries` | Memory count aggregated by date (configurable period) |
| GET | `.../graph` | Entity co-occurrence graph (`{nodes, edges, total_nodes, total_edges}`) |
| GET | `.../tags` | List all tags |
| POST | `.../files/retain` | File upload — multipart, max 20MB/file, async processing via R2 + Queue |

### Admin

| Method | Path | Description |
|---|---|---|
| GET | `/admin/backup` | Admin backup/restore HTML page (no auth required for page) |
| GET | `/admin/backup/export?bank_id=X` | Full data dump as JSON (requires `HINDSIGHT_ADMIN_KEY`) |
| POST | `/admin/backup/import?bank_id=X` | Restore from JSON dump (`?dry_run=true` supported, requires `HINDSIGHT_ADMIN_KEY`) |

> **Note:** Paths shown as `...` are relative to `/v1/{tenant}/banks/{bank_id}` unless otherwise noted. The `{tenant}` segment defaults to `default` for single-tenant deployments. Admin routes are top-level (not tenant-scoped).

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

### Live integration tests

The `tests/live-*.test.ts` files run against a deployed hindsight-cf instance. They exercise the full stack end-to-end (retain -> recall -> reflect, model matrix, etc.) and are skipped unless environment variables are set:

```sh
LIVE_TEST_URL=https://hindsight-cf.<your-subdomain>.workers.dev \
LIVE_TEST_API_KEY=<your-api-key> \
  npx vitest run tests/live.test.ts tests/live-reflect.test.ts tests/live-models.test.ts
```

| Test file | What it covers |
|---|---|
| `live.test.ts` | Retain, recall, delete, entity extraction, tag filtering |
| `live-reflect.test.ts` | Reflect pipeline: tool-calling, hierarchical retrieval, structured output |
| `live-models.test.ts` | Tool-calling across 4 Workers AI models (both response shape families) |

You can customize which models the model-matrix test covers:

```sh
LIVE_TEST_MODELS="@cf/qwen/qwen3-30b-a3b-fp8,@cf/meta/llama-3.3-70b-instruct-fp8-fast" \
  npx vitest run tests/live-models.test.ts
```

### Custom domain (optional)

To use your own domain instead of `*.workers.dev`, add a custom domain in the [Cloudflare dashboard](https://dash.cloudflare.com/) under Workers & Pages > your worker > Settings > Domains & Routes.

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
│   │       ├── file-processor.ts     # File text extraction (toMarkdown + vision)
│   │       ├── deduplication.ts       # Semantic dedup
│   │       ├── entity-processing.ts   # Entity resolution
│   │       ├── link-creation.ts       # Temporal/semantic/causal links
│   │       └── types.ts
│   ├── providers/
│   │   ├── ai-retry.ts                # Workers AI retry wrapper (3043/3040 resilience)
│   │   ├── embeddings.ts              # Workers AI embeddings
│   │   ├── llm.ts                     # LLM provider (Workers AI / external)
│   │   └── llm-tools.ts              # LLM with tool-use support
│   └── routes/
│       ├── admin.ts                   # Admin backup/restore page + endpoints
│       ├── bank-templates.ts          # Bank template export/import (upstream-compatible)
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
│       ├── files.ts                   # File upload + retain via R2/Queue
│       ├── webhooks.ts                # Webhook CRUD + delivery listing
│       └── audit-logs.ts             # Audit log listing + stats
├── tests/
│   ├── helpers.ts                     # In-memory D1/Vectorize/AI mocks
│   ├── live-helpers.ts                # Shared helpers for live integration tests
│   ├── health.test.ts                 # Health/version endpoint tests
│   ├── banks.test.ts                  # Bank CRUD + config tests
│   ├── directives.test.ts            # Directive CRUD tests
│   ├── memories.test.ts               # Memory retain/recall/delete tests
│   ├── auth.test.ts                   # Auth middleware tests (all 3 modes)
│   ├── integration.test.ts            # End-to-end retain -> recall tests
│   ├── tag-filter.test.ts            # Tag filtering (flat + boolean groups)
│   ├── api-compatibility.test.ts      # 158 tests verifying API parity with original
│   ├── live.test.ts                   # Live integration tests (retain, recall, reflect)
│   ├── live-reflect.test.ts           # Live reflect pipeline tests
│   └── live-models.test.ts            # Live model-matrix test (tool-calling across models)
├── .prettierrc                        # Prettier config (120 width, single quotes)
├── eslint.config.js                   # ESLint flat config (TS + Prettier)
├── wrangler.toml                      # Cloudflare Worker config
├── vitest.config.ts                   # Test configuration
├── package.json
├── tsconfig.json
└── PLAN.md                            # Architecture and implementation plan
```

## Troubleshooting

### "Queue already has a consumer" error on deploy

```
Queue 'hindsight-jobs' already has a consumer. [code: 11004]
```

This is a [known wrangler issue](https://github.com/cloudflare/workers-sdk/issues). The worker code uploads and deploys successfully — wrangler just fails to re-register the queue consumer that's already bound. Your deployment is working; this error can be safely ignored.

### Workers AI error 3043

```
{"error":"internal_error","message":"3043: Internal server error"}
```

This is a transient Cloudflare Workers AI backend error, not caused by your code or rate limits. hindsight-cf automatically retries 3043 errors up to 3 times with 100ms delays (see Workers AI Resilience section). If you see persistent 3043 errors, check [Cloudflare's status page](https://www.cloudflarestatus.com/) — they correlate with infrastructure incidents.

### Workers AI error 3040 / HTTP 429

```
3040: Rate limit or capacity exceeded
```

This is a real rate limit. Default Workers AI limits are ~300 requests/minute for text generation and ~3000/minute for embeddings. hindsight-cf retries once after 5 seconds. If you consistently hit this, reduce request concurrency or contact Cloudflare to increase your limits.

### Recall returns no results after retain

Vectorize indexing is not instant. After retaining memories, allow 1-3 seconds before recall queries will find them. In tests, use a short `sleep` between retain and recall.

### Reflect produces no tool calls

If `/reflect` returns text but `trace.tool_calls` is empty, the Workers AI model may not support function calling or its response format is unrecognized. Try a different model via the `model` parameter (see Per-request model override). The default model (`@cf/qwen/qwen3-30b-a3b-fp8`) is tested and known to work.

### Deploy goes to wrong worker

If you deploy with `npx wrangler deploy --env=production` but no `[env.production]` section exists in `wrangler.toml`, wrangler creates a separate worker named `hindsight-cf-production` instead of updating `hindsight-cf`. Always deploy with `npm run deploy` (which runs `wrangler deploy` without an env flag) unless you've explicitly configured environments.

## Acknowledgments

This project is a port of [**hindsight**](https://github.com/vectorize-io/hindsight) by [Vectorize](https://vectorize.io). All credit for the memory architecture, API design, and concepts (memory banks, disposition-based recall, directives, mental models, entity graphs, consolidation) belongs to the original hindsight authors. This port aims to make hindsight's capabilities available on Cloudflare's edge platform while maintaining full API compatibility.

This TypeScript port was developed with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.

## License

Like [hindsight](https://github.com/vectorize-io/hindsight) this is MIT licensed
