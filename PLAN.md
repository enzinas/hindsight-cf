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
| Cross-encoder reranking | **Workers AI** `@cf/baai/bge-reranker-base` | Native reranker, same BAAI family |
| Prometheus metrics | **Workers Analytics Engine** | Or omit for v1 |
| MCP server (SSE) | **Deferred to v2** | Not in scope for v1 |

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

### 3d. Cross-Encoder Reranking — RESOLVED
**Original:** Local SentenceTransformers model or remote TEI/Cohere/LiteLLM API.

**Cloudflare:** Workers AI provides `@cf/baai/bge-reranker-base` — same BAAI model family as the original default.

**Decision:**
1. **Default:** Workers AI `@cf/baai/bge-reranker-base` (native, free, low latency).
2. **Optional:** External API (Cohere, etc.) for users who want a different model.
3. No PyTorch or containers needed.

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

### 3g. File Parsing (markitdown, Iris) — RESOLVED
**Original:** Python `markitdown` and `iris` libraries for parsing PDFs, Office docs, etc. Optional feature behind `HINDSIGHT_API_ENABLE_FILE_UPLOAD_API` flag.

**Decision:** Pre-parsed text only in v1. The file upload endpoint returns 404 with the feature flag disabled — this is exactly what the original does when the flag is off. **100% API compatible.**

### 3h. Entity Resolution
**Original:** LLM-based entity resolution with coreference resolution.

**Cloudflare:** This is pure LLM logic — fully portable. Just requires calling LLM APIs.

**Proposed approach:** Port entity resolution prompts and logic to TypeScript. Same LLM calls, same logic.

### 3i. MCP Server (Model Context Protocol) — RESOLVED
**Original:** SSE-based MCP server for tool integration. Optional feature behind `mcp_enabled` flag.

**Decision:** Deferred to v2. Version endpoint reports `mcp: false`. **100% API compatible** (feature flag off).

### 3j. Multi-Tenancy / Schema Isolation — RESOLVED
**Original:** PostgreSQL schemas for tenant isolation via optional `TenantExtension`. Default deployment is single-tenant using `public` schema.

**Decision:** Single-tenant (one D1 database). Matches the original's default mode. **100% API compatible.**

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

### Phase 4: Reflect Pipeline (see Section 7 for detailed design)
1. Port reflect agent loop (iterative LLM tool-calling)
2. Port all 5 reflect tools: search_mental_models, search_observations, recall, expand, done
3. Port system prompts and hierarchical retrieval strategy
4. Structured output support (response_schema → extra LLM call)
5. Directive compliance system
6. Observation/consolidation system

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

## 7. Reflect Pipeline — Detailed Cloudflare Design

### What Reflect Does (Original)

Reflect is an **agentic LLM loop** that answers questions by reasoning over retrieved memories. It's not a simple RAG query — it's a multi-turn tool-calling agent with up to 10 iterations.

**The loop:**
1. Build a system prompt with bank profile, mission, disposition, directives, and retrieval strategy instructions.
2. Send the user's query to an LLM with 5 tools available.
3. The LLM calls tools to gather evidence, then calls `done()` with its answer.
4. If it hits the iteration limit, a "final prompt" forces a response from whatever was gathered.

### The 5 Reflect Tools

| Tool | Purpose | Cloudflare Implementation |
|---|---|---|
| `search_mental_models(query, max_results)` | Search user-curated summaries (highest priority) | D1 query + Vectorize similarity search on mental_models table |
| `search_observations(query, max_tokens)` | Search auto-consolidated knowledge | D1 query + Vectorize similarity search on observations |
| `recall(query, max_tokens, max_chunk_tokens)` | Search raw facts (ground truth) | Same recall pipeline from Phase 3 (Vectorize + FTS5 + rerank) |
| `expand(memory_ids, depth)` | Get surrounding context for memories | D1 lookup: chunk text or full document from chunks/documents tables |
| `done(answer, memory_ids, mental_model_ids, observation_ids)` | Submit final answer with citations | Validates cited IDs against actually-retrieved IDs, cleans answer text |

### Hierarchical Retrieval Strategy

The agent is forced through a specific retrieval order via `tool_choice`:
- **Iteration 0:** Forced to call `search_mental_models` (if bank has mental models) or `search_observations`
- **Iteration 1:** Forced to call `search_observations` (if mental models) or `recall`
- **Iteration 2:** Forced to call `recall` (if mental models)
- **Iteration 3+:** `auto` — LLM decides what to call or calls `done()`

This ensures the agent always gathers evidence before answering.

### Why Reflect Works Fine on Cloudflare Workers

