/**
 * API Compatibility Test Suite
 *
 * Comprehensive comparison of hindsight-cf against the original hindsight
 * (Next.js control plane at ../hindsight/hindsight-control-plane).
 *
 * This test maps EVERY route from the original to its hindsight-cf equivalent,
 * testing both route existence and response shape where applicable.
 *
 * Routes are organized into three categories:
 *   1. IMPLEMENTED — route exists and returns expected shape
 *   2. MISSING (it.todo) — route has no equivalent in hindsight-cf yet
 *   3. RESTRUCTURED — route exists but at a different path (documented in comments)
 *
 * Original hindsight URL structure:
 *   /api/{resource}?bank_id=xxx          (flat, bank_id as query param)
 *
 * hindsight-cf URL structure:
 *   /v1/{tenant}/banks/{bank_id}/{resource}  (nested under tenant + bank)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, store } from './helpers';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testApp: { fetch: (req: Request) => Promise<Response> };

const TENANT = 'default';
const BANK = 'compat-test';
const BASE = `/v1/${TENANT}`;
const BANK_BASE = `${BASE}/banks/${BANK}`;

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  };

  // Pre-create bank
  store.tables.banks.push({
    bank_id: BANK,
    name: 'Compat Test',
    disposition: '{"skepticism":3,"literalism":3,"empathy":3}',
    mission: 'Test mission',
    background: '',
    config: '{}',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });

  // Memory units (various types for testing)
  store.tables.memory_units.push(
    {
      id: 'mem-001',
      bank_id: BANK,
      text: 'Alice likes coffee',
      fact_type: 'world',
      context: 'morning chat',
      event_date: '2024-01-01',
      metadata: '{}',
      tags: '["beverage"]',
      proof_count: 1,
      source_memory_ids: '[]',
      history: '[]',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    },
    {
      id: 'mem-002',
      bank_id: BANK,
      text: 'Observation: Alice is a coffee enthusiast',
      fact_type: 'observation',
      context: '',
      event_date: '2024-01-02',
      metadata: '{}',
      tags: '[]',
      proof_count: 2,
      source_memory_ids: '["mem-001"]',
      history: '[]',
      created_at: '2024-01-02T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    },
    {
      id: 'mm-001',
      bank_id: BANK,
      text: 'Mental model about preferences',
      fact_type: 'mental_model',
      context: '',
      event_date: '2024-01-03',
      metadata: '{"model_name":"preferences"}',
      tags: '[]',
      proof_count: 1,
      source_memory_ids: '[]',
      history: '[{"text":"v1","updated_at":"2024-01-03"}]',
      created_at: '2024-01-03T00:00:00.000Z',
      updated_at: '2024-01-03T00:00:00.000Z',
    },
  );

  // Directive
  store.tables.directives.push({
    id: 'dir-001',
    bank_id: BANK,
    name: 'Be helpful',
    content: 'Always be helpful and kind',
    priority: 0,
    is_active: 1,
    tags: '[]',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });

  // Operation
  store.tables.async_operations.push({
    operation_id: 'op-001',
    bank_id: BANK,
    operation_type: 'retain',
    status: 'completed',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:01:00.000Z',
    error_message: null,
    result_metadata: '{"items_count":1}',
  });

  // Document
  store.tables.documents.push({
    id: 'doc-001',
    bank_id: BANK,
    original_text: 'A document about coffee',
    content_hash: 'abc123',
    metadata: '{"title":"Coffee Notes"}',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  });

  // Entity
  store.tables.entities.push({
    id: 'ent-001',
    canonical_name: 'Alice',
    bank_id: BANK,
    metadata: '{}',
    first_seen: '2024-01-01T00:00:00.000Z',
    last_seen: '2024-01-01T00:00:00.000Z',
    mention_count: 5,
  });

  // Unit-entity link
  store.tables.unit_entities.push({
    unit_id: 'mem-001',
    entity_id: 'ent-001',
  });

  // Chunk
  store.tables.chunks.push({
    chunk_id: 'chunk-001',
    document_id: 'doc-001',
    bank_id: BANK,
    chunk_index: 0,
    chunk_text: 'A chunk about coffee',
    created_at: '2024-01-01T00:00:00.000Z',
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert a route exists (not a Hono router 404).
 * Returns the response for further assertions.
 */
async function assertRouteExists(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await testApp.fetch(new Request(url, init));
  const status = response.status;

  // If 404, distinguish router 404 from handler 404
  if (status === 404) {
    const text = await response.text();
    const isRouterNotFound = text === 'Not Found' || text === '404 Not Found';
    expect(
      isRouterNotFound,
      `Route not found: ${method} ${path} — Hono returned router-level 404. This route is MISSING from hindsight-cf.`,
    ).toBe(false);
    // Handler-level 404 — route exists, resource not found
    try {
      return { status, body: JSON.parse(text) };
    } catch {
      return { status, body: text };
    }
  }

  const responseBody = await response.json().catch(() => null);
  return { status, body: responseBody };
}

