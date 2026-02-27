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
| Embeddings | External API | **Workers AI** (`@cf/baai/bge-base-en-v1.5`) |
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
# Create the Vectorize index (768 dimensions for bge-base-en-v1.5, cosine similarity)
npx wrangler vectorize create hindsight-vectors --dimensions=768 --metric=cosine

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

Apply the schema to your D1 database. This creates the 10 tables, FTS5 virtual table, and triggers.

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

All 84 tests should pass, including the API compatibility suite that verifies all 47 original hindsight routes.

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
npm run test             # Run all 84 tests
npm run test:watch       # Run tests in watch mode
npm run typecheck        # TypeScript type checking
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
| `DEFAULT_LLM_MODEL` | `@cf/meta/llama-3.1-70b-instruct` | Workers AI model for reflect/retain |
| `DEFAULT_EMBEDDING_MODEL` | `@cf/baai/bge-base-en-v1.5` | Workers AI embedding model (768 dims) |
| `DEFAULT_RERANKER_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI reranker model |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |

### Secrets (optional, for external LLM providers)

If you want to use an external LLM (OpenAI, Anthropic, etc.) instead of or in addition to Workers AI:

```sh
# Set secrets (Wrangler will prompt you to enter the value securely)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EXTERNAL_LLM_BASE_URL
npx wrangler secret put EXTERNAL_LLM_MODEL
```

Secrets are encrypted and only available to your Worker at runtime. They are never stored in your code or `wrangler.toml`.

## API Reference

This port targets 100% route compatibility with the original [hindsight API](https://github.com/vectorize-io/hindsight). All endpoints exist and respond, but some core pipelines are not yet implemented (marked below). See the [original hindsight documentation](https://github.com/vectorize-io/hindsight) for request/response schemas and usage details.

**Legend:**  Implemented |  Stub (returns 501) |  Disabled

### Health & Monitoring

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `/health` | Health check |
|  | GET | `/version` | Version info, feature flags, model config |
|  | GET | `/metrics` | Metrics (placeholder — returns stub text) |

### Memory Operations

| | Method | Path | Description |
|---|---|---|---|
|  | POST | `.../memories` | **Retain** — ingest new memories (Phase 2: needs fact extraction, embeddings, entity resolution) |
|  | POST | `.../memories/recall` | **Recall** — retrieve memories by query (Phase 3: needs vector search, FTS5, reranking, fusion) |
|  | POST | `.../memories/reflect` | **Reflect** — agentic reasoning over memories (Phase 4: needs LLM loop with tool use) |
|  | GET | `.../memories/list` | List memory units (paginated, filterable by type) |
|  | GET | `.../memories/{id}` | Get a single memory unit |
|  | DELETE | `.../memories/{id}` | Delete a memory unit |
|  | DELETE | `.../memories/{id}/observations` | Delete observations linked to a memory |
|  | DELETE | `.../memories` | Clear all memories (optionally filtered by `?type=`) |

### Banks

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `/v1/default/banks` | List all banks |
|  | PUT | `.../banks/{bank_id}` | Update bank |
|  | PATCH | `.../banks/{bank_id}` | Partial update bank |
|  | DELETE | `.../banks/{bank_id}` | Delete bank |
|  | GET | `.../banks/{bank_id}/profile` | Get bank profile |
|  | PUT | `.../banks/{bank_id}/profile` | Update full profile (disposition + mission) |
|  | PUT | `.../banks/{bank_id}/profile/disposition` | Update disposition traits |
|  | PUT | `.../banks/{bank_id}/profile/mission` | Set mission |
|  | POST | `.../banks/{bank_id}/background` | Merge background into mission |
|  | GET | `.../banks/{bank_id}/stats` | Bank statistics |
|  | GET | `.../banks/{bank_id}/config` | Get bank config |
|  | PATCH | `.../banks/{bank_id}/config` | Update bank config |
|  | DELETE | `.../banks/{bank_id}/config` | Reset config to defaults |

### Entities

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../entities` | List entities (sorted by mention count) |
|  | GET | `.../entities/{id}` | Get entity detail with observations |
|  | POST | `.../entities/{id}/regenerate` | **Regenerate entity** (not yet implemented) |

### Documents & Chunks

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../documents` | List documents |
|  | GET | `.../documents/{id}` | Get document |
|  | DELETE | `.../documents/{id}` | Delete document |
|  | GET | `/v1/default/chunks/{id}` | Get chunk (top-level, not bank-scoped) |

### Directives

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../directives` | List directives |
|  | POST | `.../directives` | Create directive |
|  | GET | `.../directives/{id}` | Get directive |
|  | PATCH | `.../directives/{id}` | Update directive |
|  | DELETE | `.../directives/{id}` | Delete directive |

