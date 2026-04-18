/**
 * Live integration tests against a deployed hindsight-cf instance.
 *
 * Runs real API calls — no mocks. Requires:
 *   LIVE_TEST_URL=https://your-worker.workers.dev  (no trailing slash)
 *   LIVE_TEST_API_KEY=...                           (optional, if auth is enabled)
 *
 * Run:
 *   LIVE_TEST_URL=https://hindsight-cf.example.com npx vitest run tests/live.test.ts
 *
 * Uses a dedicated bank ("__live-test-ephemeral") and cleans up after itself.
 *
 * Failure messages are annotated with `[HINT]` lines pointing at likely
 * causes (auth, URL, throttling, schema drift, etc.) so a first-time user
 * can diagnose problems without reading the source.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { API_KEY, BASE_URL, apiCall, expectOk, runLive, statusHint, type ApiResult } from './live-helpers';

const BANK_ID = '__live-test-ephemeral';
const BANK_BASE = `${BASE_URL}/v1/default/banks/${BANK_ID}`;

/** Bank-scoped typed fetch. */
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiCall<T>(`${BANK_BASE}${path}`, method, body);
}

/** Fetch a URL outside the bank base (e.g. /version). */
async function rawFetch<T = unknown>(url: string): Promise<ApiResult<T>> {
  return apiCall<T>(url, 'GET');
}

/** Upload files via multipart/form-data. Do NOT set Content-Type — fetch sets the boundary. */
async function uploadFiles(
  files: Array<{ name: string; content: string; type: string }>,
  metadata?: Record<string, unknown>,
): Promise<ApiResult<unknown>> {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([f.content], { type: f.type }), f.name);
  }
  if (metadata) {
    form.append('request', JSON.stringify(metadata));
  }
  const h: Record<string, string> = {};
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  const url = `${BANK_BASE}/files/retain`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: h, body: form });
  } catch (e) {
    throw new Error(
      `[HINT] POST ${url} — network error during file upload. Underlying: ${(e as Error).message}`,
    );
  }
  const rawText = await res.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { _raw: rawText };
    }
  }
  return { status: res.status, ok: res.ok, body: parsed, rawText };
}

/** Poll an operation until completed or failed (max 60s). */
async function pollOperation(operationId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await api<{ status: string }>('GET', `/operations/${operationId}`);
    if (!res.ok) continue;
    if (res.body.status === 'completed' || res.body.status === 'failed') return res.body.status;
  }
  return 'timeout';
}

// ─── Esoteric facts for testing (real, unlikely to collide) ─────────────────

const FACTS = {
  tardigrade:
    'In 2007, tardigrades became the first known animals to survive exposure to the vacuum and radiation of outer space during the FOTON-M3 mission.',
  axolotl:
    'The axolotl can regenerate entire limbs, spinal cord, heart, and portions of its brain, making it the only vertebrate capable of full organ regeneration throughout its adult life.',
  platypus:
    'The male platypus has venomous spurs on its hind legs that deliver crotalus-like venom, making it one of the few venomous mammals in existence.',
};

// ─── 0. Preflight (auth + reachability) ─────────────────────────────────────

describe.skipIf(!runLive)('Live: Preflight', { timeout: 15_000 }, () => {
  it('LIVE_TEST_URL is set and /version responds 200', async () => {
    expect(
      BASE_URL,
      '[HINT] Set LIVE_TEST_URL=https://<your-worker>.workers.dev (no trailing slash) before running.',
    ).toBeTruthy();
    const res = await rawFetch<{ version: string }>(`${BASE_URL}/version`);
    expectOk(res, 'GET /version');
  });
});

// ─── 1. Retain → Recall round-trip ──────────────────────────────────────────

