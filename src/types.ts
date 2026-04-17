/**
 * Shared type definitions for hindsight-cf.
 * Ported from hindsight-api Pydantic models.
 */

// =============================================================================
// Enums
// =============================================================================

export type FactType = 'world' | 'experience' | 'opinion' | 'observation' | 'mental_model';
export type LinkType = 'temporal' | 'semantic' | 'entity' | 'causes' | 'caused_by' | 'enables' | 'prevents';
export type OperationStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type Budget = 'low' | 'mid' | 'high';
export type TagsMatch = 'any' | 'all' | 'any_strict' | 'all_strict';

/** Recursive boolean tag filter — matches upstream hindsight TagGroup. */
export type TagGroup =
  | { tags: string[]; match?: TagsMatch }
  | { and: TagGroup[] }
  | { or: TagGroup[] }
  | { not: TagGroup };

// =============================================================================
// Request Models
// =============================================================================

export interface RetainItem {
  content: string;
  timestamp?: string | null;
  context?: string | null;
  metadata?: Record<string, string> | null;
  document_id?: string | null;
  entities?: Array<{ text: string; type?: string | null }> | null;
  tags?: string[] | null;
}

export interface RetainRequest {
  items: RetainItem[];
  async?: boolean;
  document_tags?: string[] | null;
}

export interface RecallRequest {
  query: string;
  types?: string[] | null;
  budget?: Budget;
  max_tokens?: number;
  trace?: boolean;
  query_timestamp?: string | null;
  include?: {
    entities?: { max_tokens?: number } | null;
    chunks?: { max_tokens?: number } | null;
    source_facts?: { max_tokens?: number } | null;
  };
  tags?: string[] | null;
  tags_match?: TagsMatch;
  tag_groups?: TagGroup[] | null;
}

export interface ReflectRequest {
  query: string;
  budget?: Budget;
  context?: string | null;
  max_tokens?: number;
  include?: {
    facts?: Record<string, never> | null;
    tool_calls?: { output?: boolean } | null;
  };
  response_schema?: Record<string, unknown> | null;
  tags?: string[] | null;
  tags_match?: TagsMatch;
  tag_groups?: TagGroup[] | null;
}

// =============================================================================
// Response Models
// =============================================================================

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RetainResponse {
  success: boolean;
  bank_id: string;
  items_count: number;
  async: boolean;
  operation_id?: string | null;
  usage?: TokenUsage | null;
}

export interface RecallResult {
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

export interface EntityStateResponse {
  entity_id: string;
  canonical_name: string;
  observations: Array<{ text: string; mentioned_at?: string | null }>;
}

export interface ChunkData {
  id: string;
  text: string;
  chunk_index: number;
  truncated?: boolean;
}

export interface RecallResponse {
  results: RecallResult[];
  trace?: Record<string, unknown> | null;
  entities?: Record<string, EntityStateResponse> | null;
  chunks?: Record<string, ChunkData> | null;
  source_facts?: Record<string, RecallResult> | null;
}

export interface ReflectFact {
  id?: string | null;
  text: string;
  type?: string | null;
  context?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
}

export interface ReflectResponse {
  text: string;
  based_on?: {
    memories: ReflectFact[];
    mental_models: Array<{ id: string; text: string; context?: string | null }>;
    directives: Array<{ id: string; name: string; content: string }>;
  } | null;
  structured_output?: Record<string, unknown> | null;
  usage?: TokenUsage | null;
  trace?: {
    tool_calls: Array<{
      tool: string;
      input: Record<string, unknown>;
      output?: Record<string, unknown> | null;
      duration_ms: number;
      iteration: number;
    }>;
    llm_calls: Array<{ scope: string; duration_ms: number }>;
  } | null;
}

export interface DispositionTraits {
  skepticism: number;
  literalism: number;
  empathy: number;
}

export interface BankProfileResponse {
  bank_id: string;
  name: string;
  disposition: DispositionTraits;
  mission: string;
  background?: string | null;
}

export interface DirectiveResponse {
  id: string;
  bank_id: string;
  name: string;
  content: string;
  priority: number;
  is_active: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** Per-file metadata for file retain requests. */
export interface FileMetadata {
  document_id?: string | null;
  context?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[] | null;
  timestamp?: string | null;
  parser?: string | null;
  strategy?: string | null;
}

/** Response from POST /files/retain. */
export interface FileRetainResponse {
  operation_ids: string[];
}

export interface OperationResponse {
  operation_id: string;
  bank_id: string;
  operation_type: string;
  status: OperationStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  error_message?: string | null;
  result_metadata: Record<string, unknown>;
}