// =========================================================================
// SECTION 1: Monitoring / Utility Endpoints
// =========================================================================

describe('Monitoring endpoints', () => {
  // Original: GET /api/health
  it('GET /health', async () => {
    const res = await assertRouteExists('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  // Original: GET /api/version
  it('GET /version', async () => {
    const res = await assertRouteExists('GET', '/version');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
  });

  // CF-only: no original equivalent
  it('GET /metrics (CF-only)', async () => {
    const res = await assertRouteExists('GET', '/metrics');
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// SECTION 1b: Bank Template Schema
// =========================================================================

describe('Bank Template Schema', () => {
  it('GET /v1/bank-template-schema — returns JSON Schema', async () => {
    const res = await assertRouteExists('GET', '/v1/bank-template-schema');
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('title', 'BankTemplateManifest');
    expect(data).toHaveProperty('properties');
    expect(data).toHaveProperty('required');
    const props = data.properties as Record<string, unknown>;
    expect(props).toHaveProperty('version');
    expect(props).toHaveProperty('bank');
    expect(props).toHaveProperty('mental_models');
    expect(props).toHaveProperty('directives');
  });
});

// =========================================================================
// SECTION 2: Banks
// =========================================================================

describe('Banks — implemented', () => {
  // Original: GET /api/banks
  it('GET /banks — list all banks', async () => {
    const res = await assertRouteExists('GET', `${BASE}/banks`);
    expect(res.status).toBe(200);
    const data = res.body as { banks: unknown[] };
    expect(data).toHaveProperty('banks');
    expect(Array.isArray(data.banks)).toBe(true);
    expect(data.banks.length).toBeGreaterThanOrEqual(1);
    // Verify bank shape matches original
    const bank = data.banks[0] as Record<string, unknown>;
    expect(bank).toHaveProperty('bank_id');
    expect(bank).toHaveProperty('name');
    expect(bank).toHaveProperty('disposition');
    expect(bank).toHaveProperty('mission');
    expect(bank).toHaveProperty('created_at');
    expect(bank).toHaveProperty('updated_at');
  });

  // Original: PUT /api/banks/[bankId] with { name }
  it('PUT /banks/:bank_id — update bank', async () => {
    const res = await assertRouteExists('PUT', `${BANK_BASE}`, { name: 'Renamed' });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id', BANK);
  });

  // Original: PATCH /api/banks/[bankId] with { name }
  it('PATCH /banks/:bank_id — update bank', async () => {
    const res = await assertRouteExists('PATCH', `${BANK_BASE}`, { name: 'Renamed Again' });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id', BANK);
  });

  // Original: DELETE /api/banks/[bankId]
  it('DELETE /banks/:bank_id — delete bank', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('Banks — create', () => {
  // Original: POST /api/banks with { bank_id }
  it('POST /banks — explicit bank creation', async () => {
    const res = await assertRouteExists('POST', `${BASE}/banks`, { bank_id: 'new-bank', name: 'New Bank' });
    expect(res.status).toBe(201);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id', 'new-bank');
    expect(data).toHaveProperty('name', 'New Bank');
  });

  it('POST /banks — rejects duplicate', async () => {
    const res = await assertRouteExists('POST', `${BASE}/banks`, { bank_id: BANK });
    expect(res.status).toBe(409);
  });
});

// =========================================================================
// SECTION 3: Bank Profile & Config
// =========================================================================

describe('Bank profile & config — implemented', () => {
  // Original: GET /api/profile/[bankId]
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/profile
  it('GET /banks/:bank_id/profile', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/profile`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id');
    expect(data).toHaveProperty('disposition');
    expect(data).toHaveProperty('mission');
  });

  // Original: PUT /api/profile/[bankId] with { disposition, mission }
  it('PUT /banks/:bank_id/profile', async () => {
    const res = await assertRouteExists('PUT', `${BANK_BASE}/profile`, {
      disposition: { skepticism: 4, literalism: 2, empathy: 5 },
      mission: 'Updated mission',
    });
    expect(res.status).toBe(200);
  });

  // Original: GET /api/banks/[bankId]/config
  it('GET /banks/:bank_id/config', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/config`);
    expect(res.status).toBe(200);
  });

  // Original: PATCH /api/banks/[bankId]/config
  it('PATCH /banks/:bank_id/config', async () => {
    const res = await assertRouteExists('PATCH', `${BANK_BASE}/config`, { llm_model: 'custom-model' });
    expect(res.status).toBe(200);
  });

  // Original: DELETE /api/banks/[bankId]/config
  it('DELETE /banks/:bank_id/config', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/config`);
    expect(res.status).toBe(200);
  });

  // Original: part of /api/stats/[agentId]
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/stats
  it('GET /banks/:bank_id/stats — bank statistics', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/stats`);
    expect(res.status).toBe(200);
  });

  // Original: POST /api/banks/[bankId]/background (appends to mission)
  it('POST /banks/:bank_id/background — append to mission', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/background`, { content: 'Additional background' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('mission');
  });
});

// =========================================================================
// SECTION 4: Memories (Retain / Recall / List / CRUD)
// =========================================================================

describe('Memories — implemented', () => {
  // Original: POST /api/memories/retain
  // CF restructured to: POST /v1/:tenant/banks/:bank_id/memories
  it('POST /memories — retain (sync)', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/memories`, {
      items: [{ content: 'The sky is blue' }],
    });
    expect(res.status).toBeLessThan(300);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('memory_ids');
    expect(Array.isArray(data.memory_ids)).toBe(true);
    expect(data).toHaveProperty('items_count');
  });

  // Original: POST /api/memories/retain_async
  // CF: POST /memories with { async: true }
  it('POST /memories — retain (async flag)', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/memories`, {
      items: [{ content: 'Async content' }],
      async: true,
    });
    expect(res.status).toBeLessThan(300);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('operation_id');
  });

  // Original: POST /api/recall
  // CF restructured to: POST /v1/:tenant/banks/:bank_id/memories/recall
  it('POST /memories/recall — semantic recall', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/memories/recall`, {
      query: 'What does Alice like?',
    });
    expect(res.status).toBe(200);
    // CF returns recall result directly (facts array, entities, etc.)
    // SHAPE DIFF: Original wraps in { memories: [...] }
    expect(res.body).not.toBeNull();
  });

  // Original: GET /api/list?bank_id=xxx
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/memories/list
  it('GET /memories/list — paginated list', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/list`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    // Original returns: { items, limit, offset }
    expect(data).toHaveProperty('items');
    expect(Array.isArray((data as { items: unknown[] }).items)).toBe(true);
  });

  it('GET /memories/list — with pagination params', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/list?limit=10&offset=0`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[]; limit: number; offset: number };
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');
  });

  it('GET /memories/list — filter by fact_type', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/list?type=world`);
    expect(res.status).toBe(200);
  });

  // Original: GET /api/memories/[memoryId]?bank_id=xxx
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/memories/:memory_id
  it('GET /memories/:memory_id — get single memory', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/mem-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'mem-001');
    expect(data).toHaveProperty('text');
    expect(data).toHaveProperty('fact_type');
  });

  // Original: DELETE /api/list (clear all)
  // CF restructured to: DELETE /v1/:tenant/banks/:bank_id/memories
  it('DELETE /memories — clear all memories', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/memories`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });

  // CF: DELETE single memory
  it('DELETE /memories/:memory_id — delete single memory', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/memories/mem-001`);
    expect(res.status).toBe(200);
  });

  // Original: DELETE /banks/[bankId]/observations (under memories scope)
  it('DELETE /memories/:memory_id/observations', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/memories/mem-001/observations`);
    expect(res.status).toBe(200);
  });
});