describe.skipIf(!runLive)('Live: Retain → Recall', { timeout: 30_000 }, () => {
  it('retains an esoteric fact', async () => {
    const res = await api<{ success: boolean; items_count: number }>('POST', '/memories', {
      items: [
        { content: FACTS.tardigrade, context: 'Live integration test — safe to delete', tags: ['__live-test'] },
      ],
    });
    const body = expectOk(res, 'POST /memories (retain)');
    expect(
      body.success,
      '[HINT] Retain returned success:false. Check worker logs — LLM extraction or embedding binding may be failing. Common: AI binding missing, or DEFAULT_LLM_MODEL slug invalid.',
    ).toBe(true);
    expect(
      body.items_count,
      `[HINT] Expected items_count=1, got ${body.items_count}. An item may have been rejected during extraction.`,
    ).toBe(1);
  });

  it('recalls the retained fact by semantic query', async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await api<{ results: Array<{ id: string; text: string }> }>('POST', '/memories/recall', {
      query: 'Which animal survived outer space on the FOTON-M3 mission?',
      budget: 'mid',
      tags: ['__live-test'],
      tags_match: 'any',
    });
    const body = expectOk(res, 'POST /memories/recall');

    expect(
      body.results.length,
      '[HINT] Recall returned 0 results. Likely: Vectorize index empty (retain never wrote), embedding dimension mismatch (expected 1024 for bge-m3), or the semantic fallback is off.',
    ).toBeGreaterThan(0);

    const matched = body.results.some(
      (r) => r.text.toLowerCase().includes('tardigrade') || r.text.toLowerCase().includes('foton'),
    );
    expect(
      matched,
      `[HINT] Retained fact found no match in recall results. The retrieval works but ranking/relevance is off. First result: "${body.results[0]?.text.slice(0, 200)}"`,
    ).toBe(true);
  });

  it('recalls with trace and verifies pipeline stages ran', async () => {
    const res = await api<{
      results: unknown[];
      trace: {
        semanticCount: number;
        ftsCount: number;
        fusedCount: number;
        rerankedCount: number;
        timings: Record<string, number>;
      };
    }>('POST', '/memories/recall', {
      query: 'tardigrade space survival',
      trace: true,
      tags: ['__live-test'],
      tags_match: 'any',
    });
    const body = expectOk(res, 'POST /memories/recall (trace)');

    expect(
      body.trace,
      '[HINT] trace was not returned even though trace:true was sent. Check src/routes/recall.ts honors the trace flag.',
    ).toBeDefined();
    expect(
      body.trace.timings.retrieval_ms,
      '[HINT] trace.timings.retrieval_ms is 0/missing. Recall pipeline may have short-circuited.',
    ).toBeGreaterThan(0);
  });
});

// ─── 2. Multi-item retain, tags, and memory CRUD ────────────────────────────

describe.skipIf(!runLive)('Live: Multi-item retain and memory CRUD', { timeout: 60_000 }, () => {
  const retainedIds: string[] = [];

  it('retains multiple facts in one call', async () => {
    const res = await api<{ success: boolean; items_count: number }>('POST', '/memories', {
      items: [
        { content: FACTS.axolotl, tags: ['__live-test', 'biology'] },
        { content: FACTS.platypus, tags: ['__live-test', 'biology'] },
      ],
    });
    const body = expectOk(res, 'POST /memories (multi-item)');
    expect(body.success, '[HINT] Multi-item retain returned success:false.').toBe(true);
    expect(
      body.items_count,
      `[HINT] Expected 2 items retained, got ${body.items_count}. One extraction likely failed silently.`,
    ).toBe(2);
  });

  it('lists memories and finds the retained facts', async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await api<{ items: Array<{ id: string; text: string }>; total: number }>(
      'GET',
      '/memories/list?limit=50',
    );
    const body = expectOk(res, 'GET /memories/list');
    expect(
      body.items.length,
      '[HINT] /memories/list returned 0 items but we just retained 3. D1 write may have failed — check `wrangler d1 execute --remote` to confirm the row count.',
    ).toBeGreaterThan(0);

    for (const m of body.items) retainedIds.push(m.id);
    expect(retainedIds.length).toBeGreaterThan(0);
  });

  it('gets a single memory by ID', async () => {
    if (retainedIds.length === 0) return;
    const res = await api<{ id: string; text: string; fact_type: string }>(
      'GET',
      `/memories/${retainedIds[0]}`,
    );
    const body = expectOk(res, `GET /memories/${retainedIds[0]}`);
    expect(body.id, '[HINT] GET /memories/:id returned a different id than requested — route handler bug.').toBe(
      retainedIds[0],
    );
    expect(body.text, '[HINT] Memory .text is empty — schema drift.').toBeTruthy();
    expect(body.fact_type, '[HINT] Memory .fact_type is empty — should be set by retain (world/experience/etc).').toBeTruthy();
  });

  it('deletes a single memory by ID', async () => {
    if (retainedIds.length === 0) return;

    const idToDelete = retainedIds.pop()!;
    const delRes = await api('DELETE', `/memories/${idToDelete}`);
    expectOk(delRes, `DELETE /memories/${idToDelete}`);

    const getRes = await api('GET', `/memories/${idToDelete}`);
    expect(
      getRes.status,
      `[HINT] Memory still readable after DELETE — delete handler likely skipped Vectorize/D1. Got status ${getRes.status}.`,
    ).toBe(404);
  });

  it('recalls with tag filter returns only tagged results', async () => {
    const res = await api<{ results: Array<{ id: string; text: string; tags?: string[] }> }>(
      'POST',
      '/memories/recall',
      { query: 'animal biology regeneration venom', budget: 'mid', tags: ['biology'], tags_match: 'any' },
    );
    const body = expectOk(res, 'POST /memories/recall (tag filter)');

    for (const r of body.results) {
      expect(
        r.tags,
        `[HINT] Recall with tags:['biology'] returned a result missing the tag. Tag propagation broken in src/routes/recall.ts or vector filter. Offender: "${r.text.slice(0, 200)}" tags=${JSON.stringify(r.tags)}`,
      ).toContain('biology');
    }
  });
});

