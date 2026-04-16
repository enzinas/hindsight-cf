/**
 * Graph-based retrieval via BFS spreading activation.
 *
 * Traverses entity, temporal, and causal links from seed memories
 * to discover related memories not found by vector/FTS search.
 *
 * Ported from hindsight-api/engine/search/graph_retrieval.py.
 */

import type { Env } from '../../env';
import type { RetrievalResult } from './types';
import type { FactType, TagGroup } from '../../types';
import { filterByTags } from '../tag-filter';

// Causal link types get a boost
const LINK_BOOSTS: Record<string, number> = {
  causes: 2.0,
  caused_by: 2.0,
  enables: 1.5,
  prevents: 1.5,
  entity: 1.0,
  temporal: 1.0,
  semantic: 1.0,
};

/**
 * BFS spreading activation from seed results.
 *
 * Starting from memory IDs found by vector/FTS search,
 * traverses the memory graph to find related memories.
 */
export async function graphRetrieval(
  env: Env,
  bankId: string,
  seedIds: string[],
  options?: {
    maxHops?: number;
    maxResults?: number;
    minActivation?: number;
    factTypes?: FactType[];
    tags?: string[];
    tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict';
    tagGroups?: TagGroup[];
    decayRate?: number;
  },
): Promise<RetrievalResult[]> {
  if (!seedIds.length) return [];

  const maxHops = options?.maxHops ?? 2;
  const maxResults = options?.maxResults ?? 30;
  const minActivation = options?.minActivation ?? 0.1;
  const decayRate = options?.decayRate ?? 0.5;

  // Track activation scores
  const activation = new Map<string, number>();
  const visited = new Set<string>();

  // Initialize seeds with activation 1.0
  for (const id of seedIds) {
    activation.set(id, 1.0);
  }

  // BFS hop by hop
  let frontier = [...seedIds];

  for (let hop = 0; hop < maxHops; hop++) {
    if (!frontier.length) break;

    // Get all links FROM frontier nodes
    const placeholders = frontier.map(() => '?').join(',');
    const linksResult = await env.DB.prepare(
      `SELECT from_unit_id, to_unit_id, link_type, weight
       FROM memory_links
       WHERE from_unit_id IN (${placeholders})`,
    )
      .bind(...frontier)
      .all();

    const nextFrontier: string[] = [];

    for (const link of linksResult.results as Array<Record<string, unknown>>) {
      const fromId = link.from_unit_id as string;
      const toId = link.to_unit_id as string;
      const linkType = link.link_type as string;
      const weight = link.weight as number;

      if (visited.has(toId)) continue;

      const boost = LINK_BOOSTS[linkType] ?? 1.0;
      const parentActivation = activation.get(fromId) ?? 0;
      const newActivation = parentActivation * weight * boost * decayRate;

      if (newActivation < minActivation) continue;

      const existing = activation.get(toId) ?? 0;
      if (newActivation > existing) {
        activation.set(toId, newActivation);
      }

      if (!visited.has(toId)) {
        nextFrontier.push(toId);
      }
    }

    // Mark current frontier as visited
    for (const id of frontier) {
      visited.add(id);
    }

    frontier = [...new Set(nextFrontier)];
  }

  // Remove seed IDs from results (they're already in the result set)
  const seedSet = new Set(seedIds);
  const candidateIds = [...activation.keys()].filter(
    (id) => !seedSet.has(id) && (activation.get(id) ?? 0) >= minActivation,
  );

  if (!candidateIds.length) return [];

  // Sort by activation and take top results
  candidateIds.sort((a, b) => (activation.get(b) ?? 0) - (activation.get(a) ?? 0));
  const topIds = candidateIds.slice(0, maxResults);

  // Hydrate from D1
  const idPlaceholders = topIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, text, fact_type, context, occurred_start, occurred_end,
            mentioned_at, event_date, document_id, chunk_id, metadata, tags
     FROM memory_units
     WHERE id IN (${idPlaceholders}) AND bank_id = ?`,
  )
    .bind(...topIds, bankId)
    .all();

  const results: RetrievalResult[] = [];
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const id = row.id as string;
    const factType = row.fact_type as FactType;

    if (options?.factTypes?.length && !options.factTypes.includes(factType)) {
      continue;
    }

    if (options?.tags?.length || options?.tagGroups?.length) {
      const rowTags = parseJsonArray(row.tags);
      if (!filterByTags(rowTags, { tags: options?.tags, tagsMatch: options?.tagsMatch, tagGroups: options?.tagGroups })) continue;
    }

    results.push({
      id,
      text: row.text as string,
      factType,
      context: row.context as string | null,
      occurredStart: row.occurred_start as string | null,
      occurredEnd: row.occurred_end as string | null,
      mentionedAt: row.mentioned_at as string | null,
      eventDate: row.event_date as string | null,
      documentId: row.document_id as string | null,
      chunkId: row.chunk_id as string | null,
      metadata: parseJsonObj(row.metadata),
      tags: parseJsonArray(row.tags),
      score: activation.get(id) ?? 0,
      source: 'graph',
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Temporal retrieval: find memories close in time to the query timestamp.
 *
 * Also propagates through causal links with boosted weights.
 */
export async function temporalRetrieval(
  env: Env,
  bankId: string,
  queryTimestamp: string,
  options?: {
    windowHours?: number;
    limit?: number;
    factTypes?: FactType[];
    tags?: string[];
    tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict';
    tagGroups?: TagGroup[];
  },
): Promise<RetrievalResult[]> {
  const windowHours = options?.windowHours ?? 168; // 1 week default
  const limit = options?.limit ?? 30;

  const queryTime = new Date(queryTimestamp).getTime();
  const minDate = new Date(queryTime - windowHours * 3600000).toISOString();
  const maxDate = new Date(queryTime + windowHours * 3600000).toISOString();

  const rows = await env.DB.prepare(
    `SELECT id, text, fact_type, context, occurred_start, occurred_end,
            mentioned_at, event_date, document_id, chunk_id, metadata, tags
     FROM memory_units
     WHERE bank_id = ?
       AND event_date BETWEEN ? AND ?
     ORDER BY ABS(julianday(event_date) - julianday(?))
     LIMIT ?`,
  )
    .bind(bankId, minDate, maxDate, queryTimestamp, limit)
    .all();

  const results: RetrievalResult[] = [];
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const factType = row.fact_type as FactType;

    if (options?.factTypes?.length && !options.factTypes.includes(factType)) {
      continue;
    }

    if (options?.tags?.length || options?.tagGroups?.length) {
      const rowTags = parseJsonArray(row.tags);
      if (!filterByTags(rowTags, { tags: options?.tags, tagsMatch: options?.tagsMatch, tagGroups: options?.tagGroups })) continue;
    }

    // Score based on temporal proximity
    const eventTime = new Date(row.event_date as string).getTime();
    const hoursDiff = Math.abs(queryTime - eventTime) / 3600000;
    const score = Math.max(0.1, 1.0 - hoursDiff / windowHours);

    results.push({
      id: row.id as string,
      text: row.text as string,
      factType,
      context: row.context as string | null,
      occurredStart: row.occurred_start as string | null,
      occurredEnd: row.occurred_end as string | null,
      mentionedAt: row.mentioned_at as string | null,
      eventDate: row.event_date as string | null,
      documentId: row.document_id as string | null,
      chunkId: row.chunk_id as string | null,
      metadata: parseJsonObj(row.metadata),
      tags: parseJsonArray(row.tags),
      score,
      source: 'temporal',
    });
  }

  return results;
}

function parseJsonArray(val: unknown): string[] {
  if (!val || val === '[]') return [];
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  if (Array.isArray(val)) return val as string[];
  return [];
}

function parseJsonObj(val: unknown): Record<string, string> {
  if (!val || val === '{}') return {};
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return {};
    }
  }
  return (val as Record<string, string>) ?? {};
}

