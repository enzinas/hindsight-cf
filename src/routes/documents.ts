/**
 * Document and chunk endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { deleteVectorsBatched } from '../vectorize-utils';

const app = new Hono<{ Bindings: Env }>();

// GET /documents — list documents
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  const results = await c.env.DB.prepare(
    'SELECT id, content_hash, metadata, created_at, updated_at FROM documents WHERE bank_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(bankId, limit, offset)
    .all();

  const countResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM documents WHERE bank_id = ?')
    .bind(bankId)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      content_hash: row.content_hash,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /documents/:document_id — get document
app.get('/:document_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const documentId = c.req.param('document_id');

  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id = ? AND bank_id = ?')
    .bind(documentId, bankId)
    .first();

  if (!doc) {
    return c.json({ error: 'not_found', message: 'Document not found' }, 404);
  }

  return c.json({
    id: doc.id,
    bank_id: doc.bank_id,
    original_text: doc.original_text,
    content_hash: doc.content_hash,
    metadata: doc.metadata ? JSON.parse(doc.metadata as string) : {},
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  });
});

// DELETE /documents/:document_id — delete document, its chunks, and associated memory units
app.delete('/:document_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const documentId = c.req.param('document_id');

  // Check existence
  const doc = await c.env.DB.prepare('SELECT id FROM documents WHERE id = ? AND bank_id = ?')
    .bind(documentId, bankId)
    .first();

  if (!doc) {
    return c.json({ error: 'not_found', message: 'Document not found' }, 404);
  }

  // Collect memory unit IDs (no FK cascade from documents → memory_units)
  const rows = await c.env.DB.prepare('SELECT id FROM memory_units WHERE document_id = ? AND bank_id = ?')
    .bind(documentId, bankId)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort), then D1 rows
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  // Explicitly delete memory_units (schema has no cascade from documents to memory_units)
  if (ids.length > 0) {
    await c.env.DB.prepare('DELETE FROM memory_units WHERE document_id = ? AND bank_id = ?')
      .bind(documentId, bankId)
      .run();
  }

  // Delete document (cascades to chunks via FK)
  await c.env.DB.prepare('DELETE FROM documents WHERE id = ? AND bank_id = ?').bind(documentId, bankId).run();

  return c.json({ success: true, deleted: documentId });
});

export { app as documentsRoutes };

// Chunk route — mounted separately
const chunkApp = new Hono<{ Bindings: Env }>();

// GET /chunks/:chunk_id — get chunk
chunkApp.get('/:chunk_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const chunkId = c.req.param('chunk_id');

  const chunk = await c.env.DB.prepare('SELECT * FROM chunks WHERE chunk_id = ? AND bank_id = ?')
    .bind(chunkId, bankId)
    .first();

  if (!chunk) {
    return c.json({ error: 'not_found', message: 'Chunk not found' }, 404);
  }

  return c.json({
    id: chunk.chunk_id,
    document_id: chunk.document_id,
    bank_id: chunk.bank_id,
    chunk_index: chunk.chunk_index,
    text: chunk.chunk_text,
    created_at: chunk.created_at,
  });
});

export { chunkApp as chunksRoutes };
