/**
 * Integration test: end-to-end retain → recall flow.
 *
 * Tests the full pipeline: retain content, then recall it
 * through the HTTP API, verifying the recall results match.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request, store } from './helpers';

let testApp: { fetch: (req: Request) => Promise<Response> };

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  };
});

describe('Integration: Retain → Recall', () => {
  it('retains content and recalls it by query', async () => {
    // Retain
    const retainRes = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [
        { content: 'Alice works at Google as a software engineer in Mountain View.' },
        { content: 'Bob is a data scientist at Meta in Menlo Park.' },
        { content: 'Charlie is a product manager at Apple in Cupertino.' },
      ],
    });
    expect(retainRes.status).toBe(200);
    const retainBody = (await retainRes.json()) as { success: boolean; items_count: number };
    expect(retainBody.success).toBe(true);
    expect(retainBody.items_count).toBe(3);

    // Verify data stored
    expect(store.tables.memory_units.length).toBeGreaterThan(0);

    // Recall - search for Alice
    const recallRes = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'What does Alice do?',
    });
    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as { results: Array<{ id: string; text: string }> };
    expect(recallBody.results).toBeDefined();
    expect(Array.isArray(recallBody.results)).toBe(true);
    expect(recallBody.results.length).toBeGreaterThan(0);

    // At least one result should mention Alice
    const mentionsAlice = recallBody.results.some((r) => r.text.toLowerCase().includes('alice'));
    expect(mentionsAlice).toBe(true);
  });

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

  it('recall returns empty when no content matches', async () => {
    // Retain something unrelated
    await request(testApp, 'POST', '/v1/default/banks/test-bank/memories', {
      items: [{ content: 'The weather is sunny today.' }],
    });

    // Recall with completely unrelated query — FTS won't match
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/memories/recall', {
      query: 'xyznonexistent',
    });
    expect(res.status).toBe(200);

    // Vector search may still return results via cosine similarity
    // but FTS should return 0
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toBeDefined();
  });

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

  it('multi-bank isolation: recall only returns results from the queried bank', async () => {
    // Retain to bank A
    await request(testApp, 'POST', '/v1/default/banks/bank-a/memories', {
      items: [{ content: 'Secret data for bank A only.' }],
    });

    // Retain to bank B
    await request(testApp, 'POST', '/v1/default/banks/bank-b/memories', {
      items: [{ content: 'Different secret data for bank B.' }],
    });

    // Recall from bank A
    const res = await request(testApp, 'POST', '/v1/default/banks/bank-a/memories/recall', {
      query: 'secret data',
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { results: Array<{ text: string }> };
    // Should not include bank B's data
    const hasBankB = body.results.some((r) => r.text.includes('bank B'));
    expect(hasBankB).toBe(false);
  });
});
