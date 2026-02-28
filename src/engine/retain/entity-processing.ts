/**
 * Entity processing for the retain pipeline.
 *
 * Handles entity extraction, resolution, and linking.
 * Ported from hindsight-api/engine/retain/entity_processing.py
 * and hindsight-api/engine/entity_resolver.py.
 */

import type { ProcessedFact, EntityRef, EntityLink } from './types';

/**
 * Resolve entities for a batch of facts.
 *
 * For each fact:
 *  1. Takes LLM-extracted entities + user-provided entities
 *  2. Resolves them against existing entities in D1 (name similarity scoring)
 *  3. Creates or updates entity records
 *  4. Links memory units to entities
 *  5. Returns entity links between units that share entities
 */
export async function processEntitiesBatch(
  db: D1Database,
  bankId: string,
  unitIds: string[],
  facts: ProcessedFact[],
  userEntitiesPerContent?: Map<number, Array<{ text: string; type?: string }>>,
): Promise<EntityLink[]> {
  if (!unitIds.length || !facts.length) return [];
  if (unitIds.length !== facts.length) {
    throw new Error(`Mismatch: ${unitIds.length} unitIds vs ${facts.length} facts`);
  }

  const userEntities = userEntitiesPerContent ?? new Map();

  // Merge LLM-extracted and user-provided entities per fact
  const entitiesPerFact: Array<Array<{ text: string; type: string }>> = [];
  for (const fact of facts) {
    const llmEntities = (fact.entities ?? []).map((e) => ({
      text: e.name,
      type: 'CONCEPT',
    }));

    const contentUserEntities = userEntities.get(fact.contentIndex) ?? [];
    const seen = new Set(llmEntities.map((e) => e.text.toLowerCase()));

    for (const ue of contentUserEntities) {
      if (!seen.has(ue.text.toLowerCase())) {
        llmEntities.push({ text: ue.text, type: ue.type ?? 'CONCEPT' });
        seen.add(ue.text.toLowerCase());
      }
    }

    entitiesPerFact.push(llmEntities);
  }

  // Fact dates for resolution
  const factDates = facts.map((f) => f.occurredStart ?? f.mentionedAt);

  // Resolve entities and create links
  const resolvedIds = await resolveEntitiesBatch(db, bankId, unitIds, entitiesPerFact, factDates);

  // Create entity links between units sharing entities
  const entityLinks = createEntityLinks(unitIds, resolvedIds);

  return entityLinks;
}

/**
 * Resolve entities in batch.
 *
 * Returns a map of unitId -> entityId[] for entity link creation.
 */
