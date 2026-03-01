import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request, store } from './helpers';

let testApp: typeof app;

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
  // Pre-create bank and some memory units
  store.tables.banks.push({
    bank_id: 'test-bank',
    name: 'Test',
    disposition: '{}',
    mission: '',
    background: '',
    config: '{}',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
});

function addMemoryUnit(overrides: Partial<Record<string, unknown>> = {}) {
  const id = overrides.id || crypto.randomUUID();
  store.tables.memory_units.push({
    id,
    bank_id: 'test-bank',
    text: 'Alice works at Google',
    fact_type: 'world',
    context: 'work info',
    event_date: '2024-01-15T10:30:00Z',
    metadata: '{}',
    tags: '[]',
    created_at: '2024-01-15T10:30:00Z',
    updated_at: '2024-01-15T10:30:00Z',
    ...overrides,
  });
  return id;
}

describe('GET /v1/default/banks/:bank_id/memories/list', () => {
  it('returns empty list when no memories', async () => {
    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns memory units with correct fields', async () => {
    addMemoryUnit();
    addMemoryUnit({ text: 'Bob likes hiking', fact_type: 'experience' });

    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[]; total: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);

    // Verify response shape
    const item = body.items[0];
    expect(item.id).toBeDefined();
    expect(item.text).toBeDefined();
    expect(item.type).toBeDefined();
    expect(item.event_date).toBeDefined();
  });

  it('filters by fact type', async () => {
    addMemoryUnit({ fact_type: 'world' });
    addMemoryUnit({ fact_type: 'experience' });
    addMemoryUnit({ fact_type: 'world' });

    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list?type=world');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[]; total: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('supports pagination', async () => {
    for (let i = 0; i < 5; i++) {
      addMemoryUnit({ text: `Memory ${i}` });
    }

    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list?limit=2&offset=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; limit: number; offset: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });
});

describe('GET /v1/default/banks/:bank_id/memories/:memory_id', () => {
  it('returns memory unit by ID', async () => {
    const id = addMemoryUnit({ text: 'Specific memory' });

    const res = await request(testApp, 'GET', `/v1/default/banks/test-bank/memories/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.text).toBe('Specific memory');
  });

  it('returns 404 for non-existent memory', async () => {
    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/default/banks/:bank_id/memories/:memory_id', () => {
  it('deletes a memory unit', async () => {
    const id = addMemoryUnit();

    const res = await request(testApp, 'DELETE', `/v1/default/banks/test-bank/memories/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);

    // Verify it's gone
    const getRes = await request(testApp, 'GET', `/v1/default/banks/test-bank/memories/${id}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 for non-existent memory', async () => {
    const res = await request(testApp, 'DELETE', '/v1/default/banks/test-bank/memories/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/default/banks/:bank_id/memories (clear)', () => {
  it('clears all memories for a bank', async () => {
    addMemoryUnit();
    addMemoryUnit();
    addMemoryUnit();

    const res = await request(testApp, 'DELETE', '/v1/default/banks/test-bank/memories');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.deleted_count).toBe(3);
  });

  it('clears memories filtered by type', async () => {
    addMemoryUnit({ fact_type: 'world' });
    addMemoryUnit({ fact_type: 'world' });
    addMemoryUnit({ fact_type: 'experience' });

    const res = await request(testApp, 'DELETE', '/v1/default/banks/test-bank/memories?type=world');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deleted_count).toBe(2);

    // Experience memory should still exist
    const listRes = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list');
    const listBody = (await listRes.json()) as { items: unknown[]; total: number };
    expect(listBody.total).toBe(1);
  });
});

describe('POST /v1/default/banks/:bank_id/memories (retain)', () => {
  it('retains a single content item and stores facts', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice works at Google as a software engineer.' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.bank_id).toBe('test-bank');
    expect(body.items_count).toBe(1);
    expect(body.async).toBe(false);

    // Verify memories were stored
    const listRes = await request(testApp, 'GET', '/v1/default/banks/test-bank/memories/list');
    const listBody = (await listRes.json()) as { items: unknown[]; total: number };
    expect(listBody.total).toBeGreaterThan(0);
  });

  it('retains multiple content items', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice works at Google.' }, { content: 'Bob lives in Seattle.' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.items_count).toBe(2);
  });

  it('returns 400 for empty items', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [],
    });
    expect(res.status).toBe(400);
  });

  it('auto-creates bank if it does not exist', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/new-bank/memories', {
      items: [{ content: 'Some fact about a new bank.' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bank_id).toBe('new-bank');
  });

  it('stores documents and chunks', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice works at Google.', document_id: 'doc-123' }],
    });

    // Verify document was stored
    expect(store.tables.documents.length).toBeGreaterThan(0);
    // Verify chunks were stored
    expect(store.tables.chunks.length).toBeGreaterThan(0);
  });

  it('creates entities from extracted facts', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice works at Google in Mountain View.' }],
    });

    // Entities should be created from LLM extraction
    expect(store.tables.entities.length).toBeGreaterThan(0);
  });
});

describe('POST /v1/default/banks/:bank_id/memories/recall', () => {
  it('returns results for a query', async () => {
    // First retain some content
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice works at Google as a software engineer.' }],
    });

    // Now recall
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'What does Alice do?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('returns empty results when no memories exist', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'What does Alice do?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it('returns 400 for missing query', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {});
    expect(res.status).toBe(400);
  });

  it('includes trace when requested', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Bob lives in Seattle.' }],
    });

    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'Where does Bob live?',
      trace: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; trace: Record<string, unknown> };
    expect(body.trace).toBeDefined();
    expect(body.trace.semanticCount).toBeDefined();
    expect(body.trace.timings).toBeDefined();
  });

  it('respects budget parameter', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Fact one about testing.' }, { content: 'Fact two about testing.' }],
    });

    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'testing',
      budget: 'low',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/default/banks/:bank_id/reflect', () => {
  it('returns 200 with reflect response structure', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/reflect', {
      query: 'What do you know about AI?',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.text).toBeDefined();
    expect(typeof body.text).toBe('string');
    expect('based_on' in body).toBe(true);
    expect('usage' in body).toBe(true);
  });

  it('returns 400 for missing query', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/reflect', {});
    expect(res.status).toBe(400);
  });
});