// ─── 3. Bank profile and config ─────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Bank profile and config', { timeout: 15_000 }, () => {
  it('reads bank profile (auto-creates bank)', async () => {
    const res = await api<{
      bank_id: string;
      name: string;
      disposition: { skepticism: number; literalism: number; empathy: number };
      mission: string;
    }>('GET', '/profile');
    const body = expectOk(res, 'GET /profile');

    expect(
      body.bank_id,
      `[HINT] /profile.bank_id mismatch: expected ${BANK_ID}, got ${body.bank_id}. Tenant routing may be broken.`,
    ).toBe(BANK_ID);
    expect(body.disposition, '[HINT] disposition missing — schema drift or ensureBank() not setting defaults.').toBeDefined();
    expect(typeof body.disposition.skepticism).toBe('number');
    expect(typeof body.disposition.literalism).toBe('number');
    expect(typeof body.disposition.empathy).toBe('number');
  });

  it('updates disposition and reads it back', async () => {
    const newDisposition = { skepticism: 2, literalism: 4, empathy: 3 };
    const putRes = await api('PUT', '/profile/disposition', { disposition: newDisposition });
    expectOk(putRes, 'PUT /profile/disposition');

    const getRes = await api<{ disposition: typeof newDisposition }>('GET', '/profile');
    const body = expectOk(getRes, 'GET /profile (after update)');
    expect(
      body.disposition,
      '[HINT] disposition did not round-trip through PUT → GET. Check src/routes/banks.ts disposition handler.',
    ).toEqual(newDisposition);
  });

  it('sets mission and reads it back', async () => {
    const mission = 'Live test mission — remember esoteric animal facts';
    const putRes = await api('PUT', '/profile/mission', { content: mission });
    expectOk(putRes, 'PUT /profile/mission');

    const getRes = await api<{ mission: string }>('GET', '/profile');
    const body = expectOk(getRes, 'GET /profile (after mission update)');
    expect(body.mission, '[HINT] mission did not persist. Check banks table write path.').toBe(mission);
  });

  it('patches config with a strategy and reads it back', async () => {
    const patchRes = await api('PATCH', '/config', {
      strategies: {
        test_strategy: {
          chunk_size: 2000,
          extraction_mode: 'verbatim',
          retain_mission: 'Extract everything for testing',
        },
      },
    });
    expectOk(patchRes, 'PATCH /config');

    const getRes = await api<{ config: { strategies: Record<string, unknown> } }>('GET', '/config');
    const body = expectOk(getRes, 'GET /config (after patch)');
    expect(
      body.config.strategies.test_strategy,
      '[HINT] Strategy patched but not returned by GET. Config merge logic broken.',
    ).toBeDefined();
  });

  it('resets config to defaults', async () => {
    const res = await api('DELETE', '/config');
    expectOk(res, 'DELETE /config');

    const getRes = await api<{ overrides: Record<string, unknown> }>('GET', '/config');
    const body = expectOk(getRes, 'GET /config (after reset)');
    expect(
      body.overrides,
      '[HINT] DELETE /config did not clear overrides. Check reset handler in src/routes/banks.ts.',
    ).toEqual({});
  });
});

