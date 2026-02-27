/**
 * Memory endpoints: retain, recall, list, get, delete.
 *
 * Route mapping to original:
 *   POST   /banks/{bank_id}/memories          — retain memories
 *   POST   /banks/{bank_id}/memories/recall    — recall memories
 *   GET    /banks/{bank_id}/memories/list      — list memory units
 *   GET    /banks/{bank_id}/memories/{id}      — get memory unit
 *   DELETE /banks/{bank_id}/memories/{id}      — delete memory unit
 *   DELETE /banks/{bank_id}/memories           — clear bank memories
 *   DELETE /banks/{bank_id}/memories/{id}/observations — delete memory observations
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { RetainRequest, RecallRequest } from '../types';

const app = new Hono<{ Bindings: Env }>();

// POST /memories — retain memories (original: POST /banks/{bank_id}/memories)
app.post('/', async (c) => {
  const _body = await c.req.json<RetainRequest>();
  // TODO: Phase 2 — implement retain pipeline
  return c.json({ error: 'not_implemented', message: 'Retain pipeline not yet implemented' }, 501);
});

// DELETE /memories — clear bank memories (original: DELETE /banks/{bank_id}/memories)
app.delete('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const factType = c.req.query('type');

  let query = 'DELETE FROM memory_units WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (factType) {
    query += ' AND fact_type = ?';
    params.push(factType);
  }

  const result = await c.env.DB.prepare(query).bind(...params).run();
  // TODO: Also delete from Vectorize index
  return c.json({ success: true, deleted_count: result.meta.changes });
});

// POST /memories/recall — recall memories
app.post('/recall', async (c) => {
  const _body = await c.req.json<RecallRequest>();
  // TODO: Phase 3 — implement recall pipeline
  return c.json({ error: 'not_implemented', message: 'Recall pipeline not yet implemented' }, 501);
});

// GET /memories/list — list memory units
app.get('/list', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const factType = c.req.query('type');

  let query = 'SELECT id, text, fact_type, context, event_date, created_at FROM memory_units WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (factType) {
    query += ' AND fact_type = ?';
    params.push(factType);
  }

  query += ' ORDER BY event_date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await c.env.DB.prepare(query).bind(...params).all();

  const countQuery = factType
    ? 'SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = ?'
    : 'SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ?';
  const countParams = factType ? [bankId, factType] : [bankId];
  const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();

  return c.json({
    items: results.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      type: row.fact_type,
      context: row.context,
      event_date: row.event_date,
      created_at: row.created_at,
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /memories/:memory_id — get single memory unit
app.get('/:memory_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  const row = await c.env.DB.prepare(
    'SELECT * FROM memory_units WHERE id = ? AND bank_id = ?'
  ).bind(memoryId, bankId).first();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Memory unit not found' }, 404);
  }

  return c.json(row);
});

// DELETE /memories/:memory_id — delete memory unit
app.delete('/:memory_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  const result = await c.env.DB.prepare(
    'DELETE FROM memory_units WHERE id = ? AND bank_id = ?'
  ).bind(memoryId, bankId).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Memory unit not found' }, 404);
  }

  // TODO: Also delete from Vectorize index
  return c.json({ success: true, deleted: memoryId });
});

// DELETE /memories/:memory_id/observations — delete observations for a memory
app.delete('/:memory_id/observations', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation' AND id IN (SELECT id FROM memory_units WHERE source_memory_ids LIKE ?)"
  ).bind(bankId, `%${memoryId}%`).run();

  return c.json({ success: true, deleted_count: result.meta.changes });
});

export { app as memoriesRoutes };
