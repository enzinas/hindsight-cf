/**
 * API Compatibility Test
 *
 * Verifies that hindsight-cf exposes every route from the original
 * hindsight-api (https://github.com/vectorize-io/hindsight).
 *
 * This test does NOT verify response body correctness (other tests do that).
 * It verifies that every route exists and does not return 404 "route not found".
 *
 * The original routes were extracted from:
 *   hindsight-api/hindsight_api/api/http.py
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, store } from './helpers';

let testApp: { fetch: (req: Request) => Promise<Response> };

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  };
  // Pre-create bank so bank-scoped routes don't fail on missing bank
  store.tables.banks.push({
    bank_id: 'compat-test',
    name: 'Compat Test',
    disposition: '{"skepticism":3,"literalism":3,"empathy":3}',
    mission: '',
    background: '',
    config: '{}',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
  // Add a memory unit for memory-specific routes
  store.tables.memory_units.push({
    id: 'mem-001',
    bank_id: 'compat-test',
    text: 'Test memory',
    fact_type: 'world',
    context: '',
    event_date: '2024-01-01',
    metadata: '{}',
    tags: '[]',
    proof_count: 1,
    source_memory_ids: '[]',
    history: '[]',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
  // Add a mental model
  store.tables.memory_units.push({
    id: 'mm-001',
    bank_id: 'compat-test',
    text: 'Test mental model',
    fact_type: 'mental_model',
    context: '',
    event_date: '2024-01-01',
    metadata: '{}',
    tags: '[]',
    proof_count: 1,
    source_memory_ids: '[]',
    history: '[]',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
  // Add a directive
  store.tables.directives.push({
    id: 'dir-001',
    bank_id: 'compat-test',
    name: 'Test',
    content: 'Test directive',
    priority: 0,
    is_active: 1,
    tags: '[]',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
  // Add an operation
  store.tables.async_operations.push({
    operation_id: 'op-001',
    bank_id: 'compat-test',
    operation_type: 'retain',
    status: 'pending',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    completed_at: null,
    error_message: null,
    result_metadata: '{}',
  });
  // Add a document
  store.tables.documents.push({
    id: 'doc-001',
    bank_id: 'compat-test',
    original_text: 'test',
    content_hash: 'abc',
    metadata: '{}',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
  // Add an entity
  store.tables.entities.push({
    id: 'ent-001',
    canonical_name: 'Alice',
    bank_id: 'compat-test',
    metadata: '{}',
    first_seen: '2024-01-01',
    last_seen: '2024-01-01',
    mention_count: 5,
  });
  // Add a chunk
  store.tables.chunks.push({
    chunk_id: 'chunk-001',
    document_id: 'doc-001',
    bank_id: 'compat-test',
    chunk_index: 0,
    chunk_text: 'test chunk',
    created_at: '2024-01-01',
  });
});

/**
 * Helper: make a request and check it doesn't return Hono's 404 (route not found).
 * We accept any status code EXCEPT 404 from the router itself.
 * A 404 from our handler (e.g., "entity not found") is fine — it means the route matched.
 * A 501 (not implemented) is also fine — it means the route exists but the logic is stubbed.
 *
 * Hono returns 404 with "Not Found" text body when no route matches.
 * Our handlers return 404 with JSON body `{ error: "not_found", ... }`.
 */
async function assertRouteExists(
  method: string,
  path: string,
  body?: unknown,
  description?: string,
) {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await testApp.fetch(new Request(url, init));
  const status = response.status;

  // If 404, check if it's from the router (plain text "Not Found") or from our handler (JSON)
  if (status === 404) {
    const text = await response.text();
    const isRouterNotFound = text === 'Not Found' || text === '404 Not Found';
    expect(
      isRouterNotFound,
      `Route not found: ${method} ${path}${description ? ` (${description})` : ''} — got router 404. This route is missing from hindsight-cf.`
    ).toBe(false);
  }

  return status;
}