async function resolveEntitiesBatch(
  db: D1Database,
  bankId: string,
  unitIds: string[],
  entitiesPerFact: Array<Array<{ text: string; type: string }>>,
  factDates: string[],
): Promise<Map<string, string[]>> {
  // Fetch all existing entities for this bank
  const existingEntities = await db
    .prepare('SELECT id, canonical_name, last_seen, mention_count FROM entities WHERE bank_id = ?')
    .bind(bankId)
    .all();

  const existingRows = existingEntities.results as Array<{
    id: string;
    canonical_name: string;
    last_seen: string;
    mention_count: number;
  }>;

  // Fetch all co-occurrences for scoring
  const cooccurrenceMap = await loadCooccurrences(db, bankId);

  // Build candidate map by entity text
  const candidatesByText = new Map<string, typeof existingRows>();
  for (const text of new Set(entitiesPerFact.flat().map((e) => e.text))) {
    const textLower = text.toLowerCase();
    const matching = existingRows.filter((row) => {
      const canonLower = row.canonical_name.toLowerCase();
      return textLower === canonLower || textLower.includes(canonLower) || canonLower.includes(textLower);
    });
    candidatesByText.set(text, matching);
  }

  const unitToEntityIds = new Map<string, string[]>();
  const entitiesToUpdate: Array<{ id: string; date: string }> = [];
  const entitiesToCreate: Array<{
    text: string;
    date: string;
    unitId: string;
  }> = [];

  // Resolve each fact's entities
  for (let i = 0; i < unitIds.length; i++) {
    const unitId = unitIds[i];
    const factEntities = entitiesPerFact[i];
    const factDate = factDates[i];

    if (!factEntities.length) continue;

    const entityIds: string[] = [];

    for (const entity of factEntities) {
      const candidates = candidatesByText.get(entity.text) ?? [];

      if (!candidates.length) {
        entitiesToCreate.push({ text: entity.text, date: factDate, unitId });
        continue;
      }

      // Score candidates
      const nearbyNames = new Set(factEntities.filter((e) => e.text !== entity.text).map((e) => e.text.toLowerCase()));

      let bestId: string | null = null;
      let bestScore = 0;

      for (const candidate of candidates) {
        let score = 0;

        // 1. Name similarity (0-0.5)
        const nameSim = stringSimilarity(entity.text.toLowerCase(), candidate.canonical_name.toLowerCase());
        score += nameSim * 0.5;

        // 2. Co-occurring entities (0-0.3)
        if (nearbyNames.size > 0) {
          const coEntities = cooccurrenceMap.get(candidate.id) ?? new Set<string>();
          let overlap = 0;
          for (const nearby of nearbyNames) {
            if (coEntities.has(nearby)) overlap++;
          }
          score += (overlap / nearbyNames.size) * 0.3;
        }

        // 3. Temporal proximity (0-0.2)
        if (candidate.last_seen && factDate) {
          const daysDiff = Math.abs(new Date(factDate).getTime() - new Date(candidate.last_seen).getTime()) / 86400000;
          if (daysDiff < 7) {
            score += Math.max(0, 1.0 - daysDiff / 7) * 0.2;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestId = candidate.id;
        }
      }

      if (bestScore > 0.6 && bestId) {
        entityIds.push(bestId);
        entitiesToUpdate.push({ id: bestId, date: factDate });
      } else {
        entitiesToCreate.push({ text: entity.text, date: factDate, unitId });
      }
    }

    if (entityIds.length > 0) {
      unitToEntityIds.set(unitId, entityIds);
    }
  }

  // Batch update existing entities
  if (entitiesToUpdate.length > 0) {
    const stmts = entitiesToUpdate.map(({ id, date }) =>
      db.prepare('UPDATE entities SET mention_count = mention_count + 1, last_seen = ? WHERE id = ?').bind(date, id),
    );
    await db.batch(stmts);
  }

  // Batch create new entities (dedup by name within batch)
  if (entitiesToCreate.length > 0) {
    const uniqueByName = new Map<string, { text: string; date: string; unitIds: string[] }>();
    for (const e of entitiesToCreate) {
      const key = e.text.toLowerCase();
      if (!uniqueByName.has(key)) {
        uniqueByName.set(key, { text: e.text, date: e.date, unitIds: [e.unitId] });
      } else {
        uniqueByName.get(key)!.unitIds.push(e.unitId);
      }
    }

    const insertStmts = [];
    for (const [, { text, date }] of uniqueByName) {
      insertStmts.push(
        db
          .prepare(
            `INSERT INTO entities (bank_id, canonical_name, first_seen, last_seen, mention_count)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT (bank_id, canonical_name COLLATE NOCASE)
             DO UPDATE SET mention_count = mention_count + 1, last_seen = excluded.last_seen
             RETURNING id`,
          )
          .bind(bankId, text, date, date),
      );
    }

    const results = await db.batch(insertStmts);

    // Map back to unit IDs
    let idx = 0;
    for (const [, { unitIds: createUnitIds }] of uniqueByName) {
      const result = results[idx];
      const entityId = (result.results[0] as { id: string })?.id;
      if (entityId) {
        for (const unitId of createUnitIds) {
          const existing = unitToEntityIds.get(unitId) ?? [];
          existing.push(entityId);
          unitToEntityIds.set(unitId, existing);
        }
      }
      idx++;
    }
  }

  // Insert unit_entities junction records
  const unitEntityPairs: Array<{ unitId: string; entityId: string }> = [];
  for (const [unitId, entityIds] of unitToEntityIds) {
    for (const entityId of entityIds) {
      unitEntityPairs.push({ unitId, entityId });
    }
  }

  if (unitEntityPairs.length > 0) {
    const linkStmts = unitEntityPairs.map(({ unitId, entityId }) =>
      db
        .prepare('INSERT INTO unit_entities (unit_id, entity_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .bind(unitId, entityId),
    );
    await db.batch(linkStmts);

    // Update co-occurrence cache
    await updateCooccurrences(db, unitToEntityIds);
  }

  return unitToEntityIds;
}

/**
 * Load co-occurrence data for entity resolution scoring.
 * Returns entityId -> Set of co-occurring canonical names (lowercase).
 */
async function loadCooccurrences(db: D1Database, bankId: string): Promise<Map<string, Set<string>>> {
  // Get entity id -> name mapping
  const entities = await db.prepare('SELECT id, canonical_name FROM entities WHERE bank_id = ?').bind(bankId).all();

  const idToName = new Map<string, string>();
  const entityIds = new Set<string>();
  for (const row of entities.results as Array<{ id: string; canonical_name: string }>) {
    idToName.set(row.id, row.canonical_name.toLowerCase());
    entityIds.add(row.id);
  }

  if (entityIds.size === 0) return new Map();

  // Get co-occurrences
  const cooccurrences = await db
    .prepare(
      `SELECT entity_id_1, entity_id_2 FROM entity_cooccurrences
       WHERE entity_id_1 IN (SELECT id FROM entities WHERE bank_id = ?)
          OR entity_id_2 IN (SELECT id FROM entities WHERE bank_id = ?)`,
    )
    .bind(bankId, bankId)
    .all();

  const map = new Map<string, Set<string>>();
  for (const row of cooccurrences.results as Array<{
    entity_id_1: string;
    entity_id_2: string;
  }>) {
    if (!map.has(row.entity_id_1)) map.set(row.entity_id_1, new Set());
    if (!map.has(row.entity_id_2)) map.set(row.entity_id_2, new Set());

    const name1 = idToName.get(row.entity_id_1);
    const name2 = idToName.get(row.entity_id_2);
    if (name2) map.get(row.entity_id_1)!.add(name2);
    if (name1) map.get(row.entity_id_2)!.add(name1);
  }

  return map;
}

/**
 * Update co-occurrence cache for entities that appear in the same unit.
 */
async function updateCooccurrences(db: D1Database, unitToEntityIds: Map<string, string[]>): Promise<void> {
  const pairs = new Set<string>();
  const pairData: Array<[string, string]> = [];

  for (const [, entityIds] of unitToEntityIds) {
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        let id1 = entityIds[i];
        let id2 = entityIds[j];
        if (id1 > id2) [id1, id2] = [id2, id1]; // Ensure consistent ordering

        const key = `${id1}:${id2}`;
        if (!pairs.has(key)) {
          pairs.add(key);
          pairData.push([id1, id2]);
        }
      }
    }
  }

  if (pairData.length === 0) return;

  const now = new Date().toISOString();
  const stmts = pairData.map(([id1, id2]) =>
    db
      .prepare(
        `INSERT INTO entity_cooccurrences (entity_id_1, entity_id_2, cooccurrence_count, last_cooccurred)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (entity_id_1, entity_id_2)
         DO UPDATE SET cooccurrence_count = cooccurrence_count + 1, last_cooccurred = ?`,
      )
      .bind(id1, id2, now, now),
  );

  await db.batch(stmts);
}

