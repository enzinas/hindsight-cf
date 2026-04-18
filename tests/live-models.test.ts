/**
 * Live model-matrix test for tool-calling coverage.
 *
 * For every candidate Workers AI model, invoke `/reflect` with a per-request
 * `model` override and assert that the agent successfully emitted at least
 * one tool call recognised by the reflect pipeline. This is the ground-truth
 * check that `parseWorkersAIResult` handles the model's response shape
 * (OpenAI-compatible tool_calls, legacy flat tool_calls, or text-embedded).
 *
 * Why a small seeded bank? Each model call is LLM-expensive. We reuse the
 * `__live-test-reflect` bank seeded by `live-reflect.test.ts` — if you run
 * the suites together the setup is already paid for. When run alone, the
 * preflight re-seeds a single memory so the matrix still has something to
 * retrieve.
 *
 * Customise the model list with LIVE_TEST_MODELS (comma-separated slugs).
 *
 * Run:
 *   LIVE_TEST_URL=https://hindsight-cf.example.com \
 *   LIVE_TEST_API_KEY=... \
 *     npx vitest run tests/live-models.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, apiCall, expectOk, runLive, type ApiResult } from './live-helpers';

const BANK_ID = '__live-test-models';
const BANK_BASE = `${BASE_URL}/v1/default/banks/${BANK_ID}`;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiCall<T>(`${BANK_BASE}${path}`, method, body);
}

/**
 * Default matrix — spans both response-shape families documented in
 * src/providers/llm-tools.ts. Override with LIVE_TEST_MODELS to test a
 * different set without a code change.
 */
const DEFAULT_MODELS: string[] = [
  // Shape 1 — OpenAI-compatible tool_calls in choices[0].message.tool_calls
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/google/gemma-3-12b-it',
  // Shape 2 — legacy/flat tool_calls at the top level
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
];

const MODELS: string[] = process.env.LIVE_TEST_MODELS
  ? process.env.LIVE_TEST_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_MODELS;

const EXPECTED_REFLECT_TOOLS = new Set([
  'search_mental_models',
  'search_observations',
  'recall',
  'done',
]);

// ─── Setup ──────────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Model matrix setup', { timeout: 120_000 }, () => {
  it('seeds a small amount of content for retrieval', async () => {
    const result = await api<{ success: boolean; items_count: number }>('POST', '/memories', {
      items: [
        {
          content: 'Octopuses have three hearts and copper-based blue blood.',
          tags: ['__live-test-models'],
        },
        {
          content: 'Mantis shrimp possess 16 photoreceptor types, far more than human trichromatic vision.',
          tags: ['__live-test-models'],
        },
      ],
    });
    const body = expectOk(result, 'POST /memories (model-matrix seeding)');
    expect(
      body.success,
      '[HINT] Seeding failed — model-matrix tests cannot run without content to retrieve. Check retain pipeline.',
    ).toBe(true);
    // Allow Vectorize a moment to index
    await new Promise((r) => setTimeout(r, 2000));
  });
});

// ─── Matrix ─────────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Tool-calling across Workers AI models', () => {
  for (const model of MODELS) {
    it(
      `${model} — /reflect emits at least one recognised tool call`,
      { timeout: 90_000 },
      async () => {
        const result = await api<{
          text: string;
          trace: {
            tool_calls: Array<{ tool: string; iteration: number }>;
            llm_calls: Array<{ scope: string; duration_ms: number }>;
          } | null;
        }>('POST', '/reflect', {
          query: 'What is one unusual biological adaptation in my memories?',
          budget: 'low',
          model,
          include: { tool_calls: {} },
        });
        // A 400/404 here means the model slug is wrong for this account or
        // the model isn't function-calling-capable. Surface clearly.
        if (result.status === 400 || result.status === 404) {
          throw new Error(
            `[HINT] /reflect rejected model="${model}" with HTTP ${result.status}. ` +
              `Possible causes: (a) slug typo, (b) model not enabled on your account, ` +
              `(c) model lacks function_calling support. Body: ${result.rawText.slice(0, 300)}`,
          );
        }
        const body = expectOk(result, `POST /reflect model=${model}`);

        expect(
          body.trace,
          `[HINT] No trace returned for model=${model}. include.tool_calls was set — ` +
            `check the reflect handler in src/index.ts.`,
        ).not.toBeNull();

        const toolsCalled = body.trace!.tool_calls.map((t) => t.tool);
        expect(
          toolsCalled.length,
          `[HINT] model="${model}" produced zero tool calls. This typically means ` +
            `parseWorkersAIResult in src/providers/llm-tools.ts does not recognise this ` +
            `model's response shape. Observed final text: "${body.text.slice(0, 300)}"`,
        ).toBeGreaterThan(0);

        const unrecognised = toolsCalled.filter((t) => !EXPECTED_REFLECT_TOOLS.has(t));
        expect(
          unrecognised.length,
          `[HINT] model="${model}" returned tool name(s) the reflect pipeline did not expect: ` +
            `[${unrecognised.join(', ')}]. Either the LLM hallucinated tool names, or ` +
            `normalizeToolName in src/providers/llm-tools.ts is failing to strip a new ` +
            `decoration pattern. Full list: [${toolsCalled.join(', ')}]`,
        ).toBe(0);

        // Soft assertion: first tool should typically be search_mental_models or search_observations
        // for hierarchical retrieval. Not fatal — just flagged.
        const first = toolsCalled[0];
        if (first !== 'search_mental_models' && first !== 'search_observations' && first !== 'recall') {
          console.warn(
            `[live-models] model="${model}" started with "${first}" instead of a retrieval tool. ` +
              `This is allowed but unusual — tool_choice forcing may be soft for this model.`,
          );
        }
      },
    );
  }
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (!BASE_URL) return;
  await api('DELETE', '/memories').catch(() => {});
});