Reflect is **entirely LLM API calls + database queries**. There is no:
- Local model inference (all LLM calls go to external APIs via `fetch()`)
- Heavy CPU computation
- Long-running background processing (it's a synchronous request-response)

The main concern is **wall-clock time**: a reflect with 5-10 LLM round-trips could take 10-30 seconds. Cloudflare Workers support this:
- **Workers have no wall-clock timeout** for fetch subrequests (only CPU time is limited to 30s on bundled, 30ms on unbound between I/O).
- Each LLM call is an I/O wait (fetch), not CPU time.
- The agent loop itself is lightweight orchestration code.

### Implementation Plan

```
src/engine/reflect/
├── agent.ts           # Main agentic loop (port of agent.py)
├── prompts.ts         # System prompts & prompt builders (port of prompts.py)
├── tools-schema.ts    # OpenAI-format tool definitions (port of tools_schema.py)
├── tools.ts           # Tool execution dispatch (port of tools.py)
└── types.ts           # ReflectAgentResult, ToolCall, LLMCall types
```

**Key porting decisions:**
1. **LLM calls:** Use a thin `LLMProvider` abstraction that calls external APIs via `fetch()`. The provider must support `call()` (text completion) and `call_with_tools()` (tool-calling). OpenAI-compatible format (same as original).
2. **Tool execution:** Tools call back into the recall pipeline (Phase 3) and D1 queries. No new infrastructure needed — reflect reuses existing recall/search code.
3. **Structured output:** When `response_schema` is provided, an extra LLM call extracts structured JSON from the free-text answer. Pure LLM call, fully portable.
4. **Directive compliance:** Directives are injected into the system prompt at the START and END (for recency effect). The `done()` tool schema gets an extra `directive_compliance` field when directives are present. Pure prompt engineering, fully portable.
5. **Answer cleaning:** Regex-based cleanup of LLM output artifacts (leaked JSON, tool call syntax). Port the regex patterns to TypeScript.
6. **ID validation:** The agent tracks which IDs were actually returned by tools, and filters out any hallucinated IDs from the `done()` call. Simple set tracking, fully portable.
7. **Parallel tool execution:** When the LLM returns multiple tool calls, execute them concurrently with `Promise.all()` (equivalent to Python's `asyncio.gather()`).

### API Compatibility

The reflect API response is **100% identical**:
```json
{
  "text": "markdown answer",
  "structured_output": { ... },  // if response_schema provided
  "based_on": {
    "memory_ids": ["..."],
    "mental_model_ids": ["..."],
    "observation_ids": ["..."]
  },
  "trace": {
    "iterations": 4,
    "tools_called": 3,
    "tool_trace": [...],
    "llm_trace": [...],
    "usage": { "input_tokens": 5000, "output_tokens": 800, "total_tokens": 5800 },
    "directives_applied": [...]
  }
}
```

No API changes needed. The only difference is which external LLM is called (configurable).

---

## 8. Decisions Log

| # | Decision | Choice | API Impact |
|---|---|---|---|
| 1 | Reranking | Workers AI `@cf/baai/bge-reranker-base` (native) | None |
| 2 | File parsing | Pre-parsed text only; file upload disabled (feature flag) | None (same as original with flag off) |
| 3 | MCP server | Deferred to v2 | Feature flag reports `mcp: false` |
| 4 | Multi-tenancy | Single-tenant (matches original default) | None |
| 5 | Graph traversal | Simplified (vector + FTS + entity lookup + RRF) | Response format identical; retrieval quality may differ |
| 6 | Vectorize index | Shared index with `bank_id` metadata filtering | None |
| 7 | Reflect pipeline | Direct port — agentic loop + external LLM calls via `fetch()` | None (100% identical API response) |

---

## 9. Remaining Open Questions

1. **D1 size limits?** D1 has a 10GB limit per database. For very large memory banks, we may need to shard across multiple D1 databases. Acceptable for v1?

2. **Workers AI vs external embeddings default?** Workers AI `@cf/baai/bge-small-en-v1.5` is free and fast. We'll also support external (OpenAI, Cohere) for migration scenarios. Workers AI as default?

3. **Reflect LLM provider default?** The reflect agent needs a capable LLM (tool-calling support). Default to OpenAI `gpt-4o-mini`? Or allow Workers AI models? Workers AI models may not support tool calling reliably enough for the agentic loop.

4. **Consolidation scheduling?** The original runs consolidation as an async operation (merges raw facts into observations). On Cloudflare this would be a Queue job or Cron Trigger. How aggressively should we consolidate in v1?
