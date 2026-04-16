/**
 * LLM provider abstraction for Workers AI and external APIs.
 *
 * Supports Workers AI (default) and external OpenAI-compatible APIs.
 */

import type { Env } from '../env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMJsonResponse<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call an LLM with messages and return a text response.
 */
export async function llmChat(
  env: Env,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<LLMResponse> {
  // If external LLM is configured, use it
  if (env.EXTERNAL_LLM_BASE_URL && env.OPENAI_API_KEY) {
    return callExternalLLM(env, messages, options);
  }

  // Default: Workers AI
  return callWorkersAI(env, messages, options);
}

/**
 * Call an LLM and parse JSON from the response.
 */
export async function llmChatJson<T>(
  env: Env,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<LLMJsonResponse<T>> {
  const response = await llmChat(env, messages, options);
  const data = parseJsonResponse<T>(response.content);
  return {
    data,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

async function callWorkersAI(
  env: Env,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<LLMResponse> {
  const model = env.DEFAULT_LLM_MODEL;

  const result = await env.AI.run(model as Parameters<Ai['run']>[0], {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.1,
  });

  // Workers AI models return one of two formats:
  // 1. Simple: { response: string } (older models like Llama)
  // 2. OpenAI-compatible: { choices: [{ message: { content, reasoning_content } }], usage } (Qwen3, etc.)
  const resultObj = result as Record<string, unknown>;
  let response: string;
  let inputTokens = 0;
  let outputTokens = 0;

  if (resultObj.choices && Array.isArray(resultObj.choices)) {
    // OpenAI-compatible format (Qwen3, etc.)
    const choices = resultObj.choices as Array<{ message: { content: string } }>;
    response = choices[0]?.message?.content ?? '';
    const usage = resultObj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    inputTokens = usage?.prompt_tokens ?? 0;
    outputTokens = usage?.completion_tokens ?? 0;
  } else {
    // Simple { response: string } format
    response = (resultObj.response as string) ?? '';
  }

  // Strip any <think>...</think> blocks that may appear inline
  response = stripThinkingTags(response);

  return {
    content: response,
    inputTokens,
    outputTokens,
  };
}

async function callExternalLLM(
  env: Env,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<LLMResponse> {
  const baseUrl = env.EXTERNAL_LLM_BASE_URL!.replace(/\/$/, '');
  const model = env.EXTERNAL_LLM_MODEL ?? 'gpt-4o-mini';

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.1,
  };

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
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    content: json.choices[0]?.message?.content ?? '',
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}

/**
 * Strip <think>...</think> blocks from model responses.
 * Qwen3 and similar "thinking" models emit reasoning in these tags
 * before the actual answer. We discard the thinking content.
 */
function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Parse JSON from LLM response, handling common formatting issues.
 */
function parseJsonResponse<T>(text: string): T {
  // Try direct parse first
  try {
    return JSON.parse(text) as T;
  } catch {
    // LLMs often wrap JSON in markdown code blocks
  }

  // Try extracting from ```json ... ```
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]) as T;
    } catch {
      // Fall through
    }
  }

  // Try finding JSON array or object
  const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]) as T;
    } catch {
      // Fall through
    }
  }

  throw new Error(`Failed to parse JSON from LLM response: ${text.substring(0, 200)}`);
}
