/**
 * Reciprocal Rank Fusion (RRF) for merging multi-source results.
 *
 * Ported from hindsight-api/engine/search/fusion.py.
 */

import type { RetrievalResult, MergedCandidate } from './types';

/**
 * Merge ranked results from multiple retrieval sources using RRF.
 *
 * RRF formula: score(d) = sum over all lists of 1 / (k + rank(d))
 *
 * This is a proven method for combining results from different
 * retrieval methods without needing score calibration.
 *
 * @param k - RRF constant (default 60). Higher k gives less weight to top ranks.
 */
export function reciprocalRankFusion(
  ...resultLists: RetrievalResult[][]
): MergedCandidate[] {
  const k = 60;
  const scores = new Map<string, number>();
  const sourceRanks = new Map<string, Record<string, number>>();
  const bestResult = new Map<string, RetrievalResult>();

  for (const results of resultLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      const id = result.id;

      // RRF score contribution from this list
      const contribution = 1 / (k + rank + 1); // rank is 0-indexed, RRF uses 1-indexed
      scores.set(id, (scores.get(id) ?? 0) + contribution);

      // Track rank per source
      if (!sourceRanks.has(id)) sourceRanks.set(id, {});
      const ranks = sourceRanks.get(id)!;
      if (!(result.source in ranks)) {
        ranks[result.source] = rank + 1; // 1-indexed for display
      }

      // Keep first occurrence (highest ranked) as the representative
      if (!bestResult.has(id)) {
        bestResult.set(id, result);
      }
    }
  }

  // Build merged candidates sorted by RRF score
  const candidates: MergedCandidate[] = [];
  for (const [id, score] of scores) {
    candidates.push({
      result: bestResult.get(id)!,
      rrfScore: score,
      rank: 0, // Will be assigned below
      sourceRanks: sourceRanks.get(id) ?? {},
    });
  }

  // Sort by RRF score descending
  candidates.sort((a, b) => b.rrfScore - a.rrfScore);

  // Assign final ranks
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].rank = i + 1;
  }

  return candidates;
}
