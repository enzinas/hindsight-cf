/**
 * Chunk storage for the retain pipeline.
 *
 * Ported from hindsight-api/engine/retain/chunk_storage.py.
 */

import type { ChunkMetadata } from './types';

/**
 * Store document chunks in D1.
 *
 * Returns a mapping of chunk_index -> chunk_id.
 */
export async function storeChunksBatch(
  db: D1Database,
  bankId: string,
  documentId: string,
  chunks: ChunkMetadata[],
): Promise<Map<number, string>> {
  if (chunks.length === 0) return new Map();

  const chunkIdMap = new Map<number, string>();
  const stmts: D1PreparedStatement[] = [];

  for (const chunk of chunks) {
    const chunkId = `${bankId}_${documentId}_${chunk.chunkIndex}`;
    chunkIdMap.set(chunk.chunkIndex, chunkId);

    stmts.push(
      db
        .prepare(
          `INSERT INTO chunks (chunk_id, document_id, bank_id, chunk_text, chunk_index)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (chunk_id) DO UPDATE SET
             chunk_text = excluded.chunk_text`,
        )
        .bind(chunkId, documentId, bankId, chunk.chunkText, chunk.chunkIndex),
    );
  }

  await db.batch(stmts);

  return chunkIdMap;
}

/**
 * Map fact chunk indices to chunk IDs.
 */
export function mapFactsToChunks(
  factsChunkIndices: number[],
  chunkIdMap: Map<number, string>,
): Array<string | null> {
  return factsChunkIndices.map((idx) => chunkIdMap.get(idx) ?? null);
}
