/**
 * Mental Models endpoints (stored as memory_units with fact_type='mental_model').
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { deleteVectorsBatched } from '../vectorize-utils';

const app = new Hono<{ Bindings: Env }>();

// GET /mental-models — list mental models
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  const results = await c.env.DB.prepare(
    "SELECT id, text, context, proof_count, source_memory_ids, history, created_at, updated_at FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model' ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(bankId, limit, offset)
    .all();

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(bankId)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map(formatMentalModel),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// POST /mental-models — create mental model
app.post('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{
    text: string;
    context?: string | null;
  }>();

  if (!body.text) {
    return c.json({ error: 'validation_error', message: 'text is required' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    "INSERT INTO memory_units (id, bank_id, text, context, fact_type, event_date) VALUES (?, ?, ?, ?, 'mental_model', ?)",
  )
    .bind(id, bankId, body.text, body.context ?? null, now)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM memory_units WHERE id = ?').bind(id).first();
  return c.json(formatMentalModel(row as Record<string, unknown>), 201);
});

// GET /mental-models/:model_id — get single mental model
app.get('/:model_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const modelId = c.req.param('model_id');

  const row = await c.env.DB.prepare(
    "SELECT * FROM memory_units WHERE id = ? AND bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(modelId, bankId)
    .first();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Mental model not found' }, 404);
  }

  return c.json(formatMentalModel(row as Record<string, unknown>));
});

// PATCH /mental-models/:model_id — update mental model
app.patch('/:model_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const modelId = c.req.param('model_id');
  const body = await c.req.json<{
    text?: string;
    context?: string | null;
  }>();

  const existing = await c.env.DB.prepare(
    "SELECT * FROM memory_units WHERE id = ? AND bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(modelId, bankId)
    .first();

  if (!existing) {
    return c.json({ error: 'not_found', message: 'Mental model not found' }, 404);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.text !== undefined) {
    updates.push('text = ?');
    values.push(body.text);
  }
  if (body.context !== undefined) {
    updates.push('context = ?');
    values.push(body.context);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(modelId, bankId);

    await c.env.DB.prepare(`UPDATE memory_units SET ${updates.join(', ')} WHERE id = ? AND bank_id = ?`)
      .bind(...values)
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM memory_units WHERE id = ?').bind(modelId).first();
  return c.json(formatMentalModel(updated as Record<string, unknown>));
});

// DELETE /mental-models/:model_id — delete mental model
app.delete('/:model_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const modelId = c.req.param('model_id');

  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE id = ? AND bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(modelId, bankId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Mental model not found' }, 404);
  }

  // Delete vector from Vectorize (best-effort)
  await deleteVectorsBatched(c.env.VECTORIZE, [modelId]);

  return c.json({ success: true, deleted: modelId });
});

function formatMentalModel(row: Record<string, unknown>) {
  return {
    id: row.id,
    text: row.text,
    context: row.context,
    proof_count: row.proof_count ?? 1,
    source_memory_ids: row.source_memory_ids ? JSON.parse(row.source_memory_ids as string) : [],
    history: row.history ? JSON.parse(row.history as string) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { app as mentalModelsRoutes };
