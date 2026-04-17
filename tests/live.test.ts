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
 */

import { describe, it, expect, afterAll } from 'vitest';

const BASE_URL = process.env.LIVE_TEST_URL;
const API_KEY = process.env.LIVE_TEST_API_KEY;
const BANK_ID = '__live-test-ephemeral';
const BANK_BASE = `${BASE_URL}/v1/default/banks/${BANK_ID}`;

// Skip all suites if no live URL is configured
const runLive = !!BASE_URL;

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  return h;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const url = `${BANK_BASE}${path}`;
  const opts: RequestInit = { method, headers: headers() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.clone().text().catch(() => '(no body)');
    console.error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res;
}

/** Fetch a URL outside the bank base (e.g. /version). */
async function rawFetch(url: string): Promise<Response> {
  const opts: RequestInit = { method: 'GET', headers: headers() };
  return fetch(url, opts);
}

/** Upload files via multipart/form-data. Do NOT set Content-Type — fetch sets the boundary. */
async function uploadFiles(
  files: Array<{ name: string; content: string; type: string }>,
  metadata?: Record<string, unknown>,
): Promise<Response> {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([f.content], { type: f.type }), f.name);
  }
  if (metadata) {
    form.append('request', JSON.stringify(metadata));
  }
  const h: Record<string, string> = {};
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(`${BANK_BASE}/files/retain`, { method: 'POST', headers: h, body: form });
  if (!res.ok) {
    const text = await res.clone().text().catch(() => '(no body)');
    console.error(`POST /files/retain → ${res.status}: ${text}`);
  }
  return res;
}

