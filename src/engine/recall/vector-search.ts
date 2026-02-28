/**
 * Vector similarity search via Cloudflare Vectorize.
 *
 * Ported from the semantic retrieval path in hindsight-api.
 */

import type { Env } from '../../env';
import { generateEmbedding } from '../../providers/embeddings';
import type { RetrievalResult } from './types';
import type { FactType } from '../../types';

/**
 * Search for similar memories using vector similarity.
 *
 * 1. Generate query embedding
 * 2. Query Vectorize with metadata filters
 * 3. Hydrate results from D1
 */
export async function vectorSearch(
  env: Env,
  bankId: string,
  query: string,
  options?: {
    topK?: number;
    factTypes?: FactType[];
    tags?: string[];
  },
): Promise<RetrievalResult[]> {
  const topK = options?.topK ?? 50;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(env, query);

  // Query Vectorize
  const filter = { bank_id: bankId } as VectorizeVectorMetadataFilter;
  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK,
    filter,
  });

  if (!vectorResults.matches.length) return [];

  // Hydrate from D1
  const ids = vectorResults.matches.map((m) => m.id);
  const scoreMap = new Map(vectorResults.matches.map((m) => [m.id, m.score ?? 0]));

  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, text, fact_type, context, occurred_start, occurred_end,
            mentioned_at, event_date, document_id, chunk_id, metadata, tags
     FROM memory_units
     WHERE id IN (${placeholders}) AND bank_id = ?`,
  )
    .bind(...ids, bankId)
    .all();

  const results: RetrievalResult[] = [];
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const id = row.id as string;
    const factType = row.fact_type as FactType;

    // Filter by fact types if specified
    if (options?.factTypes?.length && !options.factTypes.includes(factType)) {
      continue;
    }

    // Filter by tags
    if (options?.tags?.length) {
      const rowTags: string[] = parseJsonArray(row.tags);
      if (!matchesTags(rowTags, options.tags, 'any')) continue;
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
      score: scoreMap.get(id) ?? 0,
      source: 'semantic',
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
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

function matchesTags(rowTags: string[], filterTags: string[], mode: string): boolean {
  if (!filterTags.length) return true;
  if (!rowTags.length) return mode === 'any' || mode === 'all'; // non-strict includes untagged
  if (mode === 'any' || mode === 'any_strict') {
    return filterTags.some((t) => rowTags.includes(t));
  }
  // all / all_strict
  return filterTags.every((t) => rowTags.includes(t));
}