### Mental Models

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../mental-models` | List mental models |
|  | POST | `.../mental-models` | Create mental model |
|  | GET | `.../mental-models/{id}` | Get mental model |
|  | PATCH | `.../mental-models/{id}` | Update mental model |
|  | DELETE | `.../mental-models/{id}` | Delete mental model |
|  | POST | `.../mental-models/{id}/refresh` | **Refresh mental model** (not yet implemented) |

### Operations

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../operations` | List async operations |
|  | GET | `.../operations/{id}` | Get operation detail |
|  | DELETE | `.../operations/{id}` | Cancel pending operation |

### Other

| | Method | Path | Description |
|---|---|---|---|
|  | GET | `.../graph` | Entity co-occurrence graph |
|  | GET | `.../tags` | List all tags |
|  | POST | `.../consolidate` | **Trigger consolidation** (not yet implemented) |
|  | POST | `.../files/retain` | **File upload** (disabled — future release) |

> **Note:** Paths shown as `...` are relative to `/v1/default/banks/{bank_id}` unless otherwise noted.

### Implementation Summary

| Category | Implemented | Stub/Disabled | Total |
|---|---|---|---|
| Health & monitoring | 2 | 1 (metrics) | 3 |
| Memory operations | 5 | 3 (retain, recall, reflect) | 8 |
| Banks & profile | 13 | 0 | 13 |
| Entities | 2 | 1 (regenerate) | 3 |
| Documents & chunks | 4 | 0 | 4 |
| Directives | 5 | 0 | 5 |
| Mental models | 5 | 1 (refresh) | 6 |
| Operations | 3 | 0 | 3 |
| Graph, tags, consolidation, files | 2 | 2 (consolidate, files) | 4 |
| **Total** | **41** | **8** | **49** |

The 8 unimplemented endpoints are the core AI pipelines (retain, recall, reflect, consolidate, entity regeneration, mental model refresh), the metrics endpoint, and file upload. These are tracked in the implementation phases below.

## Project Structure

```
hindsight-cf/
├── migrations/
│   └── 0001_initial_schema.sql    # D1 schema (10 tables + FTS5)
├── src/
│   ├── index.ts                   # Entry point, Hono app, queue consumer
│   ├── env.ts                     # Cloudflare bindings type definition
│   ├── types.ts                   # Shared request/response types
│   └── routes/
│       ├── health.ts              # /health, /version, /metrics
│       ├── banks.ts               # Bank CRUD, profile, config
│       ├── memories.ts            # Retain, recall, reflect, list/get/delete
│       ├── entities.ts            # Entity list + detail
│       ├── documents.ts           # Document + chunk CRUD
│       ├── directives.ts          # Directive CRUD
│       ├── mental-models.ts       # Mental model CRUD
│       ├── operations.ts          # Async operation tracking
│       ├── graph.ts               # Entity co-occurrence graph
│       ├── tags.ts                # Tag listing
│       ├── files.ts               # File upload (disabled)
│       └── consolidation.ts       # On-demand consolidation
├── tests/
│   ├── helpers.ts                 # In-memory D1 mock, test utilities
│   ├── health.test.ts             # Health/version endpoint tests
│   ├── banks.test.ts              # Bank CRUD tests
│   ├── directives.test.ts         # Directive CRUD tests
│   ├── memories.test.ts           # Memory operations tests
│   └── api-compatibility.test.ts  # Verifies all 47 original hindsight routes exist
├── wrangler.toml                  # Cloudflare Worker config
├── vitest.config.ts               # Test configuration
├── package.json
├── tsconfig.json
└── PLAN.md                        # Architecture and implementation plan
```

## Implementation Roadmap

| Phase | Status | Description |
|---|---|---|
| Phase 1: Foundation | Done | Scaffolding, D1 schema, Hono router, all endpoint stubs |
| Phase 2: Retain Pipeline | Planned | Fact extraction via LLM, embedding generation, entity resolution, D1/Vectorize storage |
| Phase 3: Recall Pipeline | Planned | Vector search, FTS5 full-text search, graph retrieval, reranking, result fusion |
| Phase 4: Reflect Pipeline | Planned | Agentic LLM loop with tool use, structured output |
| Phase 5: Management APIs | Done | Banks, documents, entities, directives, mental models, tags, graph |
| Phase 6: Async Operations | Planned | Queue-based async retain, operation tracking, consolidation scheduling |
| Phase 7: Polish | Planned | Error handling, edge cases, metrics, file upload |

## Acknowledgments

This project is a port of [**hindsight**](https://github.com/vectorize-io/hindsight) by [Vectorize](https://vectorize.io). All credit for the memory architecture, API design, and concepts (memory banks, disposition-based recall, directives, mental models, entity graphs, consolidation) belongs to the original hindsight authors. This port aims to make hindsight's capabilities available on Cloudflare's edge platform while maintaining full API compatibility.

This TypeScript port was developed with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.

## License

Like [hindsight](https://github.com/vectorize-io/hindsight) this is MIT licensed