// ─── 4. Bank stats ──────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Bank stats', { timeout: 10_000 }, () => {
  it('returns stats with expected structure', async () => {
    const res = await api<{
      bank_id: string;
      memories: { total: number; world: number; experience: number; observation: number; mental_model: number };
      entities: number;
      documents: number;
    }>('GET', '/stats');
    const body = expectOk(res, 'GET /stats');

    expect(body.bank_id, '[HINT] /stats.bank_id mismatch — tenant routing bug.').toBe(BANK_ID);
    expect(typeof body.memories.total, '[HINT] /stats.memories.total is not a number — schema drift.').toBe('number');
    expect(body.memories.total).toBeGreaterThanOrEqual(0);
    expect(typeof body.entities).toBe('number');
    expect(typeof body.documents).toBe('number');
  });
});

// ─── 5. Entities ────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Entities', { timeout: 10_000 }, () => {
  it('lists entities for the bank', async () => {
    const res = await api<{ items: Array<{ id: string; canonical_name: string }> }>('GET', '/entities');
    const body = expectOk(res, 'GET /entities');

    expect(Array.isArray(body.items), '[HINT] /entities.items is not an array — response shape drift.').toBe(true);
    if (body.items.length > 0) {
      expect(body.items[0].id, '[HINT] entity.id missing — schema drift.').toBeTruthy();
      expect(body.items[0].canonical_name, '[HINT] entity.canonical_name missing — schema drift.').toBeTruthy();
    }
  });
});

// ─── 6. Directives ──────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Directives CRUD', { timeout: 15_000 }, () => {
  let directiveId: string;

  it('creates a directive', async () => {
    const res = await api<{ id: string; name: string; content: string }>('POST', '/directives', {
      name: '__live-test-directive',
      content: 'Always mention the source when recalling animal facts.',
      priority: 5,
      tags: ['__live-test'],
    });
    const body = expectOk(res, 'POST /directives', 201);
    expect(
      body.id,
      '[HINT] POST /directives did not return an id. Has the directives table migration run? Check migrations/.',
    ).toBeTruthy();
    expect(body.name).toBe('__live-test-directive');
    directiveId = body.id;
  });

  it('lists directives and finds the created one', async () => {
    const res = await api<{ items: Array<{ id: string; name: string }> }>('GET', '/directives');
    const body = expectOk(res, 'GET /directives');
    const found = body.items.some((d) => d.id === directiveId);
    expect(
      found,
      `[HINT] Newly-created directive ${directiveId} missing from /directives list. Likely a bank-filter bug.`,
    ).toBe(true);
  });

  it('deletes the directive', async () => {
    if (!directiveId) return;

    const res = await api('DELETE', `/directives/${directiveId}`);
    expectOk(res, `DELETE /directives/${directiveId}`);

    const listRes = await api<{ items: Array<{ id: string }> }>('GET', '/directives');
    const body = expectOk(listRes, 'GET /directives (after delete)');
    const found = body.items.some((d) => d.id === directiveId);
    expect(
      found,
      '[HINT] Directive still present after DELETE — hard-delete not implemented, or cache stale.',
    ).toBe(false);
  });
});

// ─── 7. Reflect (LLM reasoning over memories) ──────────────────────────────

describe.skipIf(!runLive)('Live: Reflect', { timeout: 60_000 }, () => {
  it('reflects over retained memories and returns a reasoned answer', async () => {
    const res = await api<{
      text: string;
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    }>('POST', '/reflect', {
      query: 'What unusual survival abilities do the animals in my memories have?',
      budget: 'low',
    });
    const body = expectOk(res, 'POST /reflect (basic)');

    expect(
      body.text,
      '[HINT] Reflect returned empty text. LLM call likely failed — check worker logs for the `[reflect]` error line.',
    ).toBeTruthy();
    expect(
      body.text.length,
      `[HINT] Reflect text is suspiciously short (${body.text.length} chars). Model may have returned only thinking tokens or hit a parsing bug.`,
    ).toBeGreaterThan(20);

    if (body.usage) {
      expect(
        typeof body.usage.total_tokens,
        '[HINT] usage.total_tokens wrong type. Usage reporting drift in src/engine/reflect/agent.ts.',
      ).toBe('number');
    }
  });
});

