/**
 * Type definitions for the retain pipeline.
 *
 * Ported from hindsight-api/engine/retain/types.py.
 */

import type { FactType } from '../../types';

/** Input content item to be retained as memories. */
export interface RetainContent {
  content: string;
  context: string;
  eventDate: string; // ISO 8601
  metadata: Record<string, string>;
  entities: Array<{ text: string; type?: string }>;
  tags: string[];
}

/** Metadata about a text chunk. */
export interface ChunkMetadata {
  chunkText: string;
  factCount: number;
  contentIndex: number;
  chunkIndex: number;
}

/** Reference to an entity mentioned in a fact. */
export interface EntityRef {
  name: string;
  canonicalName?: string | null;
  entityId?: string | null;
}

/** Causal relationship between facts. */
export interface CausalRelation {
  relationType: string; // "caused_by"
  targetFactIndex: number;
  strength: number;
}

/** Fact extracted from content by the LLM. */
export interface ExtractedFact {
  factText: string;
  factType: FactType;
  entities: string[];
  occurredStart?: string | null;
  occurredEnd?: string | null;
  where?: string | null;
  causalRelations: CausalRelation[];
  contentIndex: number;
  chunkIndex: number;
  context: string;
  mentionedAt: string; // ISO 8601
  metadata: Record<string, string>;
  tags: string[];
}

/** Fact after processing and ready for storage. */
export interface ProcessedFact {
  factText: string;
  factType: FactType;
  embedding: number[];
  occurredStart?: string | null;
  occurredEnd?: string | null;
  mentionedAt: string;
  context: string;
  metadata: Record<string, string>;
  where?: string | null;
  entities: EntityRef[];
  causalRelations: CausalRelation[];
  chunkId?: string | null;
  documentId?: string | null;
  unitId?: string | null;
  contentIndex: number;
  tags: string[];
}

/** Link between two memory units through a shared entity. */
export interface EntityLink {
  fromUnitId: string;
  toUnitId: string;
  entityId: string;
  linkType: string;
  weight: number;
}

/** Token usage tracking. */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Named strategy config — overrides retain pipeline defaults per-request.
 *
 * Strategies are stored in bank config under the `strategies` key and
 * referenced by name in file retain requests. They control how text is
 * chunked, what the extraction focus is, and how aggressively facts are
 * extracted.
 *
 * Matches upstream hindsight's strategy system where strategies are named
 * config overrides stored in bank config.
 */
export interface StrategyConfig {
  /** Override chunk size in characters (default: 4000). */
  chunk_size?: number;
  /** Override extraction mode: "concise" (default) or "verbatim" for denser extraction. */
  extraction_mode?: 'concise' | 'verbatim';
  /** Override the bank mission for this extraction. */
  retain_mission?: string;
  /** Additional instructions appended to the extraction prompt. */
  custom_instructions?: string;
  /** Whether to extract causal links between facts. */
  extract_causal_links?: boolean;
}

/** Result of a retain operation. */
export interface RetainResult {
  unitIdsByContent: string[][];
  usage: LLMUsage;
}