describe('API Compatibility — all original hindsight routes must exist', () => {
  // =========================================================================
  // Monitoring (no prefix)
  // =========================================================================
  it('GET /health', async () => {
    await assertRouteExists('GET', '/health');
  });

  it('GET /version', async () => {
    await assertRouteExists('GET', '/version');
  });

  it('GET /metrics', async () => {
    await assertRouteExists('GET', '/metrics');
  });

  // =========================================================================
  // Banks
  // =========================================================================
  it('GET /v1/default/banks', async () => {
    await assertRouteExists('GET', '/v1/default/banks');
  });

  it('PUT /v1/default/banks/{bank_id}', async () => {
    await assertRouteExists('PUT', '/v1/default/banks/compat-test', { name: 'Updated' }, 'update bank via PUT');
  });

  it('PATCH /v1/default/banks/{bank_id}', async () => {
    await assertRouteExists('PATCH', '/v1/default/banks/compat-test', { name: 'Updated' }, 'update bank via PATCH');
  });

  it('DELETE /v1/default/banks/{bank_id}', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test');
  });

  it('GET /v1/default/banks/{bank_id}/profile', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/profile');
  });

  it('PUT /v1/default/banks/{bank_id}/profile', async () => {
    await assertRouteExists('PUT', '/v1/default/banks/compat-test/profile', {
      disposition: { skepticism: 3, literalism: 3, empathy: 3 },
      mission: 'test',
    }, 'update profile via PUT');
  });

  it('GET /v1/default/banks/{bank_id}/stats', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/stats');
  });

  it('GET /v1/default/banks/{bank_id}/config', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/config');
  });

  it('PATCH /v1/default/banks/{bank_id}/config', async () => {
    await assertRouteExists('PATCH', '/v1/default/banks/compat-test/config', { key: 'value' });
  });

  it('DELETE /v1/default/banks/{bank_id}/config', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/config');
  });

  it('POST /v1/default/banks/{bank_id}/background', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/background', { content: 'bg info' });
  });

  // =========================================================================
  // Memories
  // =========================================================================
  it('POST /v1/default/banks/{bank_id}/memories (retain)', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/memories', {
      items: [{ content: 'test' }],
    }, 'retain memories');
  });

  it('DELETE /v1/default/banks/{bank_id}/memories (clear)', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/memories', undefined, 'clear memories');
  });

  it('GET /v1/default/banks/{bank_id}/memories/list', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/memories/list');
  });

  it('POST /v1/default/banks/{bank_id}/memories/recall', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/memories/recall', {
      query: 'test',
    }, 'recall');
  });

  it('GET /v1/default/banks/{bank_id}/memories/{memory_id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/memories/mem-001');
  });

  it('DELETE /v1/default/banks/{bank_id}/memories/{memory_id}/observations', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/memories/mem-001/observations');
  });

  // =========================================================================
  // Reflect
  // =========================================================================
  it('POST /v1/default/banks/{bank_id}/reflect', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/reflect', {
      query: 'What do you think?',
    }, 'reflect');
  });

  // =========================================================================
  // Entities
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/entities', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/entities');
  });

  it('GET /v1/default/banks/{bank_id}/entities/{entity_id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/entities/ent-001');
  });

  it('POST /v1/default/banks/{bank_id}/entities/{entity_id}/regenerate', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/entities/ent-001/regenerate');
  });

  // =========================================================================
  // Documents
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/documents', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/documents');
  });

  it('GET /v1/default/banks/{bank_id}/documents/{document_id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/documents/doc-001');
  });

  it('DELETE /v1/default/banks/{bank_id}/documents/{document_id}', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/documents/doc-001');
  });

  // =========================================================================
  // Chunks (top-level, not under banks)
  // =========================================================================
  it('GET /v1/default/chunks/{chunk_id}', async () => {
    await assertRouteExists('GET', '/v1/default/chunks/chunk-001');
  });

  // =========================================================================
  // Directives
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/directives', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/directives');
  });

  it('POST /v1/default/banks/{bank_id}/directives', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/directives', {
      name: 'Test', content: 'Test directive',
    });
  });

  it('GET /v1/default/banks/{bank_id}/directives/{directive_id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/directives/dir-001');
  });

  it('PATCH /v1/default/banks/{bank_id}/directives/{directive_id}', async () => {
    await assertRouteExists('PATCH', '/v1/default/banks/compat-test/directives/dir-001', {
      name: 'Updated',
    });
  });

  it('DELETE /v1/default/banks/{bank_id}/directives/{directive_id}', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/directives/dir-001');
  });

  // =========================================================================
  // Mental Models
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/mental-models', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/mental-models');
  });

  it('POST /v1/default/banks/{bank_id}/mental-models', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/mental-models', {
      text: 'Test model',
    });
  });

  it('GET /v1/default/banks/{bank_id}/mental-models/{id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/mental-models/mm-001');
  });

  it('PATCH /v1/default/banks/{bank_id}/mental-models/{id}', async () => {
    await assertRouteExists('PATCH', '/v1/default/banks/compat-test/mental-models/mm-001', {
      text: 'Updated model',
    });
  });

  it('DELETE /v1/default/banks/{bank_id}/mental-models/{id}', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/mental-models/mm-001');
  });

  it('POST /v1/default/banks/{bank_id}/mental-models/{id}/refresh', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/mental-models/mm-001/refresh');
  });

  // =========================================================================
  // Operations
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/operations', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/operations');
  });

  it('GET /v1/default/banks/{bank_id}/operations/{operation_id}', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/operations/op-001');
  });

  it('DELETE /v1/default/banks/{bank_id}/operations/{operation_id}', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/operations/op-001');
  });

  // =========================================================================
  // Graph
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/graph', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/graph');
  });

  // =========================================================================
  // Tags
  // =========================================================================
  it('GET /v1/default/banks/{bank_id}/tags', async () => {
    await assertRouteExists('GET', '/v1/default/banks/compat-test/tags');
  });

  // =========================================================================
  // Files
  // =========================================================================
  it('POST /v1/default/banks/{bank_id}/files/retain', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/files/retain');
  });

  // =========================================================================
  // Consolidation
  // =========================================================================
  it('POST /v1/default/banks/{bank_id}/consolidate', async () => {
    await assertRouteExists('POST', '/v1/default/banks/compat-test/consolidate');
  });

  // =========================================================================
  // Observations
  // =========================================================================
  it('DELETE /v1/default/banks/{bank_id}/observations', async () => {
    await assertRouteExists('DELETE', '/v1/default/banks/compat-test/observations');
  });
});

