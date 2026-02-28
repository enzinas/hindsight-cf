/**
 * Tool execution for the reflect agent.
 *
 * Implements the 5 reflect tools: search_mental_models, search_observations,
 * recall, expand, done.
 *
 * Ported from hindsight-api/engine/reflect/tools.py.
 */

import type { Env } from '../../env';
import type { FactType } from '../../types';
import { recall as recallPipeline } from '../recall/orchestrator';
import { vectorSearch } from '../recall/vector-search';
import { BUDGET_LIMITS } from '../recall/types';

// =============================================================================
// Tool Result Types
// =============================================================================

export interface ToolResult {
  output: Record<string, unknown>;
  memoryIds: string[];
  mentalModelIds: string[];
  observationIds: string[];
}

// =============================================================================
// Tool Execution
// =============================================================================

/**
 * Execute a tool call and return the result.
 */
export async function executeTool(
  env: Env,
  bankId: string,
  toolName: string,
  args: Record<string, unknown>,
  tags?: string[] | null,
  tagsMatch?: string,
): Promise<ToolResult> {
  switch (toolName) {
    case 'search_mental_models':
      return executeSearchMentalModels(env, bankId, args, tags);
    case 'search_observations':
      return executeSearchObservations(env, bankId, args, tags);
    case 'recall':
      return executeRecall(env, bankId, args, tags, tagsMatch);
    case 'expand':
      return executeExpand(env, bankId, args);
    case 'done':
      return executeDone(args);
    default:
      return {
        output: { error: `Unknown tool: ${toolName}` },
        memoryIds: [],
        mentalModelIds: [],
        observationIds: [],
      };
  }
}

/**
 * Search mental models (fact_type = 'mental_model').
 */
async function executeSearchMentalModels(
  env: Env,
  bankId: string,
  args: Record<string, unknown>,
  tags?: string[] | null,
): Promise<ToolResult> {
  const query = String(args.query ?? '');
  const maxResults = Number(args.max_results ?? 5);

  // Vector search filtered to mental_model type
  const results = await vectorSearch(env, bankId, query, {
    topK: maxResults,
    factTypes: ['mental_model'] as FactType[],
    tags: tags ?? undefined,
  });

  const mentalModelIds = results.map((r) => r.id);
  const items = results.map((r) => ({
    id: r.id,
    text: r.text,
    context: r.context,
    score: r.score,
  }));

  return {
    output: { results: items, count: items.length },
    memoryIds: [],
    mentalModelIds,
    observationIds: [],
  };
}

/**
 * Search observations (fact_type = 'observation').
 */
async function executeSearchObservations(
  env: Env,
  bankId: string,
  args: Record<string, unknown>,
  tags?: string[] | null,
): Promise<ToolResult> {
  const query = String(args.query ?? '');

  // Vector search filtered to observation type
  const results = await vectorSearch(env, bankId, query, {
    topK: 20,
    factTypes: ['observation'] as FactType[],
    tags: tags ?? undefined,
  });

  const observationIds = results.map((r) => r.id);
  const items = results.map((r) => ({
    id: r.id,
    text: r.text,
    context: r.context,
    score: r.score,
  }));

  return {
    output: { results: items, count: items.length },
    memoryIds: [],
    mentalModelIds: [],
    observationIds,
  };
}

/**
 * Recall memories (full recall pipeline).
 */
async function executeRecall(
  env: Env,
  bankId: string,
  args: Record<string, unknown>,
  tags?: string[] | null,
  tagsMatch?: string,
): Promise<ToolResult> {
  const query = String(args.query ?? '');
  const budget = 'mid';

  const result = await recallPipeline(env, bankId, query, {
    maxResults: BUDGET_LIMITS[budget] ?? 25,
    factTypes: ['world', 'experience', 'opinion'] as FactType[],
    tags: tags ?? undefined,
    tagsMatch: (tagsMatch as 'any' | 'all') ?? undefined,
    trace: false,
  });

  const memoryIds = result.results.map((r) => r.id);
  const items = result.results.map((r) => ({
    id: r.id,
    text: r.text,
    type: r.type,
    context: r.context,
    occurred_start: r.occurred_start,
    occurred_end: r.occurred_end,
  }));

  return {
    output: { results: items, count: items.length },
    memoryIds,
    mentalModelIds: [],
    observationIds: [],
  };
}

/**
 * Expand memories — get surrounding context (chunk text).
 */
async function executeExpand(env: Env, bankId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const memoryIds = (args.memory_ids ?? []) as string[];
  if (!memoryIds.length) {
    return { output: { results: [] }, memoryIds: [], mentalModelIds: [], observationIds: [] };
  }

  const placeholders = memoryIds.map(() => '?').join(',');

  // Get the memory units with their chunk IDs
  const units = await env.DB.prepare(
    `SELECT id, text, chunk_id, document_id FROM memory_units
     WHERE id IN (${placeholders}) AND bank_id = ?`,
  )
    .bind(...memoryIds, bankId)
    .all();

  // Get chunks for context
  const chunkIds = (units.results as Array<Record<string, unknown>>).map((r) => r.chunk_id as string).filter(Boolean);

  const chunkMap: Record<string, string> = {};
  if (chunkIds.length > 0) {
    const uniqueChunkIds = [...new Set(chunkIds)];
    const chunkPlaceholders = uniqueChunkIds.map(() => '?').join(',');
    const chunks = await env.DB.prepare(
      `SELECT chunk_id, chunk_text FROM chunks WHERE chunk_id IN (${chunkPlaceholders}) AND bank_id = ?`,
    )
      .bind(...uniqueChunkIds, bankId)
      .all();

    for (const row of chunks.results as Array<Record<string, unknown>>) {
      chunkMap[row.chunk_id as string] = row.chunk_text as string;
    }
  }

  const items = (units.results as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    text: row.text,
    chunk_text: row.chunk_id ? (chunkMap[row.chunk_id as string] ?? null) : null,
  }));

  return {
    output: { results: items },
    memoryIds,
    mentalModelIds: [],
    observationIds: [],
  };
}

/**
 * Done — extract final answer and cited IDs.
 */
function executeDone(args: Record<string, unknown>): ToolResult {
  return {
    output: {
      answer: String(args.answer ?? ''),
      completed: true,
    },
    memoryIds: (args.memory_ids ?? []) as string[],
    mentalModelIds: (args.mental_model_ids ?? []) as string[],
    observationIds: (args.observation_ids ?? []) as string[],
  };
}
