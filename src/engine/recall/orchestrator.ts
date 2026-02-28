/**
 * Recall pipeline orchestrator.
 *
 * Coordinates 4-way parallel retrieval, fusion, reranking,
 * and entity/chunk hydration.
 *
 * Flow:
 *   1. Run vector search + FTS + graph + temporal in parallel
 *   2. Reciprocal rank fusion to merge results
 *   3. Cross-encoder reranking
 *   4. Entity state hydration (optional)
 *   5. Chunk hydration (optional)
 *   6. Return formatted results
 *
 * Ported from hindsight-api/engine/memory_engine.py recall_async
 * and hindsight-api/engine/search/retrieval.py.
 */

import type { Env } from '../../env';
import type {
  RecallConfig,
  RecallTrace,
  ScoredResult,
  EntityState,
  ChunkInfo,
} from './types';
import { BUDGET_LIMITS } from './types';
import { vectorSearch } from './vector-search';
import { ftsSearch } from './fts-search';
import { graphRetrieval, temporalRetrieval } from './graph-retrieval';
import { reciprocalRankFusion } from './fusion';
import { rerankCandidates } from './reranking';

/** Formatted recall result matching the original API response. */
export interface RecallResultItem {
  id: string;
  text: string;
  type?: string | null;
  entities?: string[] | null;
  context?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  metadata?: Record<string, string> | null;
  chunk_id?: string | null;
  tags?: string[] | null;
  source_fact_ids?: string[] | null;
}

export interface RecallResponse {
  results: RecallResultItem[];
  trace?: RecallTrace | null;
  entities?: Record<string, EntityState> | null;
  chunks?: Record<string, ChunkInfo> | null;
  source_facts?: Record<string, RecallResultItem> | null;
}

/**
 * Run the full recall pipeline.
 */
export async function recall(
  env: Env,
  bankId: string,
  query: string,
  config: RecallConfig,
): Promise<RecallResponse> {
  const maxResults = config.maxResults || BUDGET_LIMITS[config.maxResults?.toString() ?? 'mid'] || 25;
  const timings: Record<string, number> = {};

  // Step 1: 4-way parallel retrieval
  const retrievalStart = Date.now();
  const queryTimestamp = config.queryTimestamp ?? new Date().toISOString();

  const [semanticResults, ftsResults, graphResults, temporalResults] = await Promise.all([
    vectorSearch(env, bankId, query, {
      topK: maxResults * 2,
      factTypes: config.factTypes,
      tags: config.tags,
    }),
    ftsSearch(env, bankId, query, {
      limit: maxResults * 2,
      factTypes: config.factTypes,
      tags: config.tags,
    }),
    // Graph retrieval uses seed IDs from vector search
    // We run vector search first conceptually, but since we await all,
    // we use a chained approach: run graph after semantic completes
    (async () => {
      const seeds = await vectorSearch(env, bankId, query, {
        topK: 10,
        factTypes: config.factTypes,
        tags: config.tags,
      });
      return graphRetrieval(env, bankId, seeds.map((s) => s.id), {
        maxHops: 2,
        maxResults: maxResults,
        factTypes: config.factTypes,
        tags: config.tags,
      });
    })(),
    temporalRetrieval(env, bankId, queryTimestamp, {
      factTypes: config.factTypes,
      tags: config.tags,
    }),
  ]);

  timings.retrieval_ms = Date.now() - retrievalStart;

  // Step 2: Reciprocal rank fusion
  const fusionStart = Date.now();
  const merged = reciprocalRankFusion(
    semanticResults,
    ftsResults,
    graphResults,
    temporalResults,
  );
  timings.fusion_ms = Date.now() - fusionStart;

  // Step 3: Reranking
  const rerankStart = Date.now();
  const scored = await rerankCandidates(env, query, merged, maxResults);
  timings.rerank_ms = Date.now() - rerankStart;

  // Step 4: Format results
  const results = scored.map(formatResult);

  // Step 5: Entity hydration (optional)
  let entities: Record<string, EntityState> | null = null;
  if (config.includeEntities) {
    const hydrationStart = Date.now();
    entities = await hydrateEntities(env, bankId, scored);
    timings.entity_hydration_ms = Date.now() - hydrationStart;
  }

  // Step 6: Chunk hydration (optional)
  let chunks: Record<string, ChunkInfo> | null = null;
  if (config.includeChunks) {
    const chunkStart = Date.now();
    chunks = await hydrateChunks(env, bankId, scored);
    timings.chunk_hydration_ms = Date.now() - chunkStart;
  }

  // Step 7: Source fact hydration (optional)
  let sourceFacts: Record<string, RecallResultItem> | null = null;
  if (config.includeSourceFacts) {
    const sourceStart = Date.now();
    sourceFacts = await hydrateSourceFacts(env, bankId, scored);
    timings.source_fact_hydration_ms = Date.now() - sourceStart;
  }

  // Build trace
  const trace: RecallTrace | null = config.trace
    ? {
        semanticCount: semanticResults.length,
        ftsCount: ftsResults.length,
        graphCount: graphResults.length,
        temporalCount: temporalResults.length,
        fusedCount: merged.length,
        rerankedCount: scored.length,
        timings,
      }
    : null;

  return {
    results,
    trace,
    entities,
    chunks,
    source_facts: sourceFacts,
  };
}

/** Format a scored result into the API response format. */
function formatResult(scored: ScoredResult): RecallResultItem {
  const r = scored.candidate.result;
  return {
    id: r.id,
    text: r.text,
    type: r.factType,
    context: r.context,
    occurred_start: r.occurredStart,
    occurred_end: r.occurredEnd,
    mentioned_at: r.mentionedAt,
    document_id: r.documentId,
    metadata: r.metadata && Object.keys(r.metadata).length > 0 ? r.metadata : null,
    chunk_id: r.chunkId,
    tags: r.tags?.length ? r.tags : null,
  };
}

