/**
 * Memory endpoints: retain, recall, reflect, list, get, delete.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { RetainRequest, RecallRequest, ReflectRequest } from '../types';

const app = new Hono<{ Bindings: Env }>();

// POST /memories/retain — retain memories
app.post('/retain', async (c) => {
  const body = await c.req.json<RetainRequest>();
  // TODO: Phase 2 — implement retain pipeline
  return c.json({ error: 'not_implemented', message: 'Retain pipeline not yet implemented' }, 501);
});

// POST /memories/recall — recall memories
app.post('/recall', async (c) => {
  const body = await c.req.json<RecallRequest>();
  // TODO: Phase 3 — implement recall pipeline
  return c.json({ error: 'not_implemented', message: 'Recall pipeline not yet implemented' }, 501);
});

// POST /memories/reflect — reflect on memories
app.post('/reflect', async (c) => {
  const body = await c.req.json<ReflectRequest>();
  // TODO: Phase 4 — implement reflect pipeline
  return c.json({ error: 'not_implemented', message: 'Reflect pipeline not yet implemented' }, 501);
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

// DELETE /memories/clear-observations — clear all observations
app.delete('/clear-observations', async (c) => {
  const bankId = c.req.param('bank_id');

  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).run();

  return c.json({ success: true, deleted_count: result.meta.changes });
});

export { app as memoriesRoutes };
