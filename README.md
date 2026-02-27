# hindsight-cf

A Cloudflare Workers port of [hindsight](https://github.com/vectorize-io/hindsight) — an AI agent memory system. Runs entirely on Cloudflare's edge infrastructure with 100% API compatibility with the original.

## Architecture

| Component | Cloudflare Primitive |
|---|---|
| HTTP server | **Cloudflare Worker** (Hono) |
| Relational storage | **D1** (SQLite) |
| Vector search | **Vectorize** |
| Full-text search | **D1 FTS5** |
| Embeddings | **Workers AI** (`@cf/baai/bge-base-en-v1.5`) |
| Reranking | **Workers AI** (`@cf/baai/bge-reranker-base`) |
| LLM (reflect/retain) | **Workers AI** (default) or external API |
| Object storage | **R2** |
| Background jobs | **Queues** |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 3.95
- A Cloudflare account with access to D1, Vectorize, R2, Workers AI, and Queues

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Create Cloudflare resources

```sh
# D1 database
wrangler d1 create hindsight-db

# Vectorize index (768 dimensions for bge-base-en-v1.5, cosine metric)
wrangler vectorize create hindsight-vectors --dimensions=768 --metric=cosine

# R2 bucket
wrangler r2 bucket create hindsight-files

# Queue
wrangler queues create hindsight-jobs
wrangler queues create hindsight-jobs-dlq
```

### 3. Update wrangler.toml

Replace the `database_id` placeholder with the ID returned by `wrangler d1 create`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hindsight-db"
database_id = "<your-database-id>"
```

### 4. Run database migrations

```sh
# Local development
npm run db:migrate

# Remote (production)
npm run db:migrate:remote
```

## Development

```sh
# Start local dev server (with local D1, simulated bindings)
npm run dev
```

The server starts at `http://localhost:8787`. All API endpoints are available under `/v1/default/banks/{bank_id}/...`.

### Useful commands

```sh
npm run dev              # Start local dev server
npm run typecheck        # Run TypeScript type checking
npm run test             # Run tests
npm run test:watch       # Run tests in watch mode
```

## Deployment

```sh
# Deploy to Cloudflare Workers
npm run deploy
```

This deploys the Worker and applies the queue consumer configuration. Make sure all Cloudflare resources (D1, Vectorize, R2, Queues) are created first and `wrangler.toml` is updated with the correct IDs.

## Configuration

### Environment variables (wrangler.toml `[vars]`)

| Variable | Default | Description |
|---|---|---|
| `HINDSIGHT_VERSION` | `0.1.0` | Reported version |
| `DEFAULT_LLM_MODEL` | `@cf/meta/llama-3.1-70b-instruct` | Workers AI model for reflect/retain |
| `DEFAULT_EMBEDDING_MODEL` | `@cf/baai/bge-base-en-v1.5` | Workers AI embedding model (768 dims) |
| `DEFAULT_RERANKER_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI reranker model |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |

### Secrets (optional, for external LLM providers)

```sh
# If using an external LLM instead of Workers AI
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put EXTERNAL_LLM_BASE_URL
wrangler secret put EXTERNAL_LLM_MODEL
```

## API Reference

All endpoints are 100% compatible with the original [hindsight API](https://github.com/vectorize-io/hindsight). Base path: `/v1/default/banks/{bank_id}/`.

### Health & Monitoring

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/version` | Version info and feature flags |
| GET | `/metrics` | Metrics (stub) |

### Memory Operations

| Method | Path | Description |
|---|---|---|
| POST | `/v1/default/banks/{bank_id}/memories/retain` | Retain new memories |
| POST | `/v1/default/banks/{bank_id}/memories/recall` | Recall memories by query |
| POST | `/v1/default/banks/{bank_id}/memories/reflect` | Reflect (agentic reasoning over memories) |
| GET | `/v1/default/banks/{bank_id}/memories/list` | List memory units |
| GET | `/v1/default/banks/{bank_id}/memories/{id}` | Get a memory unit |
| DELETE | `/v1/default/banks/{bank_id}/memories/{id}` | Delete a memory unit |

### Banks

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks` | List all banks |
| GET | `/v1/default/banks/{bank_id}/profile` | Get bank profile |
| PATCH | `/v1/default/banks/{bank_id}` | Update bank |
| DELETE | `/v1/default/banks/{bank_id}` | Delete bank |
| GET | `/v1/default/banks/{bank_id}/stats` | Bank statistics |
| GET | `/v1/default/banks/{bank_id}/config` | Get bank config |
| PATCH | `/v1/default/banks/{bank_id}/config` | Update bank config |
| PUT | `/v1/default/banks/{bank_id}/profile/disposition` | Update disposition |
| PUT | `/v1/default/banks/{bank_id}/profile/mission` | Set mission |
| POST | `/v1/default/banks/{bank_id}/profile/background` | Merge background into mission |

### Entities

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/entities` | List entities |
| GET | `/v1/default/banks/{bank_id}/entities/{id}` | Get entity detail |

### Documents & Chunks

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/documents` | List documents |
| GET | `/v1/default/banks/{bank_id}/documents/{id}` | Get document |
| DELETE | `/v1/default/banks/{bank_id}/documents/{id}` | Delete document |
| GET | `/v1/default/banks/{bank_id}/chunks/{id}` | Get chunk |

### Directives

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/directives` | List directives |
| POST | `/v1/default/banks/{bank_id}/directives` | Create directive |
| PATCH | `/v1/default/banks/{bank_id}/directives/{id}` | Update directive |
| DELETE | `/v1/default/banks/{bank_id}/directives/{id}` | Delete directive |

### Mental Models

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/mental-models` | List mental models |
| POST | `/v1/default/banks/{bank_id}/mental-models` | Create mental model |
| PATCH | `/v1/default/banks/{bank_id}/mental-models/{id}` | Update mental model |
| DELETE | `/v1/default/banks/{bank_id}/mental-models/{id}` | Delete mental model |

### Operations

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/operations` | List async operations |
| DELETE | `/v1/default/banks/{bank_id}/operations/{id}` | Cancel operation |

### Other

| Method | Path | Description |
|---|---|---|
| GET | `/v1/default/banks/{bank_id}/graph` | Entity co-occurrence graph |
| GET | `/v1/default/banks/{bank_id}/tags` | List all tags |
| POST | `/v1/default/banks/{bank_id}/consolidate` | Trigger consolidation (on-demand) |

## Project Structure

```
hindsight-cf/
├── migrations/
│   └── 0001_initial_schema.sql    # D1 schema (10 tables + FTS5)
├── src/
│   ├── index.ts                   # Entry point, Hono app, queue consumer
│   ├── env.ts                     # Cloudflare bindings type definition
│   ├── types.ts                   # Shared request/response types
│   ├── routes/
│   │   ├── health.ts              # /health, /version, /metrics
│   │   ├── banks.ts               # Bank CRUD + profile + config
│   │   ├── memories.ts            # Retain, recall, reflect, list/get/delete
│   │   ├── entities.ts            # Entity list + detail
│   │   ├── documents.ts           # Document + chunk CRUD
│   │   ├── directives.ts          # Directive CRUD
│   │   ├── mental-models.ts       # Mental model CRUD
│   │   ├── operations.ts          # Async operation tracking
│   │   ├── graph.ts               # Entity graph
│   │   ├── tags.ts                # Tag listing
│   │   ├── files.ts               # File upload (disabled v1)
│   │   └── consolidation.ts       # On-demand consolidation
│   ├── engine/                    # (Phase 2-4) Core pipelines
│   │   ├── retain/                # Fact extraction, embedding, linking
│   │   ├── recall/                # Vector + FTS5 + graph search, reranking
│   │   └── reflect/               # Agentic LLM loop
│   ├── providers/                 # LLM + embedding provider abstractions
│   ├── db/                        # D1 query helpers
│   └── utils/                     # Token counting, text processing
├── wrangler.toml                  # Cloudflare Worker configuration
├── package.json
├── tsconfig.json
└── PLAN.md                        # Detailed architecture and implementation plan
```

## Implementation Status

| Phase | Status | Description |
|---|---|---|
| Phase 1: Foundation | Done | Scaffolding, D1 schema, router, all endpoint stubs |
| Phase 2: Retain Pipeline | Planned | Fact extraction, embeddings, entity resolution, storage |
| Phase 3: Recall Pipeline | Planned | Vector search, FTS5, graph retrieval, reranking, fusion |
| Phase 4: Reflect Pipeline | Planned | Agentic LLM loop, tool execution, structured output |
| Phase 5: Management APIs | Done | Banks, documents, entities, directives, mental models, tags, graph |
| Phase 6: Async Operations | Planned | Queue-based async retain, operation tracking |
| Phase 7: Polish | Planned | Error handling, edge cases, metrics |

## License

See the original [hindsight](https://github.com/vectorize-io/hindsight) repository for license information.