// ─── 8. Documents ───────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Documents', { timeout: 10_000 }, () => {
  it('lists documents for the bank', async () => {
    const res = await api<{ items: Array<{ id: string }>; total: number }>('GET', '/documents');
    const body = expectOk(res, 'GET /documents');

    expect(Array.isArray(body.items), '[HINT] /documents.items is not an array — schema drift.').toBe(true);
    expect(
      body.items.length,
      '[HINT] No documents, but retain ran earlier. Retain likely did not create a document row — check retain pipeline.',
    ).toBeGreaterThan(0);
  });
});

// ─── 9. Tags ────────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Tags', { timeout: 10_000 }, () => {
  it('lists tags and finds __live-test', async () => {
    const res = await api<{ tags: string[] }>('GET', '/tags');
    const body = expectOk(res, 'GET /tags');

    expect(Array.isArray(body.tags), '[HINT] /tags.tags is not an array — schema drift.').toBe(true);
    expect(
      body.tags,
      '[HINT] __live-test tag missing even though we just retained with it. Tag aggregation query may be filtering it out.',
    ).toContain('__live-test');
  });
});

// ─── 10. Mental models CRUD ─────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Mental models CRUD', { timeout: 15_000 }, () => {
  let modelId: string;

  it('creates a mental model', async () => {
    const res = await api<{ id: string; text: string }>('POST', '/mental-models', {
      text: 'Animals with extreme survival adaptations tend to be ancient species that evolved under harsh environmental pressures.',
    });
    const body = expectOk(res, 'POST /mental-models', 201);
    expect(body.id, '[HINT] POST /mental-models missing id — schema drift or D1 write failed.').toBeTruthy();
    expect(body.text, '[HINT] POST /mental-models missing text — schema drift.').toBeTruthy();
    modelId = body.id;
  });

  it('gets the mental model by ID', async () => {
    if (!modelId) return;
    const res = await api<{ id: string; text: string }>('GET', `/mental-models/${modelId}`);
    const body = expectOk(res, `GET /mental-models/${modelId}`);
    expect(body.id).toBe(modelId);
    expect(
      body.text,
      '[HINT] Mental model text missing expected phrase — did the create persist the right content?',
    ).toContain('survival adaptations');
  });

  it('updates the mental model', async () => {
    if (!modelId) return;
    const res = await api<{ id: string; text: string }>('PATCH', `/mental-models/${modelId}`, {
      text: 'Animals with extreme survival adaptations are often ancient species. Tardigrades, axolotls, and platypuses exemplify this pattern.',
    });
    const body = expectOk(res, `PATCH /mental-models/${modelId}`);
    expect(
      body.text,
      '[HINT] PATCH did not update text. Check mental-models update handler merges fields correctly.',
    ).toContain('Tardigrades');
  });

  it('lists mental models and finds the created one', async () => {
    const res = await api<{ items: Array<{ id: string }> }>('GET', '/mental-models');
    const body = expectOk(res, 'GET /mental-models');
    const found = body.items.some((m) => m.id === modelId);
    expect(
      found,
      `[HINT] Created mental model ${modelId} missing from list — bank-filter or pagination bug.`,
    ).toBe(true);
  });

  it('deletes the mental model', async () => {
    if (!modelId) return;
    const res = await api('DELETE', `/mental-models/${modelId}`);
    expectOk(res, `DELETE /mental-models/${modelId}`);

    const getRes = await api('GET', `/mental-models/${modelId}`);
    expect(
      getRes.status,
      `[HINT] Mental model still readable after DELETE (status ${getRes.status}). Delete handler skipped cascade.`,
    ).toBe(404);
  });
});

