/**
 * Type definitions for the recall pipeline.
 *
 * Ported from hindsight-api/engine/search/types.py.
 */

import type { FactType } from '../../types';

/** Raw result from a single retrieval method. */
export interface RetrievalResult {
  id: string;
  text: string;
  factType: FactType;
  context?: string | null;
  occurredStart?: string | null;
  occurredEnd?: string | null;
  mentionedAt?: string | null;
  eventDate?: string | null;
  documentId?: string | null;
  chunkId?: string | null;
  metadata?: Record<string, string>;
  tags?: string[];
  score: number;
  source: 'semantic' | 'fts' | 'graph' | 'temporal';
}

/** Merged candidate after reciprocal rank fusion. */
export interface MergedCandidate {
  result: RetrievalResult;
  rrfScore: number;
  rank: number;
  sourceRanks: Record<string, number>;
}

/** Final scored result after reranking. */
export interface ScoredResult {
  candidate: MergedCandidate;
  rerankerScore: number;
  finalScore: number;
}

/** Entity state for hydration. */
export interface EntityState {
  entityId: string;
  canonicalName: string;
  observations: Array<{ text: string; mentionedAt?: string | null }>;
}

/** Chunk data for inclusion. */
export interface ChunkInfo {
  id: string;
  text: string;
  chunkIndex: number;
  truncated?: boolean;
}

/** Budget levels map to max result counts. */
export const BUDGET_LIMITS: Record<string, number> = {
  low: 10,
  mid: 25,
  high: 100,
};

/** Recall pipeline configuration. */
export interface RecallConfig {
  maxResults: number;
  factTypes?: FactType[];
  tags?: string[];
  tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict';
  includeEntities?: boolean;
  includeChunks?: boolean;
  includeSourceFacts?: boolean;
  entityMaxTokens?: number;
  chunkMaxTokens?: number;
  sourceFactMaxTokens?: number;
  queryTimestamp?: string | null;
  trace?: boolean;
}

/** Trace info for debugging. */
export interface RecallTrace {
  semanticCount: number;
  ftsCount: number;
  graphCount: number;
  temporalCount: number;
  fusedCount: number;
  rerankedCount: number;
  timings: Record<string, number>;
}
