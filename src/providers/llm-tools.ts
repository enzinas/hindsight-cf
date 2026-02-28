/**
 * LLM provider extension for tool-calling (used by reflect pipeline).
 *
 * Supports external OpenAI-compatible APIs with tool_choice control.
 * Falls back to Workers AI with manual tool parsing.
 */

import type { Env } from '../env';
import type { ChatMessage } from './llm';

// =============================================================================
// Types
// =============================================================================

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ToolChatMessage = ChatMessage | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] } | ToolMessage;

export interface ToolCallResponse {
  content: string | null;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

// =============================================================================
// Tool-calling LLM
// =============================================================================

/**
 * Call LLM with tools. Uses external OpenAI-compatible API if configured,
 * otherwise falls back to Workers AI with manual tool-call parsing.
 */
export async function llmChatWithTools(
  env: Env,
  messages: ToolChatMessage[],
  tools: ToolDefinition[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  },
): Promise<ToolCallResponse> {
  if (env.EXTERNAL_LLM_BASE_URL && env.OPENAI_API_KEY) {
    return callExternalLLMWithTools(env, messages, tools, options);
  }
  return callWorkersAIWithTools(env, messages, tools, options);
}

/**
 * External OpenAI-compatible API with native tool support.
 */
async function callExternalLLMWithTools(
  env: Env,
  messages: ToolChatMessage[],
  tools: ToolDefinition[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  },
): Promise<ToolCallResponse> {
  const baseUrl = env.EXTERNAL_LLM_BASE_URL!.replace(/\/$/, '');
  const model = env.EXTERNAL_LLM_MODEL ?? 'gpt-4o-mini';

  const body: Record<string, unknown> = {
    model,
    messages,
    tools,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.1,
  };

  if (options?.toolChoice) {
    body.tool_choice = options.toolChoice;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`External LLM API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: ToolCall[];
      };
      finish_reason: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const choice = json.choices[0];
  return {
    content: choice?.message?.content ?? null,
    toolCalls: choice?.message?.tool_calls ?? [],
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? 'stop',
  };
}

/**
 * Workers AI fallback: simulate tool calling via structured prompting.
 *
 * We append tool descriptions to the system prompt and parse the LLM's
 * text output for tool call JSON.
 */
async function callWorkersAIWithTools(
  env: Env,
  messages: ToolChatMessage[],
  tools: ToolDefinition[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  },
): Promise<ToolCallResponse> {
  const model = env.DEFAULT_LLM_MODEL;

  // Build tool descriptions for the prompt
  const toolDescriptions = tools.map((t) => {
    const params = JSON.stringify(t.function.parameters, null, 2);
    return `Tool: ${t.function.name}\nDescription: ${t.function.description}\nParameters: ${params}`;
  }).join('\n\n');

  let toolInstruction = `\n\nYou have access to the following tools:\n\n${toolDescriptions}\n\n`;

  if (options?.toolChoice && typeof options.toolChoice === 'object') {
    toolInstruction += `You MUST call the tool "${options.toolChoice.function.name}" now. `;
  } else if (options?.toolChoice === 'none') {
    toolInstruction += `Do NOT call any tools. Respond directly with text. `;
  }

  toolInstruction += `To call a tool, respond with ONLY a JSON object in this format:
{"tool_call": {"name": "tool_name", "arguments": {...}}}

If you want to respond with text instead of calling a tool, just respond normally without the JSON format.`;

  // Inject tool descriptions into system message
  const augmentedMessages = messages.map((m, i) => {
    if (i === 0 && m.role === 'system') {
      return { role: m.role, content: m.content + toolInstruction };
    }
    // Convert tool messages to user messages for Workers AI
    if (m.role === 'tool') {
      return { role: 'user' as const, content: `Tool result for ${(m as ToolMessage).tool_call_id}: ${m.content}` };
    }
    // Convert assistant messages with tool_calls
    if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls) {
      const callsStr = m.tool_calls.map((tc: ToolCall) =>
        `Called ${tc.function.name}(${tc.function.arguments})`
      ).join('\n');
      return { role: 'assistant' as const, content: callsStr };
    }
    return { role: m.role, content: m.content ?? '' };
  });

  const result = await env.AI.run(model as Parameters<Ai['run']>[0], {
    messages: augmentedMessages,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.1,
  });

  const response = (result as { response?: string }).response ?? '';

  // Try to parse tool call from response
  const toolCalls = parseToolCallsFromText(response);

  return {
    content: toolCalls.length > 0 ? null : response,
    toolCalls,
    inputTokens: 0,
    outputTokens: 0,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

/**
 * Parse tool calls from Workers AI text response.
 */
function parseToolCallsFromText(text: string): ToolCall[] {
  // Try to find {"tool_call": {...}} pattern
  const patterns = [
    /\{"tool_call"\s*:\s*\{[\s\S]*?\}\s*\}/,
    /```(?:json)?\s*\n?\{"tool_call"[\s\S]*?\}\s*\n?```/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        // Clean markdown if present
        let jsonStr = match[0].replace(/```(?:json)?\s*\n?/, '').replace(/\n?\s*```/, '');
        const parsed = JSON.parse(jsonStr) as { tool_call: { name: string; arguments: Record<string, unknown> } };
        if (parsed.tool_call?.name) {
          return [{
            id: `call_${crypto.randomUUID().slice(0, 8)}`,
            type: 'function',
            function: {
              name: parsed.tool_call.name,
              arguments: JSON.stringify(parsed.tool_call.arguments ?? {}),
            },
          }];
        }
      } catch {
        // Continue trying other patterns
      }
    }
  }

  return [];
}
