/**
 * Entity regeneration — re-process an entity's facts to update its profile.
 *
 * Re-examines all memory units linked to an entity and updates:
 * - canonical_name (if a better name emerges)
 * - mention_count, first_seen, last_seen
 * - Optionally generates a consolidated observation about the entity
 */

import type { Env } from '../env';
import { llmChat, type ChatMessage } from '../providers/llm';
import { generateEmbedding } from '../providers/embeddings';

export interface EntityRegenerateResult {
  success: boolean;
  entity_id: string;
  canonical_name: string;
  mention_count: number;
  observation_id?: string | null;
}

/**
 * Regenerate an entity's profile from its linked memories.
 */
export async function regenerateEntity(env: Env, bankId: string, entityId: string): Promise<EntityRegenerateResult> {
  // Verify entity exists
  const entity = await env.DB.prepare('SELECT id, canonical_name FROM entities WHERE id = ? AND bank_id = ?')
    .bind(entityId, bankId)
    .first<{ id: string; canonical_name: string }>();

  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  // Get all memory units linked to this entity
  const unitRows = await env.DB.prepare(
    `SELECT mu.id, mu.text, mu.fact_type, mu.event_date, mu.mentioned_at
     FROM memory_units mu
     JOIN unit_entities ue ON ue.unit_id = mu.id
     WHERE ue.entity_id = ? AND mu.bank_id = ?
     ORDER BY mu.event_date ASC`,
  )
    .bind(entityId, bankId)
    .all();

  const units = unitRows.results as Array<Record<string, unknown>>;

  if (units.length === 0) {
    return {
      success: true,
      entity_id: entityId,
      canonical_name: entity.canonical_name,
      mention_count: 0,
    };
  }

  // Recompute stats
  const dates = units
    .map((u) => (u.event_date as string) || (u.mentioned_at as string))
    .filter(Boolean)
    .sort();

  const firstSeen = dates[0] ?? new Date().toISOString();
  const lastSeen = dates[dates.length - 1] ?? new Date().toISOString();

  // Update entity stats
  await env.DB.prepare('UPDATE entities SET mention_count = ?, first_seen = ?, last_seen = ? WHERE id = ?')
    .bind(units.length, firstSeen, lastSeen, entityId)
    .run();

  // Generate a summary observation about this entity using LLM
  let observationId: string | null = null;
  if (units.length >= 3) {
    const factsText = units
      .slice(0, 30)
      .map((u, i) => `${i + 1}. ${u.text}`)
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a knowledge synthesizer. Given facts about "${entity.canonical_name}", write a concise 1-2 sentence summary observation. Output ONLY the observation text, nothing else.`,
      },
      {
        role: 'user',
        content: `Facts about ${entity.canonical_name}:\n\n${factsText}`,
      },
    ];

    try {
      const response = await llmChat(env, messages, { maxTokens: 512, temperature: 0.1 });
      const obsText = response.content.trim();

      if (obsText) {
        observationId = crypto.randomUUID();
        const now = new Date().toISOString();
        const sourceIds = units.map((u) => u.id as string);

        await env.DB.prepare(
          `INSERT INTO memory_units (id, bank_id, text, fact_type, confidence_score, source_memory_ids, event_date, mentioned_at)
           VALUES (?, ?, ?, 'observation', 0.8, ?, ?, ?)`,
        )
          .bind(observationId, bankId, obsText, JSON.stringify(sourceIds), now, now)
          .run();

        // Embed and store in Vectorize
        const embedding = await generateEmbedding(env, obsText);
        await env.VECTORIZE.upsert([
          {
            id: observationId,
            values: embedding,
            metadata: { bank_id: bankId, fact_type: 'observation' },
          },
        ]);

        // Link the observation to this entity
        await env.DB.prepare('INSERT INTO unit_entities (unit_id, entity_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
          .bind(observationId, entityId)
          .run();
      }
    } catch (err) {
      console.error('Entity regeneration LLM error:', err);
    }
  }

  return {
    success: true,
    entity_id: entityId,
    canonical_name: entity.canonical_name,
    mention_count: units.length,
    observation_id: observationId,
  };
}