describe('Memories — history', () => {
  it('GET /memories/:memory_id/history — memory version history', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/mem-001/history`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'mem-001');
    expect(data).toHaveProperty('current_text');
    expect(data).toHaveProperty('history');
    expect(Array.isArray(data.history)).toBe(true);
  });

  it('GET /memories/:memory_id/history — 404 for missing memory', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/memories/nonexistent/history`);
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// SECTION 5: Reflect
// =========================================================================

describe('Reflect — implemented', () => {
  // Original: POST /api/reflect
  // CF restructured to: POST /v1/:tenant/banks/:bank_id/reflect
  it('POST /reflect — LLM reflection with memory context', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/reflect`, {
      query: 'What do you know about Alice?',
      budget: 'low',
    });
    // May fail due to mock LLM limitations, but route should exist
    expect(res.status).not.toBe(404);
    if (res.status === 200) {
      const data = res.body as Record<string, unknown>;
      // Original returns: { text, based_on, structured_output?, usage?, trace? }
      expect(data).toHaveProperty('text');
    }
  });
});

// =========================================================================
// SECTION 6: Entities
// =========================================================================

describe('Entities — implemented', () => {
  // Original: GET /api/entities?bank_id=xxx
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/entities
  it('GET /entities — list entities', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/entities`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[] };
    // SHAPE DIFF: Original uses { entities: [...] }, CF uses { items: [...] }
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('GET /entities — with pagination', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/entities?limit=50&offset=0`);
    expect(res.status).toBe(200);
  });

  // Original: GET /api/entities/[entityId]?bank_id=xxx
  it('GET /entities/:entity_id — get entity details', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/entities/ent-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('canonical_name');
  });

  // Original: POST /api/entities/[entityId]/regenerate?bank_id=xxx
  it('POST /entities/:entity_id/regenerate — regenerate entity', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/entities/ent-001/regenerate`);
    // May fail due to mock limitations, but route should exist
    expect(res.status).not.toBe(404);
  });
});

