/**
 * Cross-encoder reranking via Workers AI.
 *
 * Uses @cf/baai/bge-reranker-base to rerank candidates.
 * Falls back to RRF scores if reranking fails.
 *
 * Ported from hindsight-api/engine/search/reranking.py.
 */

import type { Env } from '../../env';
import type { MergedCandidate, ScoredResult } from './types';

/**
 * Rerank merged candidates using a cross-encoder model.
 *
 * Enriches document text with temporal context before scoring.
 */
export async function rerankCandidates(
  env: Env,
  query: string,
  candidates: MergedCandidate[],
  maxResults?: number,
): Promise<ScoredResult[]> {
  if (!candidates.length) return [];

  const limit = maxResults ?? candidates.length;

  // Build enriched document texts for reranking
  const documents = candidates.map((c) => {
    let text = c.result.text;

    // Prepend temporal context (helps reranker understand relevance)
    if (c.result.eventDate) {
      try {
        const date = new Date(c.result.eventDate);
        const formatted = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        text = `[${formatted}] ${text}`;
      } catch {
        // Skip date formatting
      }
    }

    // Add context if available
    if (c.result.context) {
      text = `${text} (context: ${c.result.context})`;
    }

    return text;
  });

  try {
    // Call Workers AI reranker
    const model = env.DEFAULT_RERANKER_MODEL;
    const result = await env.AI.run(model as Parameters<Ai['run']>[0], {
      query,
      documents,
    });

    // Workers AI reranker returns { data: [{ index, score }] }
    const rerankerData = result as {
      data?: Array<{ index: number; score: number }>;
    };

    if (rerankerData.data?.length) {
      // Apply sigmoid normalization to raw scores
      const scored: ScoredResult[] = rerankerData.data.map((item) => {
        const candidate = candidates[item.index];
        const normalizedScore = sigmoid(item.score);
        return {
          candidate,
          rerankerScore: normalizedScore,
          finalScore: normalizedScore,
        };
      });

      // Sort by reranker score
      scored.sort((a, b) => b.finalScore - a.finalScore);
      return scored.slice(0, limit);
    }
  } catch (err) {
    console.error('[recall] Reranking failed, falling back to RRF scores:', err);
  }

  // Fallback: use RRF scores
  return candidates
    .slice(0, limit)
    .map((c) => ({
      candidate: c,
      rerankerScore: c.rrfScore,
      finalScore: c.rrfScore,
    }));
}

/** Sigmoid activation for score normalization. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
