/**
 * Reflect agent — main agentic LLM loop.
 *
 * Ported from hindsight-api/engine/reflect/agent.py.
 *
 * The reflect agent answers questions by iteratively searching through
 * memories using a tool-calling LLM. It follows a hierarchical retrieval
 * strategy: mental models → observations → raw memories → expand → done.
 */

import type { Env } from '../../env';
import type { DispositionTraits } from '../../types';
import type { ReflectConfig, ReflectResult, ReflectToolTrace, ReflectLLMTrace, BasedOn } from './types';
import { BUDGET_ITERATIONS } from './types';
import { buildReflectSystemPrompt, buildFinalPrompt } from './prompts';
import { getReflectTools } from './tools-schema';
import { executeTool } from './tools';
import { llmChatWithTools, type ToolChatMessage } from '../../providers/llm-tools';
import { llmChat, type ChatMessage } from '../../providers/llm';

// =============================================================================
// Main Agent
// =============================================================================

/**
 * Run the reflect agent loop.
 */
export async function reflect(env: Env, config: ReflectConfig): Promise<ReflectResult> {
  const maxIterations = BUDGET_ITERATIONS[config.budget] ?? 7;
  const toolTraces: ReflectToolTrace[] = [];
  const llmTraces: ReflectLLMTrace[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  // Load bank profile
  const bankRow = await env.DB.prepare('SELECT name, disposition, mission, background FROM banks WHERE bank_id = ?')
    .bind(config.bankId)
    .first<{
      name: string;
      disposition: string;
      mission: string;
      background: string;
    }>();

  const profile = {
    name: bankRow?.name ?? config.bankId,
    disposition: parseDisposition(bankRow?.disposition),
    mission: bankRow?.mission ?? '',
    background: bankRow?.background ?? null,
  };

  // Load directives
  const directiveRows = await env.DB.prepare(
    'SELECT id, name, content, priority FROM directives WHERE bank_id = ? AND is_active = 1 ORDER BY priority DESC',
  )
    .bind(config.bankId)
    .all();

  const directives = (directiveRows.results as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    content: r.content as string,
    priority: r.priority as number,
  }));

  // Check if bank has mental models
  const mmCount = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(config.bankId)
    .first<{ c: number }>();
  const hasMentalModels = (mmCount?.c ?? 0) > 0;

  // Build system prompt
  const systemPrompt = buildReflectSystemPrompt(profile, directives, hasMentalModels);

  // Build tools
  const tools = getReflectTools({
    hasMentalModels,
    hasDirectives: directives.length > 0,
  });

  // Build initial messages
  let userQuery = config.query;
  if (config.context) {
    userQuery = `Context: ${config.context}\n\nQuestion: ${config.query}`;
  }

  const messages: ToolChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userQuery },
  ];

  // Track retrieved IDs for validation
  const retrievedMemoryIds = new Set<string>();
  const retrievedMentalModelIds = new Set<string>();
  const retrievedObservationIds = new Set<string>();

  let finalAnswer: string | null = null;
  let doneMemoryIds: string[] = [];
  let doneMentalModelIds: string[] = [];
  let doneObservationIds: string[] = [];

  // ==========================================================================
  // Agent Loop
  // ==========================================================================
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLastIteration = iteration === maxIterations - 1;

    // Determine tool_choice based on iteration (hierarchical retrieval)
    const toolChoice = getToolChoice(iteration, hasMentalModels, isLastIteration);

    // If last iteration and no answer yet, force done
    if (isLastIteration && !finalAnswer) {
      messages.push({ role: 'user', content: buildFinalPrompt() });
    }

    // LLM call
    const llmStart = Date.now();
    const response = await llmChatWithTools(env, messages, tools, {
      maxTokens: config.maxTokens ?? 4096,
      temperature: 0.1,
      toolChoice,
    });
    const llmDuration = Date.now() - llmStart;

    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;
    llmTraces.push({ scope: `iteration_${iteration}`, duration_ms: llmDuration });

    // No tool calls — LLM responded with text (shouldn't happen normally)
    if (!response.toolCalls.length) {
      if (response.content) {
        finalAnswer = cleanAnswer(response.content);
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    // Execute tool calls (parallel if multiple)
    const toolPromises = response.toolCalls.map(async (tc) => {
      const args = safeParseJSON(tc.function.arguments);
      const toolStart = Date.now();

      const result = await executeTool(env, config.bankId, tc.function.name, args, config.tags, config.tagsMatch);

      const toolDuration = Date.now() - toolStart;

      toolTraces.push({
        tool: tc.function.name,
        input: args,
        output: config.includeToolOutput ? result.output : null,
        duration_ms: toolDuration,
        iteration,
      });

      // Track retrieved IDs
      for (const id of result.memoryIds) retrievedMemoryIds.add(id);
      for (const id of result.mentalModelIds) retrievedMentalModelIds.add(id);
      for (const id of result.observationIds) retrievedObservationIds.add(id);

      return { tc, result };
    });

    const toolResults = await Promise.all(toolPromises);

    // Add tool results to messages
    for (const { tc, result } of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.output),
      });

      // Check if done was called
      if (tc.function.name === 'done') {
        const args = safeParseJSON(tc.function.arguments);
        finalAnswer = cleanAnswer(String(args.answer ?? ''));
        doneMemoryIds = (args.memory_ids ?? []) as string[];
        doneMentalModelIds = (args.mental_model_ids ?? []) as string[];
        doneObservationIds = (args.observation_ids ?? []) as string[];
      }
    }

    if (finalAnswer) break;
  }

  // If no answer was produced, use last content or a fallback
  if (!finalAnswer) {
    finalAnswer = 'I was unable to find a complete answer in the available memories.';
  }

  // Validate cited IDs (filter hallucinated ones)
  const validMemoryIds = doneMemoryIds.filter((id) => retrievedMemoryIds.has(id));
  const validMentalModelIds = doneMentalModelIds.filter((id) => retrievedMentalModelIds.has(id));
  // Observation IDs validated against retrieved set (for future use in basedOn)
  doneObservationIds.filter((id) => retrievedObservationIds.has(id));

  // Build based_on with hydrated data
  let basedOn: BasedOn | null = null;
  if (config.includeFacts !== false) {
    basedOn = await hydrateBasedOn(env, config.bankId, validMemoryIds, validMentalModelIds, directives);
  }

  // Handle structured output
  let structuredOutput: Record<string, unknown> | null = null;
  if (config.responseSchema) {
    const soResult = await extractStructuredOutput(env, finalAnswer, config.responseSchema);
    structuredOutput = soResult.data;
    totalInput += soResult.inputTokens;
    totalOutput += soResult.outputTokens;
    llmTraces.push({ scope: 'structured_output', duration_ms: soResult.durationMs });
  }

  return {
    text: finalAnswer,
    basedOn,
    structuredOutput,
    usage: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
    },
    trace: config.includeToolCalls !== false ? { tool_calls: toolTraces, llm_calls: llmTraces } : null,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determine tool_choice for each iteration based on hierarchical retrieval.
 */