describe('Entities — graph', () => {
  // Original: GET /api/entities/graph returns entity relationship graph
  // CF has GET /graph which serves a similar purpose
  it('GET /graph — serves as entity/fact graph (restructured from /entities/graph)', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/graph`);
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// SECTION 7: Documents
// =========================================================================

describe('Documents — implemented', () => {
  // Original: GET /api/documents?bank_id=xxx
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/documents
  it('GET /documents — list documents', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/documents`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[] };
    // SHAPE DIFF: Original uses { documents: [...] }, CF uses { items: [...] }
    expect(data).toHaveProperty('items');
  });

  // Original: GET /api/documents/[documentId]?bank_id=xxx
  it('GET /documents/:document_id — get document', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/documents/doc-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id');
  });

  // Original: DELETE /api/documents/[documentId]?bank_id=xxx
  it('DELETE /documents/:document_id — delete document', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/documents/doc-001`);
    expect(res.status).toBe(200);
  });
});

describe('Documents — update', () => {
  it('PATCH /documents/:document_id — update document metadata', async () => {
    const res = await assertRouteExists('PATCH', `${BANK_BASE}/documents/doc-001`, {
      metadata: { updated_field: 'new_value' },
    });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'doc-001');
    const meta = data.metadata as Record<string, unknown>;
    expect(meta).toHaveProperty('updated_field', 'new_value');
    // Original metadata should be preserved (merge)
    expect(meta).toHaveProperty('title', 'Coffee Notes');
  });
});

// =========================================================================
// SECTION 8: Chunks
// =========================================================================

describe('Chunks — implemented', () => {
  // Original: GET /api/chunks/[chunkId]
  // CF: GET /v1/:tenant/chunks/:chunk_id
  it('GET /chunks/:chunk_id — get chunk', async () => {
    const res = await assertRouteExists('GET', `${BASE}/chunks/chunk-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('chunk_id');
    expect(data).toHaveProperty('chunk_text');
  });
});

// =========================================================================
// SECTION 9: Directives
// =========================================================================

describe('Directives — implemented', () => {
  // Original: GET /api/banks/[bankId]/directives
  it('GET /directives — list directives', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/directives`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[] };
    // SHAPE DIFF: Original uses { directives: [...] }, CF uses { items: [...] }
    expect(data).toHaveProperty('items');
  });

  // Original: POST /api/banks/[bankId]/directives
  it('POST /directives — create directive', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/directives`, {
      name: 'New Directive',
      content: 'Do the thing',
    });
    expect(res.status).toBe(201);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name', 'New Directive');
  });

  // Original: GET /api/banks/[bankId]/directives/[directiveId]
  it('GET /directives/:directive_id — get directive', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/directives/dir-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'dir-001');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('content');
  });

  // Original: PATCH /api/banks/[bankId]/directives/[directiveId]
  it('PATCH /directives/:directive_id — update directive', async () => {
    const res = await assertRouteExists('PATCH', `${BANK_BASE}/directives/dir-001`, {
      name: 'Updated Directive',
    });
    expect(res.status).toBe(200);
  });

  // Original: DELETE /api/banks/[bankId]/directives/[directiveId]
  it('DELETE /directives/:directive_id — delete directive', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/directives/dir-001`);
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// SECTION 10: Mental Models
// =========================================================================

describe('Mental Models — implemented', () => {
  // Original: GET /api/banks/[bankId]/mental-models
  it('GET /mental-models — list mental models', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/mental-models`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[] };
    // SHAPE DIFF: Original uses { mental_models: [...] }, CF uses { items: [...] }
    expect(data).toHaveProperty('items');
  });

  // Original: POST /api/banks/[bankId]/mental-models
  it('POST /mental-models — create mental model', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/mental-models`, {
      text: 'A new mental model',
    });
    expect(res.status).toBeLessThan(300);
  });

  // Original: GET /api/banks/[bankId]/mental-models/[mentalModelId]
  it('GET /mental-models/:model_id — get mental model', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/mental-models/mm-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'mm-001');
    expect(data).toHaveProperty('text');
  });

  // Original: PATCH /api/banks/[bankId]/mental-models/[mentalModelId]
  it('PATCH /mental-models/:model_id — update mental model', async () => {
    const res = await assertRouteExists('PATCH', `${BANK_BASE}/mental-models/mm-001`, {
      text: 'Updated mental model text',
    });
    expect(res.status).toBe(200);
  });

  // Original: DELETE /api/banks/[bankId]/mental-models/[mentalModelId]
  it('DELETE /mental-models/:model_id — delete mental model', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/mental-models/mm-001`);
    expect(res.status).toBe(200);
  });

  // Original: POST /api/banks/[bankId]/mental-models/[mentalModelId]/refresh
  it('POST /mental-models/:model_id/refresh — refresh mental model', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/mental-models/mm-001/refresh`);
    // May fail in mock but route must exist
    expect(res.status).not.toBe(404);
  });
});

describe('Mental Models — history', () => {
  it('GET /mental-models/:model_id/history — mental model version history', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/mental-models/mm-001/history`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id', 'mm-001');
    expect(data).toHaveProperty('current_text');
    expect(data).toHaveProperty('history');
    expect(Array.isArray(data.history)).toBe(true);
    // mm-001 has history data in fixture
    expect((data.history as unknown[]).length).toBeGreaterThan(0);
  });
});