/**
 * Create entity links between memory units that share entities.
 */
function createEntityLinks(unitIds: string[], unitToEntityIds: Map<string, string[]>): EntityLink[] {
  // Invert: entityId -> unitIds
  const entityToUnits = new Map<string, string[]>();
  for (const [unitId, entityIds] of unitToEntityIds) {
    for (const entityId of entityIds) {
      if (!entityToUnits.has(entityId)) entityToUnits.set(entityId, []);
      entityToUnits.get(entityId)!.push(unitId);
    }
  }

  const MAX_LINKS_PER_ENTITY = 50;
  const links: EntityLink[] = [];
  const unitIdSet = new Set(unitIds);

  for (const [entityId, units] of entityToUnits) {
    const newUnits = units.filter((u) => unitIdSet.has(u));
    const toLink = newUnits.length > MAX_LINKS_PER_ENTITY ? newUnits.slice(-MAX_LINKS_PER_ENTITY) : newUnits;

    // Link new units to each other
    for (let i = 0; i < toLink.length; i++) {
      for (let j = i + 1; j < toLink.length; j++) {
        links.push({
          fromUnitId: toLink[i],
          toUnitId: toLink[j],
          entityId,
          linkType: 'entity',
          weight: 1.0,
        });
        links.push({
          fromUnitId: toLink[j],
          toUnitId: toLink[i],
          entityId,
          linkType: 'entity',
          weight: 1.0,
        });
      }
    }
  }

  return links;
}

/**
 * Simple string similarity (SequenceMatcher equivalent).
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a.length || !b.length) return 0.0;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;

  // Find longest common substring
  let matches = 0;
  const longerLen = longer.length;
  const shorterLen = shorter.length;

  // Simple character-by-character comparison for performance
  const matrix: number[][] = [];
  let maxLen = 0;

  for (let i = 0; i <= shorterLen; i++) {
    matrix[i] = [];
    for (let j = 0; j <= longerLen; j++) {
      if (i === 0 || j === 0) {
        matrix[i][j] = 0;
      } else if (shorter[i - 1] === longer[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
        maxLen = Math.max(maxLen, matrix[i][j]);
      } else {
        matrix[i][j] = 0;
      }
    }
  }

  // Use ratio similar to SequenceMatcher
  matches = maxLen;
  return (2.0 * matches) / (longerLen + shorterLen);
}

/**
 * Update entity references on ProcessedFacts with resolved entity IDs.
 */
export function updateFactEntities(
  facts: ProcessedFact[],
  unitIds: string[],
  unitToEntityIds: Map<string, string[]>,
): void {
  for (let i = 0; i < facts.length; i++) {
    const entityIds = unitToEntityIds.get(unitIds[i]);
    if (entityIds) {
      facts[i].entities = entityIds.map(
        (id) =>
          ({
            name: facts[i].entities.find((e) => e.entityId === id)?.name ?? '',
            entityId: id,
          }) as EntityRef,
      );
    }
  }
}
