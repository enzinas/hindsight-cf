/**
 * OpenAI-format tool definitions for the reflect agent.
 *
 * Ported from hindsight-api/engine/reflect/tools_schema.py.
 * These 5 tools form the reflect agent's toolkit.
 */

import type { ToolDefinition } from '../../providers/llm-tools';

export const SEARCH_MENTAL_MODELS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_mental_models',
    description:
      'Search user-curated mental models (summaries, frameworks, key concepts). These are the highest-priority knowledge source. Always check these first.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant mental models',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  },
};

export const SEARCH_OBSERVATIONS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_observations',
    description:
      'Search auto-consolidated observations (synthesized knowledge from multiple facts). These represent higher-level patterns and trends.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant observations',
        },
        max_tokens: {
          type: 'number',
          description: 'Maximum tokens in results (default: 2000)',
        },
      },
      required: ['query'],
    },
  },
};

export const RECALL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'recall',
    description:
      'Search raw memories (ground truth facts). Use this to find specific facts, events, experiences, and opinions. This is the most comprehensive search.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant memories',
        },
        max_tokens: {
          type: 'number',
          description: 'Maximum tokens in results (default: 4000)',
        },
      },
      required: ['query'],
    },
  },
};

export const EXPAND_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'expand',
    description:
      'Get surrounding context for specific memories. Use this when you need more detail about a memory (e.g., the full document chunk it came from).',
    parameters: {
      type: 'object',
      properties: {
        memory_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of memories to expand',
        },
      },
      required: ['memory_ids'],
    },
  },
};

export function buildDoneTool(hasDirectives: boolean, directiveRules?: string[]): ToolDefinition {
  const answerDesc = hasDirectives && directiveRules?.length
    ? `Your response as well-formatted markdown. Use headers, lists, bold/italic, and code blocks for clarity. NEVER include memory IDs, UUIDs, or 'Memory references' in this text - put IDs only in memory_ids array. Write in the SAME language as the user's question. MANDATORY: Your answer MUST comply with ALL directives:\n${directiveRules.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}`
    : 'Your response as well-formatted markdown. Use headers, lists, bold/italic, and code blocks for clarity. NEVER include memory IDs, UUIDs, or \'Memory references\' in this text - put IDs only in memory_ids array. Write in the SAME language as the user\'s question.';

  const properties: Record<string, unknown> = {
    answer: {
      type: 'string',
      description: answerDesc,
    },
    memory_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Copy the "id" values from recall results here. Example: ["abc-123", "def-456"]. Put IDs here, NOT in answer text.',
    },
    mental_model_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Copy the "id" values from search_mental_models results here.',
    },
    observation_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Copy the "id" values from search_observations results here.',
    },
  };

  const required: string[] = ['answer'];

  if (hasDirectives) {
    properties.directive_compliance = {
      type: 'string',
      description: `REQUIRED: Confirm your answer complies with ALL directives. Format: 'Directive 1: [how answer complies]. Directive 2: [how answer complies]...'`,
    };
    required.push('directive_compliance');
  }

  return {
    type: 'function',
    function: {
      name: 'done',
      description: hasDirectives
        ? 'Signal completion with your final answer. IMPORTANT: You must confirm directive compliance before submitting. Your answer will be REJECTED if it violates any directive.'
        : 'Signal completion with your final answer. Use this when you have gathered enough information to answer the question.',
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

/**
 * Get all tools for the reflect agent.
 */
export function getReflectTools(options: {
  hasMentalModels: boolean;
  hasDirectives: boolean;
  directiveRules?: string[];
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (options.hasMentalModels) {
    tools.push(SEARCH_MENTAL_MODELS_TOOL);
  }

  tools.push(SEARCH_OBSERVATIONS_TOOL);
  tools.push(RECALL_TOOL);
  tools.push(EXPAND_TOOL);
  tools.push(buildDoneTool(options.hasDirectives, options.directiveRules));

  return tools;
}