/**
 * Hydrate entity state for result memory units.
 *
 * Finds entities linked to the returned memories and
 * returns their canonical names with recent observations.
 */
async function hydrateEntities(
  env: Env,
  bankId: string,
  scored: ScoredResult[],
): Promise<Record<string, EntityState>> {
  const unitIds = scored.map((s) => s.candidate.result.id);
  if (!unitIds.length) return {};

  const placeholders = unitIds.map(() => '?').join(',');

  // Get entities linked to these units
  const entityRows = await env.DB.prepare(
    `SELECT ue.unit_id, e.id AS entity_id, e.canonical_name
     FROM unit_entities ue
     JOIN entities e ON e.id = ue.entity_id
     WHERE ue.unit_id IN (${placeholders}) AND e.bank_id = ?`,
  )
    .bind(...unitIds, bankId)
    .all();

  const entities: Record<string, EntityState> = {};
  for (const row of entityRows.results as Array<Record<string, unknown>>) {
    const entityId = row.entity_id as string;
    if (!entities[entityId]) {
      entities[entityId] = {
        entityId,
        canonicalName: row.canonical_name as string,
        observations: [],
      };
    }
  }

  // Get recent observations for each entity
  const entityIds = Object.keys(entities);
  if (entityIds.length) {
    const ePlaceholders = entityIds.map(() => '?').join(',');
    const obsRows = await env.DB.prepare(
      `SELECT ue.entity_id, m.text, m.mentioned_at
       FROM unit_entities ue
       JOIN memory_units m ON m.id = ue.unit_id
       WHERE ue.entity_id IN (${ePlaceholders}) AND m.bank_id = ?
       ORDER BY m.event_date DESC`,
    )
      .bind(...entityIds, bankId)
      .all();

    for (const row of obsRows.results as Array<Record<string, unknown>>) {
      const entityId = row.entity_id as string;
      if (entities[entityId] && entities[entityId].observations.length < 10) {
        entities[entityId].observations.push({
          text: row.text as string,
          mentionedAt: row.mentioned_at as string | null,
        });
      }
    }
  }

  return entities;
}

/**
 * Hydrate chunk data for result memory units.
 */
async function hydrateChunks(
  env: Env,
  bankId: string,
  scored: ScoredResult[],
): Promise<Record<string, ChunkInfo>> {
  const chunkIds = scored
    .map((s) => s.candidate.result.chunkId)
    .filter((id): id is string => !!id);

  if (!chunkIds.length) return {};

  const uniqueIds = [...new Set(chunkIds)];
  const placeholders = uniqueIds.map(() => '?').join(',');

  const rows = await env.DB.prepare(
    `SELECT chunk_id, chunk_text, chunk_index
     FROM chunks
     WHERE chunk_id IN (${placeholders}) AND bank_id = ?`,
  )
    .bind(...uniqueIds, bankId)
    .all();

  const chunks: Record<string, ChunkInfo> = {};
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const maxTokens = 2000; // Default chunk token limit
    const text = row.chunk_text as string;
    const truncated = text.length > maxTokens * 4; // rough char estimate

    chunks[row.chunk_id as string] = {
      id: row.chunk_id as string,
      text: truncated ? text.substring(0, maxTokens * 4) : text,
      chunkIndex: row.chunk_index as number,
      truncated,
    };
  }

  return chunks;
}

/**
 * Hydrate source facts for observation-type results.
 */
async function hydrateSourceFacts(
  env: Env,
  bankId: string,
  scored: ScoredResult[],
): Promise<Record<string, RecallResultItem>> {
  // Collect source_memory_ids from observation-type results
  const unitIds = scored
    .filter((s) => s.candidate.result.factType === 'observation')
    .map((s) => s.candidate.result.id);

  if (!unitIds.length) return {};

  const placeholders = unitIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, source_memory_ids FROM memory_units
     WHERE id IN (${placeholders}) AND bank_id = ?`,
  )
    .bind(...unitIds, bankId)
    .all();

  const sourceIds = new Set<string>();
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const ids = parseJsonArray(row.source_memory_ids);
    for (const id of ids) sourceIds.add(id);
  }

  if (!sourceIds.size) return {};

  const sourceIdArr = [...sourceIds];
  const sPlaceholders = sourceIdArr.map(() => '?').join(',');
  const sourceRows = await env.DB.prepare(
    `SELECT id, text, fact_type, context, occurred_start, occurred_end,
            mentioned_at, document_id, metadata, tags
     FROM memory_units
     WHERE id IN (${sPlaceholders}) AND bank_id = ?`,
  )
    .bind(...sourceIdArr, bankId)
    .all();

  const sourceFacts: Record<string, RecallResultItem> = {};
  for (const row of sourceRows.results as Array<Record<string, unknown>>) {
    sourceFacts[row.id as string] = {
      id: row.id as string,
      text: row.text as string,
      type: row.fact_type as string,
      context: row.context as string | null,
      occurred_start: row.occurred_start as string | null,
      occurred_end: row.occurred_end as string | null,
      mentioned_at: row.mentioned_at as string | null,
      document_id: row.document_id as string | null,
      metadata: parseJsonObj(row.metadata),
      tags: parseJsonArray(row.tags),
    };
  }

  return sourceFacts;
}

function parseJsonArray(val: unknown): string[] {
  if (!val || val === '[]') return [];
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  if (Array.isArray(val)) return val as string[];
  return [];
}

function parseJsonObj(val: unknown): Record<string, string> {
  if (!val || val === '{}') return {};
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return {}; }
  }
  return (val as Record<string, string>) ?? {};
}
