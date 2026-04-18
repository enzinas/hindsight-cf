/**
 * Type definitions for the reflect pipeline.
 *
 * Ported from hindsight-api/engine/reflect/types.py.
 */

import type { TagGroup } from '../../types';

export interface ReflectConfig {
  query: string;
  bankId: string;
  budget: 'low' | 'mid' | 'high';
  context?: string | null;
  maxTokens?: number;
  responseSchema?: Record<string, unknown> | null;
  tags?: string[] | null;
  tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict';
  tagGroups?: TagGroup[] | null;
  includeFacts?: boolean;
  includeToolCalls?: boolean;
  includeToolOutput?: boolean;
  maxContextTokens?: number;
  wallTimeoutMs?: number;
  /** Override the LLM used for tool-calling during reflect. Defaults to env.DEFAULT_LLM_MODEL. */
  model?: string;
}

export const DEFAULT_REFLECT_MAX_CONTEXT_TOKENS = 100_000;
export const DEFAULT_REFLECT_WALL_TIMEOUT_MS = 300_000;

export interface ReflectToolTrace {
  tool: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  duration_ms: number;
  iteration: number;
}

export interface ReflectLLMTrace {
  scope: string;
  duration_ms: number;
}

export interface ReflectTrace {
  tool_calls: ReflectToolTrace[];
  llm_calls: ReflectLLMTrace[];
}

export interface BasedOn {
  memories: Array<{
    id: string;
    text: string;
    type?: string | null;
    context?: string | null;
    occurred_start?: string | null;
    occurred_end?: string | null;
  }>;
  mental_models: Array<{
    id: string;
    text: string;
    context?: string | null;
  }>;
  directives: Array<{
    id: string;
    name: string;
    content: string;
  }>;
}

export interface ReflectResult {
  text: string;
  basedOn: BasedOn | null;
  structuredOutput: Record<string, unknown> | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  trace: ReflectTrace | null;
}

/** Budget to max iterations mapping. */
export const BUDGET_ITERATIONS: Record<string, number> = {
  low: 4,
  mid: 7,
  high: 10,
};