// =========================================================================
// SECTION 11: Operations
// =========================================================================

describe('Operations — implemented', () => {
  // Original: GET /api/operations/[agentId]?bank_id=xxx (lists operations)
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/operations
  it('GET /operations — list operations', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/operations`);
    expect(res.status).toBe(200);
    const data = res.body as { bank_id: string; operations: unknown[] };
    expect(data).toHaveProperty('bank_id', BANK);
    expect(data).toHaveProperty('operations');
    expect(Array.isArray(data.operations)).toBe(true);
  });

  // Original: GET /api/banks/[bankId]/operations/[operationId]
  it('GET /operations/:operation_id — get operation status', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/operations/op-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('operation_id');
    expect(data).toHaveProperty('status');
  });

  // Original: DELETE /api/operations/[agentId] (deletes/cancels)
  // CF: DELETE /v1/:tenant/banks/:bank_id/operations/:operation_id
  it('DELETE /operations/:operation_id — cancel operation', async () => {
    // Add a pending operation (completed ones return 409)
    store.tables.async_operations.push({
      operation_id: 'op-pending',
      bank_id: BANK,
      operation_type: 'retain',
      status: 'pending',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      completed_at: null,
      error_message: null,
      result_metadata: '{}',
    });
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/operations/op-pending`);
    expect(res.status).toBe(200);
  });
});

describe('Operations — retry', () => {
  it('POST /operations/:operation_id — retry failed operation', async () => {
    // Add a failed operation to retry
    store.tables.async_operations.push({
      operation_id: 'op-failed',
      bank_id: BANK,
      operation_type: 'retain',
      status: 'failed',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      completed_at: null,
      error_message: 'Something went wrong',
      result_metadata: '{}',
      task_payload: '{"items":[{"content":"retry me"}]}',
      retry_count: 0,
    });
    const res = await assertRouteExists('POST', `${BANK_BASE}/operations/op-failed/retry`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('operation_id', 'op-failed');
    expect(data).toHaveProperty('operation_type', 'retain');
  });

  it('POST /operations/:operation_id/retry — rejects retry of non-failed operation', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/operations/op-001/retry`);
    expect(res.status).toBe(409);
  });
});

// =========================================================================
// SECTION 12: Graph & Tags
// =========================================================================

describe('Graph & Tags — implemented', () => {
  // Original: GET /api/graph?bank_id=xxx
  // CF restructured to: GET /v1/:tenant/banks/:bank_id/graph
  it('GET /graph — knowledge graph', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/graph`);
    expect(res.status).toBe(200);
  });

  it('GET /graph — with limit param', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/graph?limit=10`);
    expect(res.status).toBe(200);
  });

  // CF-specific (no exact original equivalent, but useful)
  it('GET /tags — list unique tags', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/tags`);
    expect(res.status).toBe(200);
    const data = res.body as { tags: string[] };
    expect(data).toHaveProperty('tags');
  });
});

// =========================================================================
// SECTION 13: Files
// =========================================================================

describe('Files — partially implemented', () => {
  // Original: POST /api/files/retain
  // CF restructured to: POST /v1/:tenant/banks/:bank_id/files/retain
  // Currently returns 404 with "feature_disabled" — route exists but feature is gated
  it('POST /files/retain — route exists (feature disabled)', async () => {
    const url = `http://localhost${BANK_BASE}/files/retain`;
    const response = await testApp.fetch(new Request(url, { method: 'POST' }));
    // Accept either a working response or a handler-level 404 (feature disabled)
    // but NOT a router-level 404
    if (response.status === 404) {
      const body = await response.json() as Record<string, unknown>;
      // If it returns JSON with "feature_disabled", the route exists
      expect(body).toHaveProperty('error', 'feature_disabled');
    } else {
      expect(response.status).toBeLessThan(500);
    }
  });
});

// =========================================================================
// SECTION 14: Consolidation & Observations
// =========================================================================

