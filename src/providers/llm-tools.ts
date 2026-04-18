/**
 * LLM provider extension for tool-calling (used by reflect pipeline).
 *
 * Supports external OpenAI-compatible APIs and Workers AI native tool calling.
 * All Workers AI models with function_calling support accept the OpenAI tool
 * format and return structured tool_calls.
 */

import type { Env } from '../env';
import { aiRunWithRetry } from './ai-retry';
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

export type ToolChatMessage =
  | ChatMessage
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
  | ToolMessage;

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
  const rawCalls = choice?.message?.tool_calls ?? [];
  return {
    content: choice?.message?.content ?? null,
    toolCalls: rawCalls.length ? normalizeToolCalls(rawCalls as unknown as Record<string, unknown>[]) : [],
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? 'stop',
  };
}

/**
 * Workers AI with native tool calling via OpenAI-compatible format.
 *
 * All Workers AI models with function_calling support accept the OpenAI
 * tool format ({ type: "function", function: { name, description, parameters } })
 * and return structured tool_calls in choices[0].message.tool_calls.
 *
 * Some models (e.g. llama-3.3, mistral-small) return tool_calls at the top
 * level instead. We check both locations.
 *
 * The env.AI.run() binding validates message schemas strictly — messages must
 * have role + content as strings. We sanitize messages to ensure compatibility:
 *  - content: null → content: "" (for assistant messages with tool_calls)
 *  - role: "tool" → role: "user" with structured content
 *  - tool_calls on assistant messages are preserved for multi-turn context
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

  // Sanitize messages for Workers AI binding schema validation
  const sanitizedMessages: Array<{ role: string; content: string }> = messages.map((m) => {
    // Tool result messages → convert to user messages
    if (m.role === 'tool') {
      const tm = m as ToolMessage;
      return { role: 'user' as const, content: `[Tool result for ${tm.tool_call_id}]: ${tm.content}` };
    }
    // Assistant messages with tool_calls — content must be string, not null
    if (m.role === 'assistant' && 'tool_calls' in m) {
      return { role: 'assistant' as const, content: m.content ?? '' };
    }
    // System/user messages — ensure content is string
    return { role: m.role, content: (m as { content?: string | null }).content ?? '' };
  });

  // Some Workers AI models (qwen3, mistral-small) crash on function-specific
  // tool_choice ({ type: "function", function: { name: "..." } }).
  // Instead, we use tool_choice: "required" and inject a user message
  // instructing the model which specific tool to call.
  let resolvedToolChoice: string | undefined;

  if (options?.toolChoice) {
    if (typeof options.toolChoice === 'object') {
      const forcedName = options.toolChoice.function.name;
      sanitizedMessages.push({
        role: 'user',
        content: `You MUST call the "${forcedName}" tool now. Do not call any other tool.`,
      });
      resolvedToolChoice = 'required';
    } else if (options.toolChoice === 'none') {
      resolvedToolChoice = undefined; // omit tool_choice, just don't pass tools
    } else {
      resolvedToolChoice = options.toolChoice;
    }
  }

  const body: Record<string, unknown> = {
    messages: sanitizedMessages,
    tools: options?.toolChoice === 'none' ? undefined : tools,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.1,
  };

  if (resolvedToolChoice) {
    body.tool_choice = resolvedToolChoice;
  }

  const result = await aiRunWithRetry(env, model as Parameters<Ai['run']>[0], body);

  return parseWorkersAIResult(result);
}

/**
 * Parse Workers AI result into a ToolCallResponse.
 *
 * Workers AI models return tool calls in varying shapes:
 *
 * 1. OpenAI-compatible (qwen3, gpt-oss, granite, nemotron, gemma-4, glm, kimi):
 *    { choices: [{ message: { content, tool_calls }, finish_reason }], usage }
 *
 * 2. Legacy/flat (llama-3.3, mistral-small):
 *    { tool_calls: [{ name, arguments }] }
 *    (no choices wrapper, arguments is already an object not a JSON string)
 *
 * 3. Simple text (fallback):
 *    { response: string }
 */
function parseWorkersAIResult(result: unknown): ToolCallResponse {
  const resultObj = result as Record<string, unknown>;
  let content: string | null = null;
  let toolCalls: ToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'stop';

  // Shape 1: OpenAI-compatible with choices[]
  if (Array.isArray(resultObj.choices)) {
    const choice = (resultObj.choices as Array<{
      message?: { content?: string | null; tool_calls?: ToolCall[] };
      finish_reason?: string;
    }>)[0];

    content = choice?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
    finishReason = choice?.finish_reason ?? 'stop';

    if (choice?.message?.tool_calls?.length) {
      toolCalls = normalizeToolCalls(choice.message.tool_calls);
    }

    const usage = resultObj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    inputTokens = usage?.prompt_tokens ?? 0;
    outputTokens = usage?.completion_tokens ?? 0;
  }
  // Shape 2: Legacy flat tool_calls (llama-3.3, mistral-small)
  else if (Array.isArray(resultObj.tool_calls) && (resultObj.tool_calls as unknown[]).length > 0) {
    toolCalls = normalizeToolCalls(resultObj.tool_calls as Record<string, unknown>[]);
    finishReason = 'tool_calls';
  }
  // Shape 3: Simple text response (no tool calling)
  else if (typeof resultObj.response === 'string') {
    content = resultObj.response.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
  }

  return {
    content: toolCalls.length > 0 ? null : content,
    toolCalls,
    inputTokens,
    outputTokens,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
  };
}

