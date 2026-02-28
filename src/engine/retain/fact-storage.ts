/**
 * Fact storage — insert memory units into D1 and vectors into Vectorize.
 *
 * Ported from hindsight-api/engine/retain/fact_storage.py.
 */

import type { ProcessedFact } from './types';

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Sanitize text: remove null bytes and invalid unicode.
 */
function sanitizeText(text: string): string {
  return text.replace(/\0/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

/**
 * Ensure a bank exists in D1, creating it with defaults if needed.
 */
export async function ensureBank(db: D1Database, bankId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO banks (bank_id, name) VALUES (?, ?)
       ON CONFLICT (bank_id) DO NOTHING`,
    )
    .bind(bankId, bankId)
    .run();
}

/**
 * Handle document tracking: upsert document record with content hash.
 */
export async function handleDocumentTracking(
  db: D1Database,
  bankId: string,
  documentId: string,
  originalText: string,
  metadata: Record<string, string>,
  tags: string[],
): Promise<void> {
  // Compute SHA-256 content hash
  const encoder = new TextEncoder();
  const data = encoder.encode(originalText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const contentHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  const metadataWithTags = { ...metadata };
  if (tags.length > 0) {
    metadataWithTags._tags = JSON.stringify(tags);
  }

  await db
    .prepare(
      `INSERT INTO documents (id, bank_id, original_text, content_hash, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id, bank_id) DO UPDATE SET
         original_text = excluded.original_text,
         content_hash = excluded.content_hash,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(documentId, bankId, originalText, contentHash, JSON.stringify(metadataWithTags))
    .run();
}

/**
 * Insert facts into D1 and upsert vectors into Vectorize.
 *
 * Returns the list of generated unit IDs in the same order as input facts.
 */
export async function insertFactsBatch(
  db: D1Database,
  vectorize: VectorizeIndex,
  bankId: string,
  facts: ProcessedFact[],
  documentId?: string | null,
): Promise<string[]> {
  if (facts.length === 0) return [];

  const unitIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];

  for (const fact of facts) {
    const unitId = generateUUID();
    unitIds.push(unitId);

    const eventDate = fact.occurredStart ?? fact.mentionedAt;
    const confidenceScore = fact.factType === 'opinion' ? 0.5 : null;

    stmts.push(
      db
        .prepare(
          `INSERT INTO memory_units
           (id, bank_id, document_id, chunk_id, text, context, event_date,
            occurred_start, occurred_end, mentioned_at, fact_type,
            confidence_score, metadata, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          unitId,
          bankId,
          fact.documentId ?? documentId ?? null,
          fact.chunkId ?? null,
          sanitizeText(fact.factText),
          fact.context || null,
          eventDate,
          fact.occurredStart ?? null,
          fact.occurredEnd ?? null,
          fact.mentionedAt,
          fact.factType,
          confidenceScore,
          JSON.stringify(fact.metadata),
          JSON.stringify(fact.tags),
        ),
    );
  }

  // Batch insert into D1
  await db.batch(stmts);

  // Upsert vectors into Vectorize
  const vectors: VectorizeVector[] = [];
  for (let i = 0; i < facts.length; i++) {
    vectors.push({
      id: unitIds[i],
      values: facts[i].embedding,
      metadata: {
        bank_id: bankId,
        fact_type: facts[i].factType,
        tags: facts[i].tags.join(','),
      },
    });
  }

  if (vectors.length > 0) {
    // Vectorize supports batch upsert
    await vectorize.upsert(vectors);
  }

  return unitIds;
}
