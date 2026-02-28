/**
 * Link creation for the retain pipeline.
 *
 * Creates temporal, semantic, entity, and causal links between memory units.
 * Ported from hindsight-api/engine/retain/link_creation.py and link_utils.py.
 */

import type { ProcessedFact, EntityLink } from './types';

// =============================================================================
// Temporal Links
// =============================================================================

/**
 * Create temporal links between facts that occurred close in time.
 *
 * For each new unit, finds existing units within the time window
 * and creates bidirectional weighted links.
 */
export async function createTemporalLinksBatch(
  db: D1Database,
  bankId: string,
  unitIds: string[],
  timeWindowHours: number = 24,
): Promise<number> {
  if (!unitIds.length) return 0;

  // Get event_dates for new units
  const placeholders = unitIds.map(() => '?').join(',');
  const newUnitsResult = await db
    .prepare(`SELECT id, event_date FROM memory_units WHERE id IN (${placeholders})`)
    .bind(...unitIds)
    .all();

  const newUnits = new Map<string, string>();
  for (const row of newUnitsResult.results as Array<{ id: string; event_date: string }>) {
    newUnits.set(row.id, row.event_date);
  }

  if (newUnits.size === 0) return 0;

  // Compute query time bounds
  const allDates = [...newUnits.values()].map((d) => new Date(d).getTime());
  const minDate = new Date(Math.min(...allDates) - timeWindowHours * 3600000).toISOString();
  const maxDate = new Date(Math.max(...allDates) + timeWindowHours * 3600000).toISOString();

  // Fetch candidate neighbors (existing units within time window)
  const candidatesResult = await db
    .prepare(
      `SELECT id, event_date FROM memory_units
       WHERE bank_id = ? AND event_date BETWEEN ? AND ?
       AND id NOT IN (${placeholders})
       ORDER BY event_date DESC`,
    )
    .bind(bankId, minDate, maxDate, ...unitIds)
    .all();

  const candidates = candidatesResult.results as Array<{ id: string; event_date: string }>;

  // Compute links
  const links: Array<[string, string, string, number, string | null]> = [];

  for (const [unitId, eventDate] of newUnits) {
    const unitTime = new Date(eventDate).getTime();

    // Links to existing units
    const matching = candidates
      .filter((c) => {
        const cTime = new Date(c.event_date).getTime();
        return Math.abs(cTime - unitTime) <= timeWindowHours * 3600000;
      })
      .slice(0, 10);

    for (const match of matching) {
      const timeDiffHours =
        Math.abs(new Date(match.event_date).getTime() - unitTime) / 3600000;
      const weight = Math.max(0.3, 1.0 - timeDiffHours / timeWindowHours);
      links.push([unitId, match.id, 'temporal', weight, null]);
    }
  }

  // Within-batch links
  const entries = [...newUnits.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const time1 = new Date(entries[i][1]).getTime();
      const time2 = new Date(entries[j][1]).getTime();
      const timeDiffHours = Math.abs(time1 - time2) / 3600000;

      if (timeDiffHours <= timeWindowHours) {
        const weight = Math.max(0.3, 1.0 - timeDiffHours / timeWindowHours);
        links.push([entries[i][0], entries[j][0], 'temporal', weight, null]);
        links.push([entries[j][0], entries[i][0], 'temporal', weight, null]);
      }
    }
  }

  // Batch insert
  if (links.length > 0) {
    await insertLinksBatch(db, links);
  }

  return links.length;
}

// =============================================================================
// Semantic Links
// =============================================================================

/**
 * Create semantic links between facts with similar embeddings.
 *
 * Uses Vectorize for finding similar vectors instead of computing
 * cosine similarity locally (Cloudflare adaptation).
 */
export async function createSemanticLinksBatch(
  db: D1Database,
  vectorize: VectorizeIndex,
  bankId: string,
  unitIds: string[],
  embeddings: number[][],
  topK: number = 5,
  threshold: number = 0.7,
): Promise<number> {
  if (!unitIds.length || !embeddings.length) return 0;

  const links: Array<[string, string, string, number, string | null]> = [];

  // For each new unit, query Vectorize for similar vectors
  for (let i = 0; i < unitIds.length; i++) {
    const results = await vectorize.query(embeddings[i], {
      topK: topK + 1, // +1 to account for self-match
      filter: { bank_id: bankId },
    });

    for (const match of results.matches) {
      // Skip self-matches
      if (match.id === unitIds[i]) continue;

      const score = match.score ?? 0;
      if (score >= threshold) {
        links.push([unitIds[i], match.id, 'semantic', Math.min(1.0, Math.max(0.0, score)), null]);
      }
    }
  }

  // Within-batch semantic links (compute cosine similarity directly)
  if (unitIds.length > 1) {
    for (let i = 0; i < unitIds.length; i++) {
      for (let j = i + 1; j < unitIds.length; j++) {
        const similarity = cosineSimilarity(embeddings[i], embeddings[j]);
        if (similarity >= threshold) {
          links.push([unitIds[i], unitIds[j], 'semantic', Math.min(1.0, Math.max(0.0, similarity)), null]);
          links.push([unitIds[j], unitIds[i], 'semantic', Math.min(1.0, Math.max(0.0, similarity)), null]);
        }
      }
    }
  }

  if (links.length > 0) {
    await insertLinksBatch(db, links);
  }

  return links.length;
}

// =============================================================================
// Causal Links
// =============================================================================

/**
 * Create causal links between facts based on LLM-extracted causal relations.
 */
export async function createCausalLinksBatch(
  db: D1Database,
  unitIds: string[],
  facts: ProcessedFact[],
): Promise<number> {
  if (!unitIds.length || !facts.length) return 0;

  const links: Array<[string, string, string, number, string | null]> = [];

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (!fact.causalRelations?.length) continue;

    const fromUnitId = unitIds[i];

    for (const rel of fact.causalRelations) {
      // Only "caused_by" is supported per DB constraint
      if (rel.relationType !== 'caused_by') continue;

      const targetIdx = rel.targetFactIndex;
      if (targetIdx < 0 || targetIdx >= unitIds.length) continue;

      const toUnitId = unitIds[targetIdx];
      if (fromUnitId === toUnitId) continue;

      links.push([fromUnitId, toUnitId, rel.relationType, rel.strength, null]);
    }
  }

  if (links.length > 0) {
    await insertLinksBatch(db, links);
  }

  return links.length;
}

// =============================================================================
// Entity Links
// =============================================================================

/**
 * Insert entity links in batch.
 */
export async function insertEntityLinksBatch(
  db: D1Database,
  entityLinks: EntityLink[],
): Promise<void> {
  if (entityLinks.length === 0) return;

  const links: Array<[string, string, string, number, string | null]> = entityLinks.map(
    (el) => [el.fromUnitId, el.toUnitId, el.linkType, el.weight, el.entityId],
  );

  await insertLinksBatch(db, links);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Batch insert links into memory_links table.
 */
async function insertLinksBatch(
  db: D1Database,
  links: Array<[string, string, string, number, string | null]>,
): Promise<void> {
  const BATCH_SIZE = 100; // D1 batch limit

  for (let start = 0; start < links.length; start += BATCH_SIZE) {
    const batch = links.slice(start, start + BATCH_SIZE);

    const stmts = batch.map(([from, to, type, weight, entityId]) =>
      db
        .prepare(
          `INSERT INTO memory_links (from_unit_id, to_unit_id, link_type, weight, entity_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (from_unit_id, to_unit_id, link_type, entity_id) DO NOTHING`,
        )
        .bind(from, to, type, weight, entityId),
    );

    await db.batch(stmts);
  }
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
