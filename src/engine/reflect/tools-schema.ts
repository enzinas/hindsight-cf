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
    description: 'Search user-curated mental models (summaries, frameworks, key concepts). These are the highest-priority knowledge source. Always check these first.',
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
    description: 'Search auto-consolidated observations (synthesized knowledge from multiple facts). These represent higher-level patterns and trends.',
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
    description: 'Search raw memories (ground truth facts). Use this to find specific facts, events, experiences, and opinions. This is the most comprehensive search.',
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
    description: 'Get surrounding context for specific memories. Use this when you need more detail about a memory (e.g., the full document chunk it came from).',
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

export function buildDoneTool(hasDirectives: boolean): ToolDefinition {
  const properties: Record<string, unknown> = {
    answer: {
      type: 'string',
      description: 'Your final answer in markdown format. Be thorough and cite specific facts.',
    },
    memory_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of memories that support your answer',
    },
    mental_model_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of mental models used in your answer',
    },
    observation_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of observations used in your answer',
    },
  };

  if (hasDirectives) {
    properties.directive_compliance = {
      type: 'string',
      description: 'Brief explanation of how your answer complies with the active directives',
    };
  }

  return {
    type: 'function',
    function: {
      name: 'done',
      description: 'Submit your final answer. Call this when you have gathered enough evidence to answer the question comprehensively.',
      parameters: {
        type: 'object',
        properties,
        required: ['answer'],
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
}): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  if (options.hasMentalModels) {
    tools.push(SEARCH_MENTAL_MODELS_TOOL);
  }

  tools.push(SEARCH_OBSERVATIONS_TOOL);
  tools.push(RECALL_TOOL);
  tools.push(EXPAND_TOOL);
  tools.push(buildDoneTool(options.hasDirectives));

  return tools;
}
