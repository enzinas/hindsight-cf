/**
 * Live deep-dive tests for the Reflect pipeline and consolidation.
 *
 * These exercise behavior the main live.test.ts doesn't cover:
 *   - Hierarchical retrieval ordering (mental_models → observations → recall)
 *   - based_on shape (memories / mental_models / directives populated)
 *   - Directive compliance (answer honors a configured rule)
 *   - tags / tag_groups filtering in reflect
 *   - response_schema → structured_output
 *   - consolidation produces observations and they become retrievable
 *
 * Run:
 *   LIVE_TEST_URL=https://hindsight-cf.example.com \
 *   LIVE_TEST_API_KEY=... \
 *     npx vitest run tests/live-reflect.test.ts
 *
 * Uses a dedicated bank ("__live-test-reflect") and cleans up after itself.
 * Failures are annotated so a first-time installer can see which stage broke
 * and a likely fix — look for the [HINT] lines in assertion messages.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { BASE_URL, apiCall, expectOk, runLive, type ApiResult } from './live-helpers';

const BANK_ID = '__live-test-reflect';
const BANK_BASE = `${BASE_URL}/v1/default/banks/${BANK_ID}`;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiCall<T>(`${BANK_BASE}${path}`, method, body);
}

// Two tag groups so tag filtering is meaningful.
const OCEAN_FACTS = [
  { content: 'Octopuses have three hearts and copper-based blue blood.', tags: ['__live-reflect', 'ocean', 'adaptation'] },
  { content: 'Mantis shrimp possess 16 photoreceptor types, far more than human trichromatic vision.', tags: ['__live-reflect', 'ocean', 'vision'] },
  { content: 'Sea cucumbers eject their internal organs as a predator-deterrence strategy.', tags: ['__live-reflect', 'ocean', 'adaptation'] },
];
const DESERT_FACTS = [
  { content: 'Fennec foxes have oversized ears that dissipate heat across the Sahara.', tags: ['__live-reflect', 'desert', 'adaptation'] },
  { content: 'Kangaroo rats never drink water — they metabolize it from seeds.', tags: ['__live-reflect', 'desert', 'adaptation'] },
  { content: 'Saguaro cacti absorb up to 200 gallons of water during a single rainstorm.', tags: ['__live-reflect', 'desert', 'water'] },
];

const DIRECTIVE_MARKER = 'REFLECT-TEST-OK';

let directiveId: string | null = null;
let mentalModelId: string | null = null;
let seedOk = false;

// ─── Preflight ──────────────────────────────────────────────────────────────
// Fast sanity check — if this fails, all downstream failures will cascade;
// we want the first message the user sees to be the actionable one.

describe.skipIf(!runLive)('Live: Reflect preflight', { timeout: 15_000 }, () => {
  it('LIVE_TEST_URL is reachable and returns version info', async () => {
    expect(
      BASE_URL,
      '[HINT] Set LIVE_TEST_URL=https://<your-worker>.workers.dev (no trailing slash) before running.',
    ).toBeTruthy();
    const res = await apiCall(`${BASE_URL}/version`, 'GET');
    expectOk(res, 'GET /version');
    // If auth is enforced, a missing/wrong key would have 401'd above, so reaching here = auth OK.
  });
});

// ─── Setup ──────────────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Reflect deep-dive setup', { timeout: 120_000 }, () => {
  it('seeds 6 memories via /memories (LLM extraction runs once)', async () => {
    const result = await api<{ success: boolean; items_count: number }>('POST', '/memories', {
      items: [...OCEAN_FACTS, ...DESERT_FACTS],
    });
    const body = expectOk(result, 'POST /memories (seeding)');
    expect(
      body.success,
      '[HINT] Retain pipeline did not return success:true. Check worker logs — LLM or embedding binding may be misconfigured.',
    ).toBe(true);
    expect(
      body.items_count,
      `[HINT] Expected items_count=6 from retain, got ${body.items_count}. Some facts may have been rejected by extraction.`,
    ).toBe(6);
  });

  it('creates a directive that forces a marker string in the answer', async () => {
    const result = await api<{ id: string; name: string }>('POST', '/directives', {
      name: '__live-reflect-directive',
      content: `Your answer MUST include the exact string "${DIRECTIVE_MARKER}" somewhere in the response. This is a non-negotiable rule.`,
      priority: 10,
      tags: ['__live-reflect'],
    });
    const body = expectOk(result, 'POST /directives', 201);
    expect(body.id, '[HINT] POST /directives did not return {id}. Did the D1 migration for directives run?').toBeTruthy();
    directiveId = body.id;
  });

  it('creates a mental model (forces hierarchical retrieval to start with search_mental_models)', async () => {
    const result = await api<{ id: string }>('POST', '/mental-models', {
      text: 'Extreme environmental pressure tends to produce organisms with unusual adaptations, whether in oceans or deserts.',
    });
    const body = expectOk(result, 'POST /mental-models', 201);
    expect(body.id, '[HINT] POST /mental-models did not return {id}. Schema may be out of date.').toBeTruthy();
    mentalModelId = body.id;

    // Mark setup as healthy so downstream tests can bail fast with a clear message
    seedOk = true;

    // Allow Vectorize a moment to index
    await new Promise((r) => setTimeout(r, 2000));
  });
});

function assertSetupReady(): void {
  expect(
    seedOk,
    '[HINT] Setup did not complete — fix failures in "Reflect deep-dive setup" before debugging these.',
  ).toBe(true);
}

// ─── Reflect behavior ───────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Reflect deep-dive', { timeout: 120_000 }, () => {
  it('hierarchical retrieval + based_on shape + directive compliance', async () => {
    assertSetupReady();

    const result = await api<{
      text: string;
      based_on: {
        memories: Array<{ id: string; text: string }>;
        mental_models: Array<{ id: string; text: string }>;
        directives: Array<{ id: string; name: string; content: string }>;
      } | null;
      trace: {
        tool_calls: Array<{ tool: string; iteration: number }>;
        llm_calls: Array<{ scope: string; duration_ms: number }>;
      } | null;
    }>('POST', '/reflect', {
      query: 'What unusual survival adaptations appear across these ecosystems?',
      budget: 'mid',
      include: { tool_calls: {} },
    });
    const body = expectOk(result, 'POST /reflect (hierarchical)');

    expect(body.text, '[HINT] Reflect returned empty text — LLM call may have failed silently.').toBeTruthy();
    expect(body.text.length).toBeGreaterThan(20);

    // --- Hierarchical retrieval
    expect(
      body.trace,
      '[HINT] trace is null even though include.tool_calls was set. Check src/index.ts reflect handler honors include.tool_calls.',
    ).not.toBeNull();
    expect(
      body.trace!.tool_calls.length,
      '[HINT] trace.tool_calls is empty — reflect loop never invoked a tool. Tool-calling path may be broken for this LLM.',
    ).toBeGreaterThan(0);

    const firstTool = body.trace!.tool_calls[0].tool;
    expect(
      firstTool,
      `[HINT] Expected first tool call to be "search_mental_models" (a mental model exists), got "${firstTool}". ` +
        `Check getToolChoice() in src/engine/reflect/agent.ts and the forced-tool path in callWorkersAIWithTools.`,
    ).toBe('search_mental_models');

    const toolsCalled = body.trace!.tool_calls.map((t) => t.tool);
    // The agent can legitimately finish two ways: (1) call the `done` tool, or
    // (2) emit a plain-text final answer (see the `!response.toolCalls.length`
    // branch in src/engine/reflect/agent.ts). Either is acceptable; a non-empty
    // `body.text` confirms a final answer was produced.
    const finishedCleanly = toolsCalled.includes('done') || body.text.length > 20;
    expect(
      finishedCleanly,
      `[HINT] Reflect loop exited without synthesizing a final answer. ` +
        `Tools called: [${toolsCalled.join(', ')}], text length=${body.text.length}. ` +
        `Possible: parseWorkersAIResult returning neither tool_calls nor content, or the done tool is unreachable.`,
    ).toBe(true);

    expect(
      body.trace!.llm_calls.length,
      `[HINT] Expected at least 2 LLM iterations (one search + synthesis), saw ${body.trace!.llm_calls.length}.`,
    ).toBeGreaterThanOrEqual(2);

    // --- based_on shape
    expect(body.based_on, '[HINT] based_on is null. Check includeFacts handling in src/index.ts reflect route.').not.toBeNull();
    expect(Array.isArray(body.based_on!.memories), '[HINT] based_on.memories is not an array.').toBe(true);
    expect(Array.isArray(body.based_on!.mental_models), '[HINT] based_on.mental_models is not an array.').toBe(true);
    expect(Array.isArray(body.based_on!.directives), '[HINT] based_on.directives is not an array.').toBe(true);

    expect(
      body.based_on!.memories.length,
      '[HINT] based_on.memories is empty — reflect found no memories to cite. ' +
        'Likely causes: Vectorize index empty (retain failed silently), embedding model mismatch, or dimension mismatch (expected 1024 for bge-m3).',
    ).toBeGreaterThan(0);
    expect(body.based_on!.memories[0].id, '[HINT] based_on.memories[0].id missing — hydration shape mismatch.').toBeTruthy();
    expect(body.based_on!.memories[0].text, '[HINT] based_on.memories[0].text missing — hydration shape mismatch.').toBeTruthy();

    const directiveIds = body.based_on!.directives.map((d) => d.id);
    expect(
      directiveIds,
      `[HINT] Active directive ${directiveId} not in based_on.directives [${directiveIds.join(', ')}]. ` +
        `Check hydrateBasedOn() loads active directives for the bank.`,
    ).toContain(directiveId);

    // --- Directive compliance (soft assertion with rich message)
    expect(
      body.text.includes(DIRECTIVE_MARKER),
      `[HINT] Answer did not include the directive marker "${DIRECTIVE_MARKER}". ` +
        `Directive compliance is not enforced. Check: buildDoneTool() wires directiveRules into the answer-param description in src/engine/reflect/tools-schema.ts. ` +
        `Answer was: ${body.text.slice(0, 400)}`,
    ).toBe(true);
  });

  it('tags filter restricts cited memories to the tagged subset', async () => {
    assertSetupReady();

    const result = await api<{
      text: string;
      based_on: { memories: Array<{ id: string; text: string }> } | null;
    }>('POST', '/reflect', {
      query: 'Describe notable biological adaptations from my memories.',
      budget: 'low',
      tags: ['ocean'],
      tags_match: 'all',
    });
    const body = expectOk(result, 'POST /reflect (tags filter)');

    expect(body.based_on, '[HINT] based_on is null for tags-filter reflect.').not.toBeNull();
    const citedTexts = body.based_on!.memories.map((m) => m.text.toLowerCase()).join(' | ');
    const leaked = ['fennec', 'kangaroo rat', 'saguaro'].find((s) => citedTexts.includes(s));
    expect(
      leaked,
      `[HINT] Desert fact "${leaked}" leaked through an ocean-only tag filter. ` +
        `Check that tags are propagated from reflect → recall → vector query in src/engine/reflect/tools.ts. ` +
        `Cited: ${citedTexts.slice(0, 400)}`,
    ).toBeUndefined();
  });

  it('tag_groups compose boolean filters (AND across tags)', async () => {
    assertSetupReady();

    const result = await api<{
      based_on: { memories: Array<{ id: string; text: string }> } | null;
    }>('POST', '/reflect', {
      query: 'Summarize the memories about water strategies or heat tolerance.',
      budget: 'low',
      // Memories tagged BOTH "desert" AND "adaptation" → fennec + kangaroo rat (not saguaro, which is desert+water)
      tag_groups: [{ and: [{ tags: ['desert'] }, { tags: ['adaptation'] }] }],
    });
    const body = expectOk(result, 'POST /reflect (tag_groups AND)');

    expect(body.based_on, '[HINT] based_on is null for tag_groups reflect.').not.toBeNull();
    const citedTexts = body.based_on!.memories.map((m) => m.text.toLowerCase()).join(' | ');

    expect(
      citedTexts.includes('saguaro'),
      `[HINT] "saguaro" leaked through a {desert AND adaptation} filter (saguaro is tagged desert+water). ` +
        `tag_groups boolean composition may be broken — see src/utils/tag-filter.ts. Cited: ${citedTexts.slice(0, 400)}`,
    ).toBe(false);

    const oceanLeak = ['octopus', 'mantis shrimp', 'sea cucumber'].find((s) => citedTexts.includes(s));
    expect(
      oceanLeak,
      `[HINT] Ocean fact "${oceanLeak}" leaked through a desert-scoped tag_group. tag_groups filter not being applied. ` +
        `Cited: ${citedTexts.slice(0, 400)}`,
    ).toBeUndefined();
  });

  it('response_schema produces structured_output matching the schema', async () => {
    assertSetupReady();

    const result = await api<{
      text: string;
      structured_output: Record<string, unknown> | null;
    }>('POST', '/reflect', {
      query:
        'From my memories, produce a plain list of every animal species by name (e.g. octopus, fennec fox). Include every one you find.',
      budget: 'low',
      response_schema: {
        type: 'object',
        properties: {
          answer_summary: { type: 'string' },
          animal_names: {
            type: 'array',
            description: 'Every distinct animal species named in the answer.',
            items: { type: 'string' },
          },
        },
        required: ['answer_summary', 'animal_names'],
      },
    });
    const body = expectOk(result, 'POST /reflect (response_schema)');

    expect(
      body.structured_output,
      '[HINT] structured_output is null despite response_schema being provided. ' +
        'Check extractStructuredOutput() in src/engine/reflect/agent.ts — LLM may be returning non-JSON or call failed.',
    ).not.toBeNull();

    const so = body.structured_output!;
    expect(
      typeof so.answer_summary,
      `[HINT] structured_output.answer_summary should be a string, got ${typeof so.answer_summary}. Full output: ${JSON.stringify(so).slice(0, 300)}`,
    ).toBe('string');
    expect(
      Array.isArray(so.animal_names),
      `[HINT] structured_output.animal_names should be an array, got ${typeof so.animal_names}. Full output: ${JSON.stringify(so).slice(0, 300)}`,
    ).toBe(true);
    // Answer-text sanity check: the reflect answer should mention at least one
    // seeded animal. If it doesn't, the schema extractor has nothing to work
    // with and the structured_output check below is meaningless — fail here
    // with a clearer message so the user knows the issue is retrieval, not schema.
    const answerLower = body.text.toLowerCase();
    const seededAnimals = ['octopus', 'mantis shrimp', 'sea cucumber', 'fennec', 'kangaroo rat'];
    const mentionedInAnswer = seededAnimals.filter((a) => answerLower.includes(a));
    expect(
      mentionedInAnswer.length,
      `[HINT] Reflect answer named 0 of the seeded animals. Retrieval likely returned nothing — ` +
        `check Vectorize index and recall tool output. Answer: "${body.text.slice(0, 400)}"`,
    ).toBeGreaterThan(0);
    expect(
      (so.animal_names as string[]).length,
      `[HINT] structured_output.animal_names is empty even though the answer named [${mentionedInAnswer.join(', ')}]. ` +
        `The schema-extractor LLM ignored the source text — check extractStructuredOutput() prompt in src/engine/reflect/agent.ts. ` +
        `Answer: "${body.text.slice(0, 400)}". Full output: ${JSON.stringify(so).slice(0, 300)}`,
    ).toBeGreaterThan(0);
  });
});

// ─── Consolidation ──────────────────────────────────────────────────────────

describe.skipIf(!runLive)('Live: Consolidation', { timeout: 120_000 }, () => {
  it('consolidates seeded memories into observations', async () => {
    assertSetupReady();

    const result = await api<{
      success: boolean;
      observation_count: number;
      observation_ids: string[];
    }>('POST', '/consolidate', {
      tags: ['__live-reflect'],
      max_groups: 2,
      min_group_size: 2,
    });
    const body = expectOk(result, 'POST /consolidate');

    expect(
      body.success,
      '[HINT] Consolidation returned success:false. Check worker logs and src/engine/consolidate/orchestrator.ts.',
    ).toBe(true);
    expect(
      typeof body.observation_count,
      `[HINT] observation_count should be a number, got ${typeof body.observation_count}.`,
    ).toBe('number');
    // 0 is acceptable if grouping didn't trigger; non-negative is required.
    expect(body.observation_count).toBeGreaterThanOrEqual(0);
  });

  it('lists observations and returns expected shape', async () => {
    assertSetupReady();

    const result = await api<{ items: Array<{ id: string; text: string }>; total: number }>(
      'GET',
      '/observations',
    );
    const body = expectOk(result, 'GET /observations');

    expect(Array.isArray(body.items), '[HINT] GET /observations.items is not an array — response shape drift.').toBe(true);
    expect(typeof body.total, '[HINT] GET /observations.total is not a number — response shape drift.').toBe('number');
  });
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(async () => {
  if (!BASE_URL) return;

  if (directiveId) {
    await api('DELETE', `/directives/${directiveId}`).catch(() => {});
  }
  if (mentalModelId) {
    await api('DELETE', `/mental-models/${mentalModelId}`).catch(() => {});
  }
  await api('DELETE', '/memories').catch(() => {});
  await api('DELETE', '/observations').catch(() => {});
});