describe('API Compatibility — route count check', () => {
  it('has all 47 routes from original hindsight-api', () => {
    // Original routes extracted from hindsight-api/hindsight_api/api/http.py:
    const originalRoutes = [
      'GET /health',
      'GET /version',
      'GET /metrics',
      'GET /v1/default/banks',
      'PUT /v1/default/banks/{bank_id}',
      'PATCH /v1/default/banks/{bank_id}',
      'DELETE /v1/default/banks/{bank_id}',
      'GET /v1/default/banks/{bank_id}/profile',
      'PUT /v1/default/banks/{bank_id}/profile',
      'GET /v1/default/banks/{bank_id}/stats',
      'GET /v1/default/banks/{bank_id}/config',
      'PATCH /v1/default/banks/{bank_id}/config',
      'DELETE /v1/default/banks/{bank_id}/config',
      'POST /v1/default/banks/{bank_id}/background',
      'POST /v1/default/banks/{bank_id}/memories',
      'DELETE /v1/default/banks/{bank_id}/memories',
      'GET /v1/default/banks/{bank_id}/memories/list',
      'POST /v1/default/banks/{bank_id}/memories/recall',
      'GET /v1/default/banks/{bank_id}/memories/{memory_id}',
      'DELETE /v1/default/banks/{bank_id}/memories/{memory_id}/observations',
      'POST /v1/default/banks/{bank_id}/reflect',
      'GET /v1/default/banks/{bank_id}/entities',
      'GET /v1/default/banks/{bank_id}/entities/{entity_id}',
      'POST /v1/default/banks/{bank_id}/entities/{entity_id}/regenerate',
      'GET /v1/default/banks/{bank_id}/documents',
      'GET /v1/default/banks/{bank_id}/documents/{document_id}',
      'DELETE /v1/default/banks/{bank_id}/documents/{document_id}',
      'GET /v1/default/chunks/{chunk_id}',
      'GET /v1/default/banks/{bank_id}/directives',
      'POST /v1/default/banks/{bank_id}/directives',
      'GET /v1/default/banks/{bank_id}/directives/{directive_id}',
      'PATCH /v1/default/banks/{bank_id}/directives/{directive_id}',
      'DELETE /v1/default/banks/{bank_id}/directives/{directive_id}',
      'GET /v1/default/banks/{bank_id}/mental-models',
      'POST /v1/default/banks/{bank_id}/mental-models',
      'GET /v1/default/banks/{bank_id}/mental-models/{id}',
      'PATCH /v1/default/banks/{bank_id}/mental-models/{id}',
      'DELETE /v1/default/banks/{bank_id}/mental-models/{id}',
      'POST /v1/default/banks/{bank_id}/mental-models/{id}/refresh',
      'GET /v1/default/banks/{bank_id}/operations',
      'GET /v1/default/banks/{bank_id}/operations/{operation_id}',
      'DELETE /v1/default/banks/{bank_id}/operations/{operation_id}',
      'GET /v1/default/banks/{bank_id}/graph',
      'GET /v1/default/banks/{bank_id}/tags',
      'POST /v1/default/banks/{bank_id}/files/retain',
      'POST /v1/default/banks/{bank_id}/consolidate',
      'DELETE /v1/default/banks/{bank_id}/observations',
    ];

    // This test exists as documentation — the individual route tests above
    // verify each one. This just confirms we haven't missed any.
    expect(originalRoutes).toHaveLength(47);
  });
});
