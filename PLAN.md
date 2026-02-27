# Hindsight Cloudflare Port - Implementation Plan

## Overview

Port [hindsight](https://github.com/vectorize-io/hindsight) (an AI agent memory system) from Python/FastAPI/PostgreSQL to run entirely on Cloudflare Workers and primitives, maintaining 100% API compatibility.

---

## 1. Architecture Mapping: Original → Cloudflare

| Original Component | Cloudflare Primitive | Notes |
|---|---|---|
| FastAPI HTTP server | **Cloudflare Worker** (Hono framework) | TypeScript, runs on edge |
| PostgreSQL (relational storage) | **D1** (SQLite-based) | Schema redesign needed (no pgvector) |
| pgvector (vector search) | **Vectorize** | Cloudflare's vector DB; separate index |
| BM25 / full-text search | **D1 FTS5** | SQLite FTS5 extension in D1 |
| Background workers / async ops | **Queues + Durable Objects** | Queues for job dispatch, DO for state |
| File storage (S3-compatible) | **R2** | S3-compatible object storage |
| tiktoken (token counting) | **js-tiktoken** (npm) | Pure JS port, works in Workers |
| LLM calls (OpenAI/Anthropic/etc.) | **Workers AI** or external API calls | `fetch()` to external LLM APIs |
| Embeddings (local/OpenAI/etc.) | **Workers AI** or external API calls | Workers AI has embedding models |
| Cross-encoder reranking | **External API call** | No local model support in Workers |
| Prometheus metrics | **Workers Analytics Engine** | Or omit for v1 |
| MCP server (SSE) | **Deferred** | SSE not natively supported in Workers |

---

## 2. API Endpoints to Implement (100% API Compatible)

All routes are under `/v1/default/banks/{bank_id}/...`:

### Monitoring
- `GET /health` — health check
- `GET /version` — version + feature flags
- `GET /metrics` — (stub or Analytics Engine)

### Memory (Core)
- `POST /v1/default/banks/{bank_id}/memories/retain` — retain memories
- `POST /v1/default/banks/{bank_id}/memories/recall` — recall memories
- `POST /v1/default/banks/{bank_id}/memories/reflect` — reflect on memories
- `GET  /v1/default/banks/{bank_id}/memories/list` — list memory units
- `GET  /v1/default/banks/{bank_id}/memories/{memory_id}` — get memory unit
- `DELETE /v1/default/banks/{bank_id}/memories/{memory_id}` — delete memory unit

### Banks
- `GET  /v1/default/banks` — list banks
- `GET  /v1/default/banks/{bank_id}/profile` — get bank profile
- `PATCH /v1/default/banks/{bank_id}` — update bank
- `DELETE /v1/default/banks/{bank_id}` — delete bank
- `GET  /v1/default/banks/{bank_id}/stats` — bank statistics
- `GET  /v1/default/banks/{bank_id}/config` — bank config
- `PATCH /v1/default/banks/{bank_id}/config` — update bank config
- `PUT  /v1/default/banks/{bank_id}/profile/disposition` — update disposition
- `POST /v1/default/banks/{bank_id}/profile/background` — merge mission
- `PUT  /v1/default/banks/{bank_id}/profile/mission` — set mission

### Entities
- `GET  /v1/default/banks/{bank_id}/entities` — list entities
- `GET  /v1/default/banks/{bank_id}/entities/{entity_id}` — get entity detail

### Documents
- `GET  /v1/default/banks/{bank_id}/documents` — list documents
- `GET  /v1/default/banks/{bank_id}/documents/{document_id}` — get document
- `DELETE /v1/default/banks/{bank_id}/documents/{document_id}` — delete document
- `GET  /v1/default/banks/{bank_id}/chunks/{chunk_id}` — get chunk

### Graph
- `GET  /v1/default/banks/{bank_id}/graph` — get graph data

### Operations (async)
- `GET  /v1/default/banks/{bank_id}/operations` — list operations
- `DELETE /v1/default/banks/{bank_id}/operations/{operation_id}` — cancel operation

### Directives
- `GET  /v1/default/banks/{bank_id}/directives` — list directives
- `POST /v1/default/banks/{bank_id}/directives` — create directive
- `PATCH /v1/default/banks/{bank_id}/directives/{directive_id}` — update directive
- `DELETE /v1/default/banks/{bank_id}/directives/{directive_id}` — delete directive

### Mental Models (Observations)
- `GET  /v1/default/banks/{bank_id}/mental-models` — list mental models
- `POST /v1/default/banks/{bank_id}/mental-models` — create mental model
- `PATCH /v1/default/banks/{bank_id}/mental-models/{model_id}` — update mental model
- `DELETE /v1/default/banks/{bank_id}/mental-models/{model_id}` — delete mental model

### Files
- `POST /v1/default/banks/{bank_id}/files/retain` — upload files for retention
- `DELETE /v1/default/banks/{bank_id}/memories/clear-observations` — clear observations

### Tags
- `GET /v1/default/banks/{bank_id}/tags` — list tags

---

## 3. Challenges & Discussion Points

### 3a. Vector Search (Critical)
**Original:** PostgreSQL + pgvector with HNSW indexes, cosine similarity search, inline with SQL queries.

**Cloudflare:** Vectorize (separate vector DB). Cannot do a single SQL query that joins relational data with vector similarity.

**Proposed approach:**
1. Store vectors in **Vectorize** (indexed per-bank via namespace/metadata).
2. For recall: query Vectorize first for top-K vector matches, then hydrate results from D1.
3. This is a **two-hop pattern** (vector search → relational join) instead of single SQL.
4. Vectorize supports metadata filtering, so we can attach `bank_id`, `fact_type`, `tags` as metadata.

**Trade-off:** Slightly different ranking behavior due to separate vector/relational queries, but API response format stays identical.

### 3b. Full-Text / BM25 Search
**Original:** PostgreSQL `tsvector`/`tsquery` with GIN indexes, or vchord_bm25 extension.

**Cloudflare:** D1 supports FTS5 (SQLite full-text search). Different ranking algorithm but functionally equivalent.

**Proposed approach:** Create FTS5 virtual tables in D1 for text search, translate BM25 queries to FTS5 syntax.

### 3c. Async Operations / Background Processing
**Original:** Python `asyncio.create_task()` + database-polled async_operations table. Long-running retain/reflect operations queued and processed by a background worker loop.

**Cloudflare:** Workers have a 30-second CPU time limit (up to 15 min for Cron Triggers / Queues consumers).

**Proposed approach:**
1. **Cloudflare Queues** for async job dispatch (retain, reflect, consolidation).
2. **Queue consumer Worker** processes jobs (up to 15 min execution time).
3. **D1** stores operation status (same API contract as async_operations table).
4. Alternatively, **Durable Objects** can manage long-running operation state and coordinate retries.

### 3d. Cross-Encoder Reranking
**Original:** Local SentenceTransformers model or remote TEI/Cohere/LiteLLM API.

**Cloudflare:** Cannot run PyTorch models in Workers. Workers AI doesn't have cross-encoder models.

**Proposed approach:**
1. **Default:** Use Cohere Rerank API or equivalent external API (already supported in original).
2. **Fallback:** Skip reranking (use reciprocal rank fusion only). This degrades quality but maintains API compat.
3. Could also explore Workers AI for a lightweight reranking proxy in the future.

### 3e. Embeddings
**Original:** Local SentenceTransformers, OpenAI, Cohere, TEI, LiteLLM.

**Cloudflare:** Workers AI has `@cf/baai/bge-base-en-v1.5` and `@cf/baai/bge-small-en-v1.5` embedding models (same family as the default local model).

**Proposed approach:**
1. **Workers AI** as default embedding provider (free, low latency, same model family).
2. Also support **external API** providers (OpenAI, Cohere) via `fetch()` for users who want to match their existing embeddings.

### 3f. LLM Calls (Fact Extraction, Reflect Agent)
**Original:** OpenAI, Anthropic, Gemini, etc. via provider-specific SDKs.

**Cloudflare:** Can call any LLM API via `fetch()`. Workers AI also provides LLM models.

**Proposed approach:**
1. Call external LLM APIs directly via `fetch()` (OpenAI, Anthropic, etc.)
2. Optionally support **Workers AI** as a built-in LLM provider.
3. Port the prompt templates and structured output parsing to TypeScript.

### 3g. File Parsing (markitdown, Iris)
**Original:** Python `markitdown` and `iris` libraries for parsing PDFs, Office docs, etc.

**Cloudflare:** No native document parsing in Workers.

**Proposed approach:**
1. For text files and markdown: handle directly in Worker.
2. For complex formats (PDF, DOCX): call an external parsing service or use R2 + a scheduled Worker.
3. **Alternative:** Accept only pre-parsed text content in v1, add file parsing later.

### 3h. Entity Resolution
**Original:** LLM-based entity resolution with coreference resolution.

**Cloudflare:** This is pure LLM logic — fully portable. Just requires calling LLM APIs.

**Proposed approach:** Port entity resolution prompts and logic to TypeScript. Same LLM calls, same logic.

### 3i. MCP Server (Model Context Protocol)
**Original:** SSE-based MCP server for tool integration.

**Cloudflare:** Workers support SSE with `ReadableStream` but with caveats (no long-lived connections beyond ~30s for non-WebSocket).

**Proposed approach:**
1. **Defer MCP** to a later phase.
2. Or implement using **Durable Objects** + WebSocket for persistent connections.

### 3j. Multi-Tenancy / Schema Isolation
**Original:** PostgreSQL schemas for tenant isolation (each tenant gets a separate PG schema).

**Cloudflare:** D1 doesn't have schema namespacing.

**Proposed approach:**
1. **Single-tenant per D1 database** (simplest, strongest isolation).
2. Or use a `tenant_id` column on all tables + row-level filtering.
3. For v1: single-tenant mode (matches the default docker deployment).

### 3k. Database Transactions
**Original:** PostgreSQL transactions with connection pooling via asyncpg.

**Cloudflare:** D1 supports transactions via `db.batch()` (batched statements run atomically).

**Proposed approach:** Use D1 batch operations for atomic multi-statement operations.

---

## 4. Tech Stack for the Port

- **Runtime:** Cloudflare Workers (TypeScript)
- **HTTP framework:** Hono (lightweight, Workers-native)
- **Database:** D1 (SQLite) with FTS5
- **Vector DB:** Vectorize
- **Object storage:** R2
- **Background jobs:** Queues
- **Token counting:** js-tiktoken
- **Schema validation:** Zod
- **LLM clients:** Direct fetch() calls with typed wrappers

---

## 5. Phased Implementation Plan

### Phase 1: Foundation
1. Project scaffolding (wrangler.toml, package.json, tsconfig)
2. D1 schema design (banks, memory_units, memory_links, entities, documents, chunks, etc.)
3. Hono router with all endpoint stubs
4. Health + version endpoints

### Phase 2: Retain Pipeline
1. Fact extraction (LLM call + prompt porting)
2. Embedding generation (Workers AI or external)
3. Entity extraction + resolution
4. Store facts in D1 + vectors in Vectorize
5. Link creation (temporal, semantic, entity)
6. Chunk storage

### Phase 3: Recall Pipeline
1. Vector similarity search via Vectorize
2. FTS5 keyword search via D1
3. Graph-based retrieval (entity links, temporal links)
4. Reciprocal rank fusion
5. Reranking (external API)
6. Entity state hydration

### Phase 4: Reflect Pipeline
1. Port reflect agent logic (tool-calling loop)
2. Reflect tools: recall, lookup, learn, expand
3. Structured output support
4. Observation/consolidation system

### Phase 5: Management APIs
1. Banks CRUD
2. Documents CRUD
3. Entities listing
4. Directives CRUD
5. Mental models CRUD
6. Tags
7. Graph data endpoint

### Phase 6: Async Operations
1. Queue-based async retain
2. Operation status tracking
3. Operation cancellation

### Phase 7: Files & Polish
1. File upload to R2
2. Text file parsing
3. Metrics stub
4. Error handling parity
5. OpenAPI spec generation

---

## 6. Open Questions for Discussion

1. **Vectorize index per bank vs shared index?** Vectorize supports namespace filtering, so a shared index with `bank_id` metadata is likely simpler.

2. **D1 size limits?** D1 has a 10GB limit per database. For very large memory banks, we may need to shard across multiple D1 databases.

3. **Workers AI vs external embeddings?** Workers AI is free and fast but limited to specific models. If users need to match existing embeddings (e.g., they migrated from the Python version), we need external API support.

4. **Reranking quality?** Skipping cross-encoder reranking will degrade recall quality. Should we require a Cohere API key for reranking, or make it optional?

5. **MCP support timeline?** Should we attempt Durable Object-based MCP in v1, or defer entirely?

6. **Graph search fidelity?** The original uses spreading activation across the memory graph. Porting this to D1 with recursive queries may be limited (SQLite has recursive CTEs but no built-in graph extensions). We may need to simplify the graph traversal.
