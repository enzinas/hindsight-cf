/**
 * Mental model refresh — re-synthesize a mental model from its source memories.
 *
 * Takes a mental model, finds its source memories (or searches for relevant ones),
 * and uses an LLM to produce an updated synthesis.
 */

import type { Env } from '../env';
import { llmChat, type ChatMessage } from '../providers/llm';
import { generateEmbedding } from '../providers/embeddings';
import { vectorSearch } from './recall/vector-search';
import type { FactType } from '../types';

export interface MentalModelRefreshResult {
  success: boolean;
  id: string;
  text: string;
  previous_text: string;
  source_memory_count: number;
}

/**
 * Refresh a mental model by re-synthesizing from source memories.
 */
export async function refreshMentalModel(
  env: Env,
  bankId: string,
  modelId: string,
): Promise<MentalModelRefreshResult> {
  // Get the existing mental model
  const model = await env.DB.prepare(
    "SELECT id, text, context, source_memory_ids, history FROM memory_units WHERE id = ? AND bank_id = ? AND fact_type = 'mental_model'",
  ).bind(modelId, bankId).first<{
    id: string;
    text: string;
    context: string | null;
    source_memory_ids: string;
    history: string;
  }>();

  if (!model) {
    throw new Error(`Mental model not found: ${modelId}`);
  }

  const previousText = model.text;

  // Get source memories
  let sourceIds: string[] = [];
  try {
    sourceIds = JSON.parse(model.source_memory_ids || '[]');
  } catch {
    sourceIds = [];
  }

  // Fetch source memories if we have them
  let sourceFacts: Array<{ id: string; text: string; type: string }> = [];

  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id, text, fact_type FROM memory_units WHERE id IN (${placeholders}) AND bank_id = ?`,
    ).bind(...sourceIds, bankId).all();

    sourceFacts = (rows.results as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      text: r.text as string,
      type: r.fact_type as string,
    }));
  }

  // Also search for additional relevant memories using the mental model text
  const searchResults = await vectorSearch(env, bankId, model.text, {
    topK: 20,
    factTypes: ['world', 'experience', 'opinion'] as FactType[],
  });

  for (const r of searchResults) {
    if (!sourceIds.includes(r.id)) {
      sourceFacts.push({ id: r.id, text: r.text, type: r.factType });
      sourceIds.push(r.id);
    }
  }

  if (sourceFacts.length === 0) {
    return {
      success: true,
      id: modelId,
      text: model.text,
      previous_text: previousText,
      source_memory_count: 0,
    };
  }

  // Synthesize updated mental model
  const factsText = sourceFacts.slice(0, 40).map((f, i) =>
    `${i + 1}. [${f.type}] ${f.text}`
  ).join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a knowledge synthesizer. You are updating a mental model (a concise summary/framework).

CURRENT MENTAL MODEL:
${model.text}
${model.context ? `\nCONTEXT: ${model.context}` : ''}

Based on the source facts below, produce an UPDATED version of this mental model. Incorporate new information while preserving the core structure. Output ONLY the updated mental model text, nothing else.`,
    },
    {
      role: 'user',
      content: `Source facts (${sourceFacts.length} total):\n\n${factsText}`,
    },
  ];

  const response = await llmChat(env, messages, { maxTokens: 2048, temperature: 0.1 });
  const updatedText = response.content.trim();

  if (!updatedText) {
    return {
      success: true,
      id: modelId,
      text: model.text,
      previous_text: previousText,
      source_memory_count: sourceFacts.length,
    };
  }

  // Update history
  let history: Array<{ text: string; updated_at: string }> = [];
  try {
    history = JSON.parse(model.history || '[]');
  } catch {
    history = [];
  }
  history.push({ text: previousText, updated_at: new Date().toISOString() });

  // Update the mental model
  await env.DB.prepare(
    `UPDATE memory_units
     SET text = ?, source_memory_ids = ?, proof_count = ?, history = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND bank_id = ?`,
  ).bind(
    updatedText,
    JSON.stringify(sourceIds),
    sourceFacts.length,
    JSON.stringify(history),
    modelId,
    bankId,
  ).run();

  // Update embedding in Vectorize
  const embedding = await generateEmbedding(env, updatedText);
  await env.VECTORIZE.upsert([{
    id: modelId,
    values: embedding,
    metadata: { bank_id: bankId, fact_type: 'mental_model' },
  }]);

  return {
    success: true,
    id: modelId,
    text: updatedText,
    previous_text: previousText,
    source_memory_count: sourceFacts.length,
  };
}