function getToolChoice(
  iteration: number,
  hasMentalModels: boolean,
  isLastIteration: boolean,
): 'auto' | { type: 'function'; function: { name: string } } {
  if (isLastIteration) {
    return { type: 'function', function: { name: 'done' } };
  }

  if (hasMentalModels) {
    switch (iteration) {
      case 0:
        return { type: 'function', function: { name: 'search_mental_models' } };
      case 1:
        return { type: 'function', function: { name: 'search_observations' } };
      case 2:
        return { type: 'function', function: { name: 'recall' } };
      default:
        return 'auto';
    }
  } else {
    switch (iteration) {
      case 0:
        return { type: 'function', function: { name: 'search_observations' } };
      case 1:
        return { type: 'function', function: { name: 'recall' } };
      default:
        return 'auto';
    }
  }
}

/**
 * Clean LLM answer text of common artifacts.
 */
function cleanAnswer(text: string): string {
  return (
    text
      // Remove leaked JSON tool call syntax
      .replace(/\{"tool_call"[\s\S]*?\}/g, '')
      // Remove markdown code fence artifacts
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/\n?\s*```/g, '')
      .trim()
  );
}

/**
 * Parse JSON safely, returning empty object on failure.
 */
function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Parse disposition JSON string.
 */
function parseDisposition(raw: string | null | undefined): DispositionTraits {
  if (!raw) return { skepticism: 3, literalism: 3, empathy: 3 };
  try {
    return JSON.parse(raw) as DispositionTraits;
  } catch {
    return { skepticism: 3, literalism: 3, empathy: 3 };
  }
}

/**
 * Hydrate the based_on field with memory/mental model details.
 */
async function hydrateBasedOn(
  env: Env,
  bankId: string,
  memoryIds: string[],
  mentalModelIds: string[],
  directives: Array<{ id: string; name: string; content: string }>,
): Promise<BasedOn> {
  const basedOn: BasedOn = {
    memories: [],
    mental_models: [],
    directives,
  };

  // Hydrate memories
  if (memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, text, fact_type, context, occurred_start, occurred_end
       FROM memory_units WHERE id IN (${placeholders}) AND bank_id = ?`,
    )
      .bind(...memoryIds, bankId)
      .all();

    for (const row of rows.results as Array<Record<string, unknown>>) {
      basedOn.memories.push({
        id: row.id as string,
        text: row.text as string,
        type: row.fact_type as string,
        context: row.context as string | null,
        occurred_start: row.occurred_start as string | null,
        occurred_end: row.occurred_end as string | null,
      });
    }
  }

  // Hydrate mental models
  if (mentalModelIds.length > 0) {
    const placeholders = mentalModelIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, text, context FROM memory_units WHERE id IN (${placeholders}) AND bank_id = ?`,
    )
      .bind(...mentalModelIds, bankId)
      .all();

    for (const row of rows.results as Array<Record<string, unknown>>) {
      basedOn.mental_models.push({
        id: row.id as string,
        text: row.text as string,
        context: row.context as string | null,
      });
    }
  }

  return basedOn;
}

/**
 * Extract structured output from the answer using an extra LLM call.
 */
async function extractStructuredOutput(
  env: Env,
  answer: string,
  schema: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> | null; inputTokens: number; outputTokens: number; durationMs: number }> {
  const start = Date.now();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a structured data extractor. Extract information from the provided text into the specified JSON schema. Output ONLY valid JSON, nothing else.\n\nSchema:\n${JSON.stringify(schema, null, 2)}`,
    },
    {
      role: 'user',
      content: `Extract structured data from this text:\n\n${answer}`,
    },
  ];

  try {
    const response = await llmChat(env, messages, { maxTokens: 2048, temperature: 0 });
    const durationMs = Date.now() - start;

    // Try to parse the response as JSON
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(response.content) as Record<string, unknown>;
    } catch {
      // Try extracting from markdown code blocks
      const match = response.content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (match) {
        try {
          data = JSON.parse(match[1]) as Record<string, unknown>;
        } catch {
          data = null;
        }
      }
    }

    return {
      data,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs,
    };
  } catch {
    return { data: null, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start };
  }
}
