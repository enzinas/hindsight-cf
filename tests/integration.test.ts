/**
 * Integration test: end-to-end retain → recall flow.
 *
 * Tests the full pipeline: retain content, then recall it
 * through the HTTP API, verifying the recall results match.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request } from './helpers';

let testApp: { fetch: (req: Request) => Promise<Response> };

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  };
});

describe('Integration: Retain → Recall', () => {
  // Removed: 'retains content and recalls it by query' — asserted mock semantic search matched "Alice",
  // which only works because mock embeddings happen to return results. False confidence.

  it('recall with trace returns timing data', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'The Eiffel Tower is in Paris, France.' }],
    });

    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'Where is the Eiffel Tower?',
      trace: true,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      results: unknown[];
      trace: {
        semanticCount: number;
        ftsCount: number;
        graphCount: number;
        temporalCount: number;
        fusedCount: number;
        rerankedCount: number;
        timings: Record<string, number>;
      };
    };

    expect(body.trace).toBeDefined();
    expect(body.trace.semanticCount).toBeGreaterThanOrEqual(0);
    expect(body.trace.ftsCount).toBeGreaterThanOrEqual(0);
    expect(body.trace.fusedCount).toBeGreaterThanOrEqual(0);
    expect(body.trace.rerankedCount).toBeGreaterThanOrEqual(0);
    expect(body.trace.timings).toBeDefined();
    expect(body.trace.timings.retrieval_ms).toBeGreaterThanOrEqual(0);
    expect(body.trace.timings.fusion_ms).toBeGreaterThanOrEqual(0);
    expect(body.trace.timings.rerank_ms).toBeGreaterThanOrEqual(0);
  });

  it('recall with entity hydration returns entity data', async () => {
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'Alice loves programming in TypeScript and Rust.' }],
    });

    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'What programming languages does Alice use?',
      include: { entities: { max_tokens: 500 } },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { results: unknown[]; entities: Record<string, unknown> | null };
    expect(body.results.length).toBeGreaterThan(0);
    // entities may be empty if no entities were linked, but the key should exist
    expect(body.entities).toBeDefined();
  });

  // Removed: 'recall returns empty when no content matches' — only asserted results was defined (trivial)

  it('recall respects budget parameter', async () => {
    // Retain many items
    const items = Array.from({ length: 20 }, (_, i) => ({
      content: `Fact number ${i + 1}: testing budget limits in recall pipeline.`,
    }));

    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', { items });

    // Low budget = max 10 results
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'testing budget',
      budget: 'low',
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { results: unknown[] };
    expect(body.results.length).toBeLessThanOrEqual(10);
  });

  // Removed: 'multi-bank isolation' — bank filtering depends on mock Vectorize which
  // uses namespace filtering. The mock proves the mock works, not real isolation.
});