/** Poll an operation until completed or failed (max 60s). */
async function pollOperation(operationId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await api('GET', `/operations/${operationId}`);
    if (!res.ok) continue;
    const body = (await res.json()) as { status: string };
    if (body.status === 'completed' || body.status === 'failed') return body.status;
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

// ─── 1. Retain → Recall round-trip ──────────────────────────────────────────

describe.skipIf(!runLive)('Live: Retain → Recall', { timeout: 30_000 }, () => {
  it('retains an esoteric fact', async () => {
    const res = await api('POST', '/memories', {
      items: [
        {
          content: FACTS.tardigrade,
          context: 'Live integration test — safe to delete',
          tags: ['__live-test'],
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; items_count: number };
    expect(body.success).toBe(true);
    expect(body.items_count).toBe(1);
  });

  it('recalls the retained fact by semantic query', async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await api('POST', '/memories/recall', {
      query: 'Which animal survived outer space on the FOTON-M3 mission?',
      budget: 'mid',
      tags: ['__live-test'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ id: string; text: string }>;
    };

    expect(body.results.length).toBeGreaterThan(0);
    const matched = body.results.some(
      (r) =>
        r.text.toLowerCase().includes('tardigrade') ||
        r.text.toLowerCase().includes('foton'),
    );
    expect(matched).toBe(true);
  });

  it('recalls with trace and verifies pipeline stages ran', async () => {
    const res = await api('POST', '/memories/recall', {
      query: 'tardigrade space survival',
      trace: true,
      tags: ['__live-test'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: unknown[];
      trace: {
        semanticCount: number;
        ftsCount: number;
        fusedCount: number;
        rerankedCount: number;
        timings: Record<string, number>;
      };
    };

    expect(body.trace).toBeDefined();
    expect(body.trace.timings.retrieval_ms).toBeGreaterThan(0);
  });
});

// ─── 2. Multi-item retain, tags, and memory CRUD ────────────────────────────

describe.skipIf(!runLive)('Live: Multi-item retain and memory CRUD', { timeout: 60_000 }, () => {
  const retainedIds: string[] = [];

  it('retains multiple facts in one call', async () => {
    const res = await api('POST', '/memories', {
      items: [
        { content: FACTS.axolotl, tags: ['__live-test', 'biology'] },
        { content: FACTS.platypus, tags: ['__live-test', 'biology'] },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; items_count: number };
    expect(body.success).toBe(true);
    expect(body.items_count).toBe(2);
  });

  it('lists memories and finds the retained facts', async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await api('GET', '/memories/list?limit=50');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string; text: string }>;
      total: number;
    };

    expect(body.items.length).toBeGreaterThan(0);

    // Collect IDs for later CRUD tests
    for (const m of body.items) {
      retainedIds.push(m.id);
    }
    expect(retainedIds.length).toBeGreaterThan(0);
  });

  it('gets a single memory by ID', async () => {
    if (retainedIds.length === 0) return;

    const res = await api('GET', `/memories/${retainedIds[0]}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      text: string;
      fact_type: string;
    };
    expect(body.id).toBe(retainedIds[0]);
    expect(body.text).toBeTruthy();
    expect(body.fact_type).toBeTruthy();
  });

  it('deletes a single memory by ID', async () => {
    if (retainedIds.length === 0) return;

    const idToDelete = retainedIds.pop()!;
    const res = await api('DELETE', `/memories/${idToDelete}`);
    expect(res.status).toBe(200);

    // Verify it's gone
    const getRes = await api('GET', `/memories/${idToDelete}`);
    expect(getRes.status).toBe(404);
  });

  it('recalls with tag filter returns only tagged results', async () => {
    const res = await api('POST', '/memories/recall', {
      query: 'animal biology regeneration venom',
      budget: 'mid',
      tags: ['biology'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ id: string; text: string; tags?: string[] }>;
    };

    // All results should have the biology tag
    for (const r of body.results) {
      expect(r.tags).toContain('biology');
    }
  });
});

// ─── 3. Bank profile and config ─────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Bank profile and config', { timeout: 15_000 }, () => {
  it('reads bank profile (auto-creates bank)', async () => {
    const res = await api('GET', '/profile');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      bank_id: string;
      name: string;
      disposition: { skepticism: number; literalism: number; empathy: number };
      mission: string;
    };

    expect(body.bank_id).toBe(BANK_ID);
    expect(body.disposition).toBeDefined();
    expect(typeof body.disposition.skepticism).toBe('number');
    expect(typeof body.disposition.literalism).toBe('number');
    expect(typeof body.disposition.empathy).toBe('number');
  });

  it('updates disposition and reads it back', async () => {
    const newDisposition = { skepticism: 2, literalism: 4, empathy: 3 };

    const putRes = await api('PUT', '/profile/disposition', {
      disposition: newDisposition,
    });
    expect(putRes.status).toBe(200);

    const getRes = await api('GET', '/profile');
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      disposition: { skepticism: number; literalism: number; empathy: number };
    };
    expect(body.disposition).toEqual(newDisposition);
  });

  it('sets mission and reads it back', async () => {
    const mission = 'Live test mission — remember esoteric animal facts';
    const putRes = await api('PUT', '/profile/mission', { content: mission });
    expect(putRes.status).toBe(200);

    const getRes = await api('GET', '/profile');
    const body = (await getRes.json()) as { mission: string };
    expect(body.mission).toBe(mission);
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
    expect(patchRes.status).toBe(200);

    const getRes = await api('GET', '/config');
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      config: { strategies: Record<string, unknown> };
    };
    expect(body.config.strategies.test_strategy).toBeDefined();
  });

  it('resets config to defaults', async () => {
    const res = await api('DELETE', '/config');
    expect(res.status).toBe(200);

    const getRes = await api('GET', '/config');
    const body = (await getRes.json()) as { overrides: Record<string, unknown> };
    expect(body.overrides).toEqual({});
  });
});

// ─── 4. Bank stats ──────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Bank stats', { timeout: 10_000 }, () => {
  it('returns stats with expected structure', async () => {
    const res = await api('GET', '/stats');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      bank_id: string;
      memories: {
        total: number;
        world: number;
        experience: number;
        observation: number;
        mental_model: number;
      };
      entities: number;
      documents: number;
    };

    expect(body.bank_id).toBe(BANK_ID);
    expect(typeof body.memories.total).toBe('number');
    expect(body.memories.total).toBeGreaterThanOrEqual(0);
    expect(typeof body.entities).toBe('number');
    expect(typeof body.documents).toBe('number');
  });
});

// ─── 5. Entities ────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Entities', { timeout: 10_000 }, () => {
  it('lists entities for the bank', async () => {
    const res = await api('GET', '/entities');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string; canonical_name: string }>;
    };

    expect(Array.isArray(body.items)).toBe(true);
    // After retaining facts about tardigrades, axolotls, platypus — entities should exist
    if (body.items.length > 0) {
      expect(body.items[0].id).toBeTruthy();
      expect(body.items[0].canonical_name).toBeTruthy();
    }
  });
});

// ─── 6. Directives ──────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Directives CRUD', { timeout: 15_000 }, () => {
  let directiveId: string;

  it('creates a directive', async () => {
    const res = await api('POST', '/directives', {
      name: '__live-test-directive',
      content: 'Always mention the source when recalling animal facts.',
      priority: 5,
      tags: ['__live-test'],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; content: string };
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('__live-test-directive');
    directiveId = body.id;
  });

  it('lists directives and finds the created one', async () => {
    const res = await api('GET', '/directives');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string; name: string }>;
    };
    const found = body.items.some((d) => d.id === directiveId);
    expect(found).toBe(true);
  });

  it('deletes the directive', async () => {
    if (!directiveId) return;

    const res = await api('DELETE', `/directives/${directiveId}`);
    expect(res.status).toBe(200);

    // Verify it's gone — list should not contain it
    const listRes = await api('GET', '/directives');
    const body = (await listRes.json()) as {
      items: Array<{ id: string }>;
    };
    const found = body.items.some((d) => d.id === directiveId);
    expect(found).toBe(false);
  });
});

// ─── 7. Reflect (LLM reasoning over memories) ──────────────────────────────

describe.skipIf(!runLive)('Live: Reflect', { timeout: 60_000 }, () => {
  it('reflects over retained memories and returns a reasoned answer', async () => {
    const res = await api('POST', '/reflect', {
      query: 'What unusual survival abilities do the animals in my memories have?',
      budget: 'low',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    };

    expect(body.text).toBeTruthy();
    expect(body.text.length).toBeGreaterThan(20);

    // usage may be present but Workers AI doesn't always report token counts
    if (body.usage) {
      expect(typeof body.usage.total_tokens).toBe('number');
    }
  });
});

// ─── 8. Documents ───────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Documents', { timeout: 10_000 }, () => {
  it('lists documents for the bank', async () => {
    const res = await api('GET', '/documents');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    // We retained facts, so at least one document should exist
    expect(body.items.length).toBeGreaterThan(0);
  });
});

// ─── 9. Tags ────────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Tags', { timeout: 10_000 }, () => {
  it('lists tags and finds __live-test', async () => {
    const res = await api('GET', '/tags');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      tags: string[];
    };
    expect(Array.isArray(body.tags)).toBe(true);
    expect(body.tags).toContain('__live-test');
  });
});

// ─── 10. Mental models CRUD ─────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Mental models CRUD', { timeout: 15_000 }, () => {
  let modelId: string;

  it('creates a mental model', async () => {
    const res = await api('POST', '/mental-models', {
      text: 'Animals with extreme survival adaptations tend to be ancient species that evolved under harsh environmental pressures.',
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; text: string };
    expect(body.id).toBeTruthy();
    expect(body.text).toBeTruthy();
    modelId = body.id;
  });

  it('gets the mental model by ID', async () => {
    if (!modelId) return;

    const res = await api('GET', `/mental-models/${modelId}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; text: string };
    expect(body.id).toBe(modelId);
    expect(body.text).toContain('survival adaptations');
  });

  it('updates the mental model', async () => {
    if (!modelId) return;

    const res = await api('PATCH', `/mental-models/${modelId}`, {
      text: 'Animals with extreme survival adaptations are often ancient species. Tardigrades, axolotls, and platypuses exemplify this pattern.',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; text: string };
    expect(body.text).toContain('Tardigrades');
  });

  it('lists mental models and finds the created one', async () => {
    const res = await api('GET', '/mental-models');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string }>;
    };
    const found = body.items.some((m) => m.id === modelId);
    expect(found).toBe(true);
  });

  it('deletes the mental model', async () => {
    if (!modelId) return;

    const res = await api('DELETE', `/mental-models/${modelId}`);
    expect(res.status).toBe(200);

    const getRes = await api('GET', `/mental-models/${modelId}`);
    expect(getRes.status).toBe(404);
  });
});

// ─── 11. Async operations ───────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Async retain and operations', { timeout: 60_000 }, () => {
  let operationId: string;

  it('retains content asynchronously', async () => {
    const res = await api('POST', '/memories', {
      items: [
        {
          content: 'The immortal jellyfish Turritopsis dohrnii can revert to its polyp stage after reaching sexual maturity, making it biologically immortal.',
          tags: ['__live-test', 'async-test'],
        },
      ],
      async: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      async: boolean;
      operation_id: string;
    };
    expect(body.async).toBe(true);
    expect(body.operation_id).toBeTruthy();
    operationId = body.operation_id;
  });

  it('polls operation status until completed', async () => {
    if (!operationId) return;

    // Poll up to 30 seconds
    let status = 'pending';
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      const res = await api('GET', `/operations/${operationId}`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        operation_id: string;
        status: string;
        operation_type: string;
      };
      expect(body.operation_id).toBe(operationId);
      expect(body.operation_type).toBe('retain');
      status = body.status;

      if (status === 'completed' || status === 'failed') break;
    }

    expect(status).toBe('completed');
  });

  it('recalls the async-retained fact', async () => {
    const res = await api('POST', '/memories/recall', {
      query: 'immortal jellyfish biological immortality',
      budget: 'mid',
      tags: ['async-test'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ text: string }>;
    };

    expect(body.results.length).toBeGreaterThan(0);
    const matched = body.results.some(
      (r) =>
        r.text.toLowerCase().includes('jellyfish') ||
        r.text.toLowerCase().includes('turritopsis') ||
        r.text.toLowerCase().includes('immortal'),
    );
    expect(matched).toBe(true);
  });

  it('lists operations for the bank', async () => {
    const res = await api('GET', '/operations');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      operations: Array<{ operation_id: string; status: string }>;
    };
    expect(Array.isArray(body.operations)).toBe(true);
  });
});

// ─── 12. Recall with includes (entities, chunks, source_facts) ──────────────

describe.skipIf(!runLive)('Live: Recall with includes', { timeout: 15_000 }, () => {
  it('recall with entity hydration', async () => {
    const res = await api('POST', '/memories/recall', {
      query: 'tardigrade axolotl platypus',
      budget: 'mid',
      include: { entities: { max_tokens: 1000 } },
      tags: ['__live-test'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ text: string }>;
      entities: Record<string, unknown> | null;
    };

    expect(body.results.length).toBeGreaterThan(0);
    expect(body.entities).toBeDefined();
  });

  it('recall with chunk hydration', async () => {
    const res = await api('POST', '/memories/recall', {
      query: 'animal survival space regeneration',
      budget: 'mid',
      include: { chunks: { max_tokens: 1000 } },
      tags: ['__live-test'],
      tags_match: 'any',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ text: string; chunk_id?: string }>;
      chunks: Record<string, unknown> | null;
    };

    expect(body.results.length).toBeGreaterThan(0);
    expect(body.chunks).toBeDefined();
  });
});

// ─── 13. Version / health ───────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Health and version', { timeout: 10_000 }, () => {
  it('GET /version returns version info', async () => {
    const res = await rawFetch(`${BASE_URL}/version`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      features: Record<string, boolean>;
      models: Record<string, string>;
    };

    expect(body.version).toBeTruthy();
    expect(body.features).toBeDefined();
    expect(body.models).toBeDefined();
    expect(typeof body.models.llm).toBe('string');
    expect(typeof body.models.embedding).toBe('string');
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as { operation_ids: string[] };
    expect(body.operation_ids).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(status).toBe('completed');

    // Recall the content
    const recallRes = await api('POST', '/memories/recall', {
      query: 'What is the hottest chili pepper on the Scoville scale?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });

    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as {
      results: Array<{ text: string }>;
    };
    expect(recallBody.results.length).toBeGreaterThan(0);
    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('scoville') ||
        r.text.toLowerCase().includes('pepper') ||
        r.text.toLowerCase().includes('reaper'),
    );
    expect(matched).toBe(true);
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as { operation_ids: string[] };
    expect(body.operation_ids).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(status).toBe('completed');

    const recallRes = await api('POST', '/memories/recall', {
      query: 'When was the coelacanth rediscovered?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });

    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as {
      results: Array<{ text: string }>;
    };
    expect(recallBody.results.length).toBeGreaterThan(0);
    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('coelacanth') ||
        r.text.toLowerCase().includes('1938') ||
        r.text.toLowerCase().includes('latimer'),
    );
    expect(matched).toBe(true);
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as { operation_ids: string[] };
    expect(body.operation_ids).toHaveLength(1);

    const status = await pollOperation(body.operation_ids[0]);
    expect(status).toBe('completed');

    const recallRes = await api('POST', '/memories/recall', {
      query: 'What is the fastest bird in the world?',
      budget: 'mid',
      tags: ['file-upload'],
      tags_match: 'any',
    });

    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as {
      results: Array<{ text: string }>;
    };
    expect(recallBody.results.length).toBeGreaterThan(0);
    const matched = recallBody.results.some(
      (r) =>
        r.text.toLowerCase().includes('peregrine') ||
        r.text.toLowerCase().includes('falcon') ||
        r.text.toLowerCase().includes('389'),
    );
    expect(matched).toBe(true);
  });

  it('rejects a file over the 20MB limit', async () => {
    // Create a ~21MB string
    const oversized = 'x'.repeat(21 * 1024 * 1024);
    const res = await uploadFiles(
      [{ name: 'huge.txt', content: oversized, type: 'text/plain' }],
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; file_name: string };
    expect(body.error).toBe('file_too_large');
    expect(body.file_name).toBe('huge.txt');
  });

  it('rejects request with no files', async () => {
    const h: Record<string, string> = {};
    if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
    const form = new FormData();
    const res = await fetch(`${BANK_BASE}/files/retain`, { method: 'POST', headers: h, body: form });

    expect(res.status).toBe(400);
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (!BASE_URL) return;

  // Wipe the dedicated test bank — it exists only for this test
  await api('DELETE', '/memories');
});
