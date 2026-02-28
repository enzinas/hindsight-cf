/**
 * Consolidation pipeline — synthesize raw facts into observations.
 *
 * Ported from hindsight-api/engine/consolidation.
 *
 * Consolidation takes raw memory units (world, experience, opinion) and
 * groups them semantically, then uses an LLM to synthesize each group
 * into higher-level "observation" facts.
 */

import type { Env } from '../../env';
import type { FactType } from '../../types';
import { generateEmbeddings, generateEmbedding } from '../../providers/embeddings';
import { llmChatJson, type ChatMessage } from '../../providers/llm';

// =============================================================================
// Types
// =============================================================================

export interface ConsolidateConfig {
  bankId: string;
  factTypes?: FactType[];
  tags?: string[];
  maxGroups?: number;
  minGroupSize?: number;
}

export interface ConsolidateResult {
  success: boolean;
  observationCount: number;
  observationIds: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

interface MemoryUnit {
  id: string;
  text: string;
  factType: FactType;
  context: string | null;
  mentionedAt: string | null;
  occurredStart: string | null;
}

interface SynthesizedObservation {
  observation: string;
  confidence: number;
}

// =============================================================================
// Prompt
// =============================================================================

const CONSOLIDATION_PROMPT = `You are a knowledge synthesizer. Given a group of related facts, synthesize them into concise, higher-level observations.

RULES:
1. Each observation should capture a pattern, trend, or conclusion from the facts
2. Observations should be self-contained and understandable without the source facts
3. Preserve important specifics (names, dates, numbers) when relevant
4. Be concise — one clear observation per synthesis
5. Rate your confidence (0.0 to 1.0) in each observation

OUTPUT FORMAT: JSON array of objects:
[
  {
    "observation": "The synthesized observation text",
    "confidence": 0.85
  }
]

Aim for 1-3 observations per group. Quality over quantity.`;

// =============================================================================
// Pipeline
// =============================================================================

/**
 * Run the consolidation pipeline.
 */
export async function consolidate(env: Env, config: ConsolidateConfig): Promise<ConsolidateResult> {
  const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // Step 1: Fetch unconsolidated facts
  const factTypes = config.factTypes ?? ['world', 'experience', 'opinion'];
  const typePlaceholders = factTypes.map(() => '?').join(',');

  const query = `SELECT id, text, fact_type, context, mentioned_at, occurred_start
               FROM memory_units
               WHERE bank_id = ? AND fact_type IN (${typePlaceholders})
               ORDER BY event_date DESC LIMIT 500`;

  const bindValues: unknown[] = [config.bankId, ...factTypes];
  const factRows = await env.DB.prepare(query)
    .bind(...bindValues)
    .all();

  const facts: MemoryUnit[] = (factRows.results as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    text: r.text as string,
    factType: r.fact_type as FactType,
    context: r.context as string | null,
    mentionedAt: r.mentioned_at as string | null,
    occurredStart: r.occurred_start as string | null,
  }));

  if (facts.length < 2) {
    return {
      success: true,
      observationCount: 0,
      observationIds: [],
      usage: totalUsage,
    };
  }

  // Step 2: Generate embeddings for grouping
  const embeddings = await generateEmbeddings(
    env,
    facts.map((f) => f.text),
  );

  // Step 3: Semantic clustering (simple greedy approach)
  const maxGroups = config.maxGroups ?? 20;
  const minGroupSize = config.minGroupSize ?? 3;
  const groups = clusterFacts(facts, embeddings, maxGroups, minGroupSize);

  if (groups.length === 0) {
    return {
      success: true,
      observationCount: 0,
      observationIds: [],
      usage: totalUsage,
    };
  }

  // Step 4: Synthesize each group into observations
  const allObservationIds: string[] = [];

  for (const group of groups) {
    const groupFacts = group.map((idx) => facts[idx]);
    const factsText = groupFacts
      .map((f, i) => `${i + 1}. [${f.factType}] ${f.text}${f.context ? ` (context: ${f.context})` : ''}`)
      .join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: CONSOLIDATION_PROMPT },
      { role: 'user', content: `Synthesize these ${groupFacts.length} related facts:\n\n${factsText}` },
    ];

    try {
      const response = await llmChatJson<SynthesizedObservation[]>(env, messages, {
        maxTokens: 2048,
        temperature: 0.1,
      });

      totalUsage.inputTokens += response.inputTokens;
      totalUsage.outputTokens += response.outputTokens;
      totalUsage.totalTokens += response.inputTokens + response.outputTokens;

      const observations = Array.isArray(response.data) ? response.data : [];
      const sourceIds = groupFacts.map((f) => f.id);

      // Step 5: Store observations
      for (const obs of observations) {
        if (!obs.observation || typeof obs.observation !== 'string') continue;

        const obsId = crypto.randomUUID();
        const now = new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO memory_units (id, bank_id, text, fact_type, confidence_score, source_memory_ids, event_date, mentioned_at)
           VALUES (?, ?, ?, 'observation', ?, ?, ?, ?)`,
        )
          .bind(obsId, config.bankId, obs.observation, obs.confidence ?? 0.8, JSON.stringify(sourceIds), now, now)
          .run();

        // Generate embedding and store in Vectorize
        const obsEmbedding = await generateEmbedding(env, obs.observation);
        await env.VECTORIZE.upsert([
          {
            id: obsId,
            values: obsEmbedding,
            metadata: {
              bank_id: config.bankId,
              fact_type: 'observation',
            },
          },
        ]);

        allObservationIds.push(obsId);
      }
    } catch (err) {
      console.error('Consolidation LLM error for group:', err);
      // Continue with other groups
    }
  }

  return {
    success: true,
    observationCount: allObservationIds.length,
    observationIds: allObservationIds,
    usage: totalUsage,
  };
}

// =============================================================================
// Clustering
// =============================================================================

/**
 * Simple greedy semantic clustering.
 *
 * Groups facts by cosine similarity, creating groups of at least minGroupSize.
 */
function clusterFacts(
  facts: MemoryUnit[],
  embeddings: number[][],
  maxGroups: number,
  minGroupSize: number,
): number[][] {
  const n = facts.length;
  const assigned = new Set<number>();
  const groups: number[][] = [];

  for (let i = 0; i < n && groups.length < maxGroups; i++) {
    if (assigned.has(i)) continue;

    const group = [i];
    assigned.add(i);

    // Find similar facts
    const similarities: Array<{ idx: number; sim: number }> = [];
    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim > 0.6) {
        similarities.push({ idx: j, sim });
      }
    }

    // Sort by similarity descending, take top ones
    similarities.sort((a, b) => b.sim - a.sim);
    for (const { idx } of similarities.slice(0, 10)) {
      if (!assigned.has(idx)) {
        group.push(idx);
        assigned.add(idx);
      }
    }

    if (group.length >= minGroupSize) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
