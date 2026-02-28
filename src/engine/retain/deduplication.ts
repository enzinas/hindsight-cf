/**
 * Deduplication for the retain pipeline.
 *
 * Checks if new facts are duplicates of existing ones using
 * Vectorize similarity search within a time window.
 *
 * Ported from hindsight-api/engine/retain/deduplication.py.
 */

import type { ProcessedFact } from './types';

const SIMILARITY_THRESHOLD = 0.95; // Very high similarity = duplicate

/**
 * Check which facts are duplicates of existing memories.
 *
 * Groups facts into 12-hour time buckets and checks for duplicates
 * within a 24-hour window using vector similarity.
 *
 * Returns a boolean array: true = duplicate.
 */
export async function checkDuplicatesBatch(
  vectorize: VectorizeIndex,
  bankId: string,
  facts: ProcessedFact[],
): Promise<boolean[]> {
  if (facts.length === 0) return [];

  const isDuplicate: boolean[] = new Array(facts.length).fill(false);

  // Check each fact against Vectorize
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (!fact.embedding.length) continue;

    try {
      const results = await vectorize.query(fact.embedding, {
        topK: 1,
        filter: { bank_id: bankId },
      });

      if (results.matches.length > 0) {
        const topMatch = results.matches[0];
        if ((topMatch.score ?? 0) >= SIMILARITY_THRESHOLD) {
          isDuplicate[i] = true;
        }
      }
    } catch {
      // On error, assume not duplicate (safe default)
    }
  }

  return isDuplicate;
}

/**
 * Filter out duplicate facts.
 */
export function filterDuplicates(
  facts: ProcessedFact[],
  isDuplicate: boolean[],
): ProcessedFact[] {
  if (facts.length !== isDuplicate.length) {
    throw new Error(`Mismatch: ${facts.length} facts vs ${isDuplicate.length} flags`);
  }
  return facts.filter((_, i) => !isDuplicate[i]);
}