describe('Consolidation & Observations — implemented', () => {
  // Original: POST /api/banks/[bankId]/consolidate
  it('POST /consolidate — consolidate facts', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/consolidate`);
    expect(res.status).not.toBe(404);
  });

  it('POST /consolidate — with options', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/consolidate`, {
      fact_types: ['world'],
      max_groups: 5,
      min_group_size: 2,
    });
    expect(res.status).not.toBe(404);
  });

  // Original: DELETE /api/banks/[bankId]/observations
  it('DELETE /observations — clear all observations', async () => {
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/observations`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('Consolidation & Observations — additional routes', () => {
  it('POST /consolidation/recover — recover stuck consolidation ops', async () => {
    // Add a stuck consolidation operation
    store.tables.async_operations.push({
      operation_id: 'op-stuck',
      bank_id: BANK,
      operation_type: 'consolidate',
      status: 'processing',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      completed_at: null,
      error_message: null,
      result_metadata: '{}',
    });
    const res = await assertRouteExists('POST', `${BANK_BASE}/consolidation/recover`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('recovered_count');
    expect((data.recovered_count as number)).toBeGreaterThanOrEqual(1);
  });

  it('GET /observations — list all observations', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/observations`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[] };
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);
    // mem-002 is an observation in our fixture
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /observations/:model_id — get observations for mental model', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/observations/mm-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('model_id', 'mm-001');
    expect(data).toHaveProperty('items');
  });

  it('GET /observations/:model_id — 404 for missing model', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/observations/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// SECTION 15: Webhooks — ALL MISSING
// =========================================================================

describe('Webhooks — implemented', () => {
  it('GET /webhooks — list webhooks (empty)', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/webhooks`);
    expect(res.status).toBe(200);
    const data = res.body as { webhooks: unknown[] };
    expect(data).toHaveProperty('webhooks');
    expect(Array.isArray(data.webhooks)).toBe(true);
  });

  it('POST /webhooks — create webhook', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/webhooks`, {
      url: 'https://hooks.example.com/callback',
      events: ['memory.created'],
      description: 'Test webhook',
    });
    expect(res.status).toBe(201);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('url', 'https://hooks.example.com/callback');
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('is_active', true);
  });

  it('PATCH /webhooks/:webhook_id — update webhook', async () => {
    // Create a webhook first
    store.tables.webhooks.push({
      id: 'wh-001',
      bank_id: BANK,
      url: 'https://hooks.example.com/callback',
      events: '["memory.created"]',
      secret: null,
      is_active: 1,
      description: 'Test',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const res = await assertRouteExists('PATCH', `${BANK_BASE}/webhooks/wh-001`, {
      url: 'https://hooks.example.com/updated',
    });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('url', 'https://hooks.example.com/updated');
  });

  it('DELETE /webhooks/:webhook_id — delete webhook', async () => {
    store.tables.webhooks.push({
      id: 'wh-del',
      bank_id: BANK,
      url: 'https://hooks.example.com/del',
      events: '[]',
      secret: null,
      is_active: 1,
      description: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const res = await assertRouteExists('DELETE', `${BANK_BASE}/webhooks/wh-del`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });

  it('GET /webhooks/:webhook_id/deliveries — list deliveries', async () => {
    store.tables.webhooks.push({
      id: 'wh-dlv',
      bank_id: BANK,
      url: 'https://hooks.example.com/dlv',
      events: '[]',
      secret: null,
      is_active: 1,
      description: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    const res = await assertRouteExists('GET', `${BANK_BASE}/webhooks/wh-dlv/deliveries`);
    expect(res.status).toBe(200);
    const data = res.body as { deliveries: unknown[] };
    expect(data).toHaveProperty('deliveries');
    expect(Array.isArray(data.deliveries)).toBe(true);
  });
});

// =========================================================================
// SECTION 16: Audit Logs — ALL MISSING
// =========================================================================

describe('Audit Logs — implemented', () => {
  it('GET /audit-logs — list audit logs', async () => {
    // Add an audit log entry
    store.tables.audit_logs.push({
      id: 'al-001',
      bank_id: BANK,
      action: 'create',
      resource_type: 'memory',
      resource_id: 'mem-001',
      details: '{}',
      actor: null,
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const res = await assertRouteExists('GET', `${BANK_BASE}/audit-logs`);
    expect(res.status).toBe(200);
    const data = res.body as { items: unknown[]; total: number };
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /audit-logs/stats — audit log statistics', async () => {
    store.tables.audit_logs.push({
      id: 'al-002',
      bank_id: BANK,
      action: 'delete',
      resource_type: 'memory',
      resource_id: 'mem-002',
      details: '{}',
      actor: null,
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const res = await assertRouteExists('GET', `${BANK_BASE}/audit-logs/stats`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id', BANK);
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('by_action');
    expect(data).toHaveProperty('by_resource');
  });
});

// =========================================================================
// SECTION 17: Export / Import — ALL MISSING
// =========================================================================

describe('Export / Import — implemented', () => {
  it('GET /export — export bank as template', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/export`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('exported_at');
    expect(data).toHaveProperty('bank');
    expect(data).toHaveProperty('memories');
    expect(data).toHaveProperty('entities');
    expect(data).toHaveProperty('directives');
    expect(data).toHaveProperty('documents');
    expect(Array.isArray(data.memories)).toBe(true);
  });

  it('POST /import?dry_run=true — dry-run import', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/import?dry_run=true`, {
      version: '1.0',
      bank: { name: 'Imported' },
      memories: [{ text: 'fact 1', fact_type: 'world' }],
      directives: [{ name: 'Rule', content: 'Do X' }],
    });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('dry_run', true);
    const summary = data.summary as Record<string, unknown>;
    expect(summary.memories_imported).toBe(1);
    expect(summary.directives_imported).toBe(1);
  });

  it('POST /import — import bank from template', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/import`, {
      version: '1.0',
      bank: { name: 'Imported', mission: 'New mission' },
      memories: [{ text: 'Imported fact', fact_type: 'world' }],
      directives: [{ name: 'Imported Rule', content: 'Do Y' }],
    });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('dry_run', false);
    const summary = data.summary as Record<string, unknown>;
    expect(summary.bank_updated).toBe(true);
    expect(summary.memories_imported).toBe(1);
    expect(summary.directives_imported).toBe(1);
  });
});

// =========================================================================
// SECTION 18: Stats Timeseries — MISSING
// =========================================================================

describe('Stats — timeseries', () => {
  it('GET /stats/memories-timeseries — memory creation timeseries', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/stats/memories-timeseries?period=7d`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id', BANK);
    expect(data).toHaveProperty('period', '7d');
    expect(data).toHaveProperty('timeseries');
    expect(Array.isArray(data.timeseries)).toBe(true);
  });
});

// =========================================================================
// SECTION 19: Route Count Summary
// =========================================================================

// =========================================================================
// SECTION 20: Response Shape Differences
// These are routes that EXIST but return a different JSON shape than original.
// Fixing these is needed for true API compatibility.
// =========================================================================

describe('Response shape verification (fixed compat issues)', () => {
  // These were identified as shape mismatches and have been fixed:
  // ✓ POST /memories (retain) now returns memory_ids
  // ✓ GET /operations now uses { operations: [...] } with bank_id
  // ✓ POST /memories/recall already returns { results, trace, entities, chunks, source_facts }
  // ✓ GET /entities, /documents, /directives, /mental-models, /memories/list all use { items } — matches OpenAPI spec

  it('POST /memories/recall returns { results } matching OpenAPI RecallResponse', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/memories/recall`, {
      query: 'coffee',
    });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('GET /operations returns { bank_id, operations } matching OpenAPI OperationsListResponse', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/operations`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('bank_id');
    expect(data).toHaveProperty('operations');
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');
  });

  it('POST /memories (retain sync) returns memory_ids array', async () => {
    const res = await assertRouteExists('POST', `${BANK_BASE}/memories`, {
      items: [{ content: 'Shape test content' }],
    });
    expect(res.status).toBeLessThan(300);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('memory_ids');
    expect(Array.isArray(data.memory_ids)).toBe(true);
  });

  it('GET /operations/:id returns both id and operation_id fields', async () => {
    const res = await assertRouteExists('GET', `${BANK_BASE}/operations/op-001`);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('operation_id');
    expect(data).toHaveProperty('task_type');
    expect(data).toHaveProperty('operation_type');
    expect(data.id).toBe(data.operation_id);
    expect(data.task_type).toBe(data.operation_type);
  });
});

describe('API parity summary', () => {
  it('documents the full route mapping between original and CF', () => {
    // This is a documentation test — it maintains the canonical mapping.
    // Update counts as routes are implemented.
    const mapping = {
      // [original route]: [CF status]
      // Monitoring
      'GET /health': 'implemented',
      'GET /version': 'implemented',
      'GET /metrics': 'cf-only',

      // Banks CRUD
      'GET /banks': 'implemented',
      'POST /banks': 'implemented',
      'PUT /banks/:id': 'implemented',
      'PATCH /banks/:id': 'implemented',
      'DELETE /banks/:id': 'implemented',

      // Profile & Config
      'GET /profile/:id': 'restructured → /banks/:id/profile',
      'PUT /profile/:id': 'restructured → /banks/:id/profile',
      'GET /banks/:id/config': 'implemented',
      'PATCH /banks/:id/config': 'implemented',
      'DELETE /banks/:id/config': 'implemented',
      'GET /stats/:id': 'restructured → /banks/:id/stats',
      'POST /banks/:id/background': 'implemented',

      // Memories
      'POST /memories/retain': 'restructured → /banks/:id/memories',
      'POST /memories/retain_async': 'restructured → /banks/:id/memories (async:true)',
      'POST /recall': 'restructured → /banks/:id/memories/recall',
      'GET /list': 'restructured → /banks/:id/memories/list',
      'DELETE /list': 'restructured → DELETE /banks/:id/memories',
      'GET /memories/:id': 'restructured → /banks/:id/memories/:id',
      'GET /memories/:id/history': 'implemented',
      'DELETE /banks/:id/memories/:id/observations': 'implemented',

      // Reflect
      'POST /reflect': 'restructured → /banks/:id/reflect',

      // Entities
      'GET /entities': 'restructured → /banks/:id/entities',
      'GET /entities/:id': 'restructured → /banks/:id/entities/:id',
      'POST /entities/:id/regenerate': 'restructured → /banks/:id/entities/:id/regenerate',
      'GET /entities/graph': 'restructured → /banks/:id/graph',

      // Documents
      'GET /documents': 'restructured → /banks/:id/documents',
      'GET /documents/:id': 'restructured → /banks/:id/documents/:id',
      'DELETE /documents/:id': 'restructured → /banks/:id/documents/:id',
      'PATCH /documents/:id': 'implemented',

      // Chunks
      'GET /chunks/:id': 'implemented',

      // Directives
      'GET /banks/:id/directives': 'implemented',
      'POST /banks/:id/directives': 'implemented',
      'GET /banks/:id/directives/:did': 'implemented',
      'PATCH /banks/:id/directives/:did': 'implemented',
      'DELETE /banks/:id/directives/:did': 'implemented',

      // Mental Models
      'GET /banks/:id/mental-models': 'implemented',
      'POST /banks/:id/mental-models': 'implemented',
      'GET /banks/:id/mental-models/:mid': 'implemented',
      'PATCH /banks/:id/mental-models/:mid': 'implemented',
      'DELETE /banks/:id/mental-models/:mid': 'implemented',
      'POST /banks/:id/mental-models/:mid/refresh': 'implemented',
      'GET /banks/:id/mental-models/:mid/history': 'implemented',

      // Operations
      'GET /operations/:id': 'restructured → /banks/:id/operations',
      'DELETE /operations/:id': 'restructured → /banks/:id/operations/:oid',
      'GET /banks/:id/operations/:oid': 'implemented',
      'POST /banks/:id/operations/:oid': 'implemented',

      // Graph
      'GET /graph': 'restructured → /banks/:id/graph',

      // Files
      'POST /files/retain': 'restructured → /banks/:id/files/retain',

      // Consolidation & Observations
      'POST /banks/:id/consolidate': 'implemented',
      'POST /banks/:id/consolidation/recover': 'implemented',
      'GET /banks/:id/observations': 'implemented',
      'DELETE /banks/:id/observations': 'implemented',
      'GET /banks/:id/observations/:mid': 'implemented',

      // Webhooks (entire feature)
      'GET /banks/:id/webhooks': 'implemented',
      'POST /banks/:id/webhooks': 'implemented',
      'PATCH /banks/:id/webhooks/:wid': 'implemented',
      'DELETE /banks/:id/webhooks/:wid': 'implemented',
      'GET /banks/:id/webhooks/:wid/deliveries': 'implemented',

      // Audit Logs (entire feature)
      'GET /banks/:id/audit-logs': 'implemented',
      'GET /banks/:id/audit-logs/stats': 'implemented',

      // Export / Import (entire feature)
      'GET /banks/:id/export': 'implemented',
      'POST /banks/:id/import': 'implemented',

      // Stats
      'GET /stats/:id/memories-timeseries': 'restructured → /banks/:id/stats/memories-timeseries',
    };

    const entries = Object.entries(mapping);
    const implemented = entries.filter(([, v]) => v === 'implemented').length;
    const restructured = entries.filter(([, v]) => v.startsWith('restructured')).length;
    const missing = entries.filter(([, v]) => v.startsWith('missing')).length;
    const cfOnly = entries.filter(([, v]) => v === 'cf-only').length;

    // Log for visibility in test output
    console.log('\n=== API PARITY REPORT ===');
    console.log(`Total original routes: ${entries.length - cfOnly}`);
    console.log(`  Implemented:   ${implemented} (same path)`);
    console.log(`  Restructured:  ${restructured} (different path, same feature)`);
    console.log(`  Missing:       ${missing}`);
    console.log(`  CF-only:       ${cfOnly}`);
    console.log(`  Parity:        ${Math.round(((implemented + restructured) / (entries.length - cfOnly)) * 100)}%`);
    console.log('\nMissing routes:');
    entries
      .filter(([, v]) => v.startsWith('missing'))
      .forEach(([route, detail]) => {
        console.log(`  ✗ ${route} — ${detail}`);
      });
    console.log('========================\n');

    // Assert we're tracking all routes
    expect(entries.length).toBeGreaterThanOrEqual(60);
    // Assert parity is above a minimum threshold (update as routes are added)
    const parityPercent = ((implemented + restructured) / (entries.length - cfOnly)) * 100;
    expect(parityPercent).toBeGreaterThan(95); // All routes implemented or restructured
  });
});