// ─── 11. Async operations ───────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Async retain and operations', { timeout: 60_000 }, () => {
  let operationId: string;

  it('retains content asynchronously', async () => {
    const res = await api<{ success: boolean; async: boolean; operation_id: string }>('POST', '/memories', {
      items: [
        {
          content:
            'The immortal jellyfish Turritopsis dohrnii can revert to its polyp stage after reaching sexual maturity, making it biologically immortal.',
          tags: ['__live-test', 'async-test'],
        },
      ],
      async: true,
    });
    const body = expectOk(res, 'POST /memories (async)');
    expect(
      body.async,
      '[HINT] async:true was sent but response says async:false. Check src/routes/memories.ts async branch.',
    ).toBe(true);
    expect(
      body.operation_id,
      '[HINT] operation_id missing in async response. Queue enqueue likely failed — check QUEUE binding in wrangler.toml.',
    ).toBeTruthy();
    operationId = body.operation_id;
  });

  it('polls operation status until completed', async () => {
    if (!operationId) return;

    let status = 'pending';
    let lastBody: { operation_id: string; status: string; operation_type: string } | null = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const res = await api<{ operation_id: string; status: string; operation_type: string }>(
        'GET',
        `/operations/${operationId}`,
      );
      const body = expectOk(res, `GET /operations/${operationId}`);
      lastBody = body;

      expect(body.operation_id).toBe(operationId);
      expect(
        body.operation_type,
        `[HINT] operation_type expected 'retain', got '${body.operation_type}'. Queue routing mismatch.`,
      ).toBe('retain');
      status = body.status;

      if (status === 'completed' || status === 'failed') break;
    }

    expect(
      status,
      `[HINT] Async retain did not complete in 30s (final status: ${status}). ` +
        `Either the queue consumer isn't running (check \`wrangler queues consumer list\`), or the retain pipeline is hung. ` +
        `Last body: ${JSON.stringify(lastBody)}`,
    ).toBe('completed');
  });

  it('recalls the async-retained fact', async () => {
    const res = await api<{ results: Array<{ text: string }> }>('POST', '/memories/recall', {
      query: 'immortal jellyfish biological immortality',
      budget: 'mid',
      tags: ['async-test'],
      tags_match: 'any',
    });
    const body = expectOk(res, 'POST /memories/recall (async fact)');

    expect(
      body.results.length,
      '[HINT] Async-retained fact not retrievable. Queue consumer may have failed to embed. Check operations list for error details.',
    ).toBeGreaterThan(0);

    const matched = body.results.some(
      (r) =>
        r.text.toLowerCase().includes('jellyfish') ||
        r.text.toLowerCase().includes('turritopsis') ||
        r.text.toLowerCase().includes('immortal'),
    );
    expect(
      matched,
      `[HINT] Async fact retrieved but text doesn't match expected content. First result: "${body.results[0]?.text.slice(0, 200)}"`,
    ).toBe(true);
  });

  it('lists operations for the bank', async () => {
    const res = await api<{ operations: Array<{ operation_id: string; status: string }> }>('GET', '/operations');
    const body = expectOk(res, 'GET /operations');
    expect(
      Array.isArray(body.operations),
      '[HINT] /operations.operations is not an array — response shape drift.',
    ).toBe(true);
  });
});

// ─── 12. Recall with includes (entities, chunks, source_facts) ──────────────

describe.skipIf(!runLive)('Live: Recall with includes', { timeout: 15_000 }, () => {
  it('recall with entity hydration', async () => {
    const res = await api<{ results: Array<{ text: string }>; entities: Record<string, unknown> | null }>(
      'POST',
      '/memories/recall',
      {
        query: 'tardigrade axolotl platypus',
        budget: 'mid',
        include: { entities: { max_tokens: 1000 } },
        tags: ['__live-test'],
        tags_match: 'any',
      },
    );
    const body = expectOk(res, 'POST /memories/recall (include.entities)');

    expect(body.results.length, '[HINT] Recall returned 0 results for entity-include test.').toBeGreaterThan(0);
    expect(
      body.entities,
      '[HINT] include.entities was requested but response.entities is undefined. Check src/routes/recall.ts entity hydration path.',
    ).toBeDefined();
  });

  it('recall with chunk hydration', async () => {
    const res = await api<{
      results: Array<{ text: string; chunk_id?: string }>;
      chunks: Record<string, unknown> | null;
    }>('POST', '/memories/recall', {
      query: 'animal survival space regeneration',
      budget: 'mid',
      include: { chunks: { max_tokens: 1000 } },
      tags: ['__live-test'],
      tags_match: 'any',
    });
    const body = expectOk(res, 'POST /memories/recall (include.chunks)');

    expect(body.results.length).toBeGreaterThan(0);
    expect(
      body.chunks,
      '[HINT] include.chunks was requested but response.chunks is undefined. Chunk hydration path broken.',
    ).toBeDefined();
  });
});

