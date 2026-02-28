/**
 * Full-text search via D1 FTS5.
 *
 * Replaces PostgreSQL tsvector/tsquery with SQLite FTS5.
 */

import type { Env } from '../../env';
import type { RetrievalResult } from './types';
import type { FactType } from '../../types';

/**
 * Search memories using FTS5 full-text search.
 *
 * FTS5 rank function returns a negative relevance score
 * (more negative = more relevant), so we negate it.
 */
export async function ftsSearch(
  env: Env,
  bankId: string,
  query: string,
  options?: {
    limit?: number;
    factTypes?: FactType[];
    tags?: string[];
  },
): Promise<RetrievalResult[]> {
  const limit = options?.limit ?? 50;

  // Sanitize query for FTS5: escape special chars, convert to OR terms
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // FTS5 query joining memory_units for metadata
  // The content= sync'd FTS table shares rowid with memory_units
  const rows = await env.DB.prepare(
    `SELECT m.id, m.text, m.fact_type, m.context,
            m.occurred_start, m.occurred_end, m.mentioned_at,
            m.event_date, m.document_id, m.chunk_id,
            m.metadata, m.tags,
            rank AS fts_rank
     FROM memory_units_fts fts
     JOIN memory_units m ON m.rowid = fts.rowid
     WHERE memory_units_fts MATCH ?
       AND m.bank_id = ?
     ORDER BY rank
     LIMIT ?`,
  )
    .bind(ftsQuery, bankId, limit)
    .all();

  const results: RetrievalResult[] = [];
  for (const row of rows.results as Array<Record<string, unknown>>) {
    const factType = row.fact_type as FactType;

    if (options?.factTypes?.length && !options.factTypes.includes(factType)) {
      continue;
    }

    if (options?.tags?.length) {
      const rowTags = parseJsonArray(row.tags);
      if (!matchesTags(rowTags, options.tags, 'any')) continue;
    }

    // FTS5 rank is negative (more negative = more relevant)
    // Normalize to [0, 1] range: use 1/(1 + abs(rank))
    const rawRank = row.fts_rank as number;
    const normalizedScore = 1 / (1 + Math.abs(rawRank));

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
      score: normalizedScore,
      source: 'fts',
    });
  }

  return results;
}

/**
 * Sanitize a query string for FTS5.
 *
 * Converts natural language query to FTS5 OR query.
 * Removes special characters that would break FTS5 syntax.
 */
function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 operators and special chars
  const cleaned = query
    .replace(/[*"(){}[\]^~\\:]/g, '')
    .replace(/\bAND\b/gi, '')
    .replace(/\bOR\b/gi, '')
    .replace(/\bNOT\b/gi, '')
    .trim();

  if (!cleaned) return '';

  // Split into words and join with OR for broad matching
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return '';

  return words.join(' OR ');
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

function matchesTags(rowTags: string[], filterTags: string[], mode: string): boolean {
  if (!filterTags.length) return true;
  if (!rowTags.length) return mode === 'any' || mode === 'all';
  if (mode === 'any' || mode === 'any_strict') {
    return filterTags.some((t) => rowTags.includes(t));
  }
  return filterTags.every((t) => rowTags.includes(t));
}