/**
 * Normalize a tool name emitted by an LLM into the bare function name.
 *
 * Some models prefix or decorate the name:
 *  - "functions.done" / "tools.done"  (OpenAI-style namespace prefix)
 *  - "call=done" / "name=done"        (k=v style)
 *  - "done()"                          (trailing parens)
 *  - surrounding whitespace or quotes
 */
export function normalizeToolName(name: string): string {
  if (!name) return name;
  let n = name.trim().replace(/^["']|["']$/g, '');
  const eq = n.lastIndexOf('=');
  if (eq !== -1) n = n.slice(eq + 1);
  const dot = n.lastIndexOf('.');
  if (dot !== -1) n = n.slice(dot + 1);
  n = n.replace(/\(\)\s*$/, '');
  return n.trim();
}

/**
 * Normalize tool calls from various Workers AI response shapes into our ToolCall format.
 *
 * Some models return the standard { id, type, function: { name, arguments: string } }.
 * Others return flat { name, arguments: object } without wrapping.
 */
function normalizeToolCalls(raw: unknown[]): ToolCall[] {
  return raw.map((tc) => {
    const obj = tc as Record<string, unknown>;

    // Standard OpenAI shape: { id, type, function: { name, arguments } }
    if (obj.function && typeof obj.function === 'object') {
      const fn = obj.function as Record<string, unknown>;
      return {
        id: (obj.id as string) ?? `call_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function' as const,
        function: {
          name: normalizeToolName(fn.name as string),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      };
    }

    // Flat shape: { name, arguments } (llama-3.3, mistral-small)
    return {
      id: (obj.id as string) ?? `call_${crypto.randomUUID().slice(0, 8)}`,
      type: 'function' as const,
      function: {
        name: normalizeToolName(obj.name as string),
        arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? {}),
      },
    };
  });
}

/**
 * Parse tool calls from Workers AI text response.
 *
 * Qwen3 response patterns (observed via direct API testing):
 *  - Clean:    {"tool_call": {"name": "recall", "arguments": {"query": "..."}}}
 *  - Multi:    {"tool_call": ...}\n\n{"tool_call": ...}  (auto mode emits multiple; we take the first)
 *  - Wrapped:  ```json\n{"tool_call": ...}\n```
 *  - Prefixed: Some prose text\n{"tool_call": ...}
 *
 * The content field from env.AI.run() may include <think>...</think> tags
 * which must be stripped BEFORE calling this function.
 */
export function parseToolCallsFromText(text: string): ToolCall[] {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '');

  // Extract all JSON objects from the text using balanced-brace matching.
  // This handles multiple tool calls, nested arguments, and surrounding prose.
  const jsonObjects = extractJsonObjects(cleaned);

  for (const jsonStr of jsonObjects) {
    try {
      const parsed = JSON.parse(jsonStr) as { tool_call?: { name: string; arguments: Record<string, unknown> } };
      if (parsed.tool_call?.name) {
        // Return only the FIRST valid tool call. In auto mode, Qwen3 may emit
        // multiple (e.g. recall + done), but executing only the first prevents
        // the model from skipping ahead to 'done' with hallucinated memory IDs.
        return [
          {
            id: `call_${crypto.randomUUID().slice(0, 8)}`,
            type: 'function',
            function: {
              name: normalizeToolName(parsed.tool_call.name),
              arguments: JSON.stringify(parsed.tool_call.arguments ?? {}),
            },
          },
        ];
      }
    } catch {
      // Not valid JSON, try next
    }
  }

  return [];
}

/**
 * Extract top-level JSON objects from text using balanced brace matching.
 * Returns the raw JSON strings in order of appearance.
 */
function extractJsonObjects(text: string): string[] {
  const results: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      const start = i;

      for (let j = i; j < text.length; j++) {
        const ch = text[j];

        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;

        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            results.push(text.slice(start, j + 1));
            i = j + 1;
            break;
          }
        }
      }

      // If we never closed, skip past the opening brace
      if (depth !== 0) i = start + 1;
    } else {
      i++;
    }
  }

  return results;
}