// ─── 13. Version / health ───────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Health and version', { timeout: 10_000 }, () => {
  it('GET /version returns version info', async () => {
    const res = await rawFetch<{
      version: string;
      features: Record<string, boolean>;
      models: Record<string, string>;
    }>(`${BASE_URL}/version`);
    const body = expectOk(res, 'GET /version');

    expect(body.version, '[HINT] /version.version is empty. Check HINDSIGHT_VERSION in wrangler.toml [vars].').toBeTruthy();
    expect(body.features, '[HINT] /version.features missing — response shape drift.').toBeDefined();
    expect(body.models, '[HINT] /version.models missing — response shape drift.').toBeDefined();
    expect(
      typeof body.models.llm,
      '[HINT] /version.models.llm not a string. Check DEFAULT_LLM_MODEL is set in wrangler.toml.',
    ).toBe('string');
    expect(
      typeof body.models.embedding,
      '[HINT] /version.models.embedding not a string. Check DEFAULT_EMBEDDING_MODEL is set in wrangler.toml.',
    ).toBe('string');
  });
});

// ─── 14. File upload → retain → recall ──────────────────────────────────────

describe.skipIf(!runLive)('Live: File upload retain', { timeout: 120_000 }, () => {
  it('uploads a plain text file and recalls its content', async () => {
    const textContent = [
      'The Scoville scale measures the pungency of chili peppers in Scoville Heat Units (SHU).',
      'The Carolina Reaper held the Guinness World Record at 2,200,000 SHU from 2013 to 2023.',
      'Pepper X surpassed it in 2023 at 2,693,000 SHU, bred by Ed Currie.',
    ].join('\n');

    const res = await uploadFiles(
      [{ name: 'peppers.txt', content: textContent, type: 'text/plain' }],
      { files_metadata: [{ tags: ['__live-test', 'file-upload'], context: 'Chili pepper facts' }] },
    );
    const body = expectOk(res, 'POST /files/retain (text)') as { operation_ids: string[] };
    expect(
      body.operation_ids,
      '[HINT] /files/retain did not return operation_ids. Check R2 binding and queue enqueue in src/routes/files.ts.',
    ).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(
      status,
      `[HINT] File retain operation ended with status "${status}" (expected "completed"). ` +
        `Queue consumer or file parser likely failed — check \`wrangler tail\`.`,
    ).toBe('completed');

    const recallRes = await api<{ results: Array<{ text: string }> }>('POST', '/memories/recall', {
      query: 'What is the hottest chili pepper on the Scoville scale?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });
    const recallBody = expectOk(recallRes, 'POST /memories/recall (after text upload)');
    expect(
      recallBody.results.length,
      '[HINT] No recall results for the text file content. Parser ran but extraction/embed failed.',
    ).toBeGreaterThan(0);

    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('scoville') ||
        r.text.toLowerCase().includes('pepper') ||
        r.text.toLowerCase().includes('reaper'),
    );
    expect(
      matched,
      `[HINT] Uploaded text content not found in recall. First result: "${recallBody.results[0]?.text.slice(0, 200)}"`,
    ).toBe(true);
  });

  it('uploads an HTML file and extracts content via toMarkdown', async () => {
    const htmlContent = `<!DOCTYPE html>
<html><body>
<h1>Coelacanth Rediscovery</h1>
<p>The coelacanth was believed extinct for 66 million years until a living specimen
was found in 1938 off the coast of South Africa by museum curator Marjorie Courtenay-Latimer.</p>
<p>A second population of coelacanths (Latimeria menadoensis) was discovered in Indonesia in 1998.</p>
</body></html>`;

    const res = await uploadFiles(
      [{ name: 'coelacanth.html', content: htmlContent, type: 'text/html' }],
      { files_metadata: [{ tags: ['__live-test', 'file-upload'], context: 'Marine biology' }] },
    );
    const body = expectOk(res, 'POST /files/retain (html)') as { operation_ids: string[] };
    expect(body.operation_ids).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(
      status,
      `[HINT] HTML file retain ended with "${status}". HTML → markdown conversion may have failed — check toMarkdown step in file-retain pipeline.`,
    ).toBe('completed');

    const recallRes = await api<{ results: Array<{ text: string }> }>('POST', '/memories/recall', {
      query: 'When was the coelacanth rediscovered?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });
    const recallBody = expectOk(recallRes, 'POST /memories/recall (after html upload)');
    expect(recallBody.results.length).toBeGreaterThan(0);

    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('coelacanth') ||
        r.text.toLowerCase().includes('1938') ||
        r.text.toLowerCase().includes('latimer'),
    );
    expect(
      matched,
      `[HINT] HTML content not retrievable. toMarkdown may have returned empty or a stripped version. First result: "${recallBody.results[0]?.text.slice(0, 200)}"`,
    ).toBe(true);
  });

  it('uploads a CSV file and extracts tabular data', async () => {
    const csvContent = [
      'species,top_speed_kmh,habitat,conservation_status',
      'Peregrine Falcon,389,Worldwide cliffs and cities,Least Concern',
      'Golden Eagle,322,Northern Hemisphere mountains,Least Concern',
      'White-throated Needletail,169,Asia and Australia,Least Concern',
      'Frigatebird,153,Tropical oceans,Least Concern',
      'Spur-winged Goose,142,Sub-Saharan Africa wetlands,Least Concern',
    ].join('\n');

    const res = await uploadFiles(
      [{ name: 'fastest-birds.csv', content: csvContent, type: 'text/csv' }],
      { files_metadata: [{ tags: ['__live-test', 'file-upload'], context: 'Ornithology speed records' }] },
    );
    const body = expectOk(res, 'POST /files/retain (csv)') as { operation_ids: string[] };
    expect(body.operation_ids).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(
      status,
      `[HINT] CSV file retain ended with "${status}". CSV parser may not be registered — check file-retain strategy registry.`,
    ).toBe('completed');

    const recallRes = await api<{ results: Array<{ text: string }> }>('POST', '/memories/recall', {
      query: 'What is the fastest bird in the world?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });
    const recallBody = expectOk(recallRes, 'POST /memories/recall (after csv upload)');
    expect(recallBody.results.length).toBeGreaterThan(0);

    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('peregrine') ||
        r.text.toLowerCase().includes('falcon') ||
        r.text.toLowerCase().includes('389'),
    );
    expect(
      matched,
      `[HINT] CSV row data not retrievable. Row-to-memory mapping may be broken. First result: "${recallBody.results[0]?.text.slice(0, 200)}"`,
    ).toBe(true);
  });

  it('rejects a file over the 20MB limit', async () => {
    const oversized = 'x'.repeat(21 * 1024 * 1024);
    const res = await uploadFiles([{ name: 'huge.txt', content: oversized, type: 'text/plain' }]);

    expect(
      res.status,
      `[HINT] Expected HTTP 413 for oversized upload, got ${res.status}. Size check in src/routes/files.ts is missing or set above 20MB.`,
    ).toBe(413);
    const body = res.body as { error: string; file_name: string };
    expect(body.error, '[HINT] Expected error code "file_too_large" — error naming drift.').toBe('file_too_large');
    expect(body.file_name).toBe('huge.txt');
  });

  it('rejects request with no files', async () => {
    const h: Record<string, string> = {};
    if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
    const form = new FormData();
    const res = await fetch(`${BANK_BASE}/files/retain`, { method: 'POST', headers: h, body: form });
    const text = await res.text();

    expect(
      res.status,
      `[HINT] Expected HTTP 400 for empty upload, got ${res.status}. ${statusHint(res.status, text)} Body: ${text.slice(0, 300)}`,
    ).toBe(400);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (!BASE_URL) return;
  // Wipe the dedicated test bank — it exists only for this test
  await api('DELETE', '/memories').catch(() => {});
});
