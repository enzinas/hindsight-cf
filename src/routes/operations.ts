/**
 * Async operations endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /operations — list operations
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = 'SELECT * FROM async_operations WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await c.env.DB.prepare(query).bind(...params).all();

  let countQuery = 'SELECT COUNT(*) as total FROM async_operations WHERE bank_id = ?';
  const countParams: unknown[] = [bankId];
  if (status) {
    countQuery += ' AND status = ?';
    countParams.push(status);
  }
  const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();

  return c.json({
    items: results.results.map(formatOperation),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /operations/:operation_id — get single operation
app.get('/:operation_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const operationId = c.req.param('operation_id');

  const op = await c.env.DB.prepare(
    'SELECT * FROM async_operations WHERE operation_id = ? AND bank_id = ?'
  ).bind(operationId, bankId).first();

  if (!op) {
    return c.json({ error: 'not_found', message: 'Operation not found' }, 404);
  }

  return c.json(formatOperation(op as Record<string, unknown>));
});

// DELETE /operations/:operation_id — cancel operation
app.delete('/:operation_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const operationId = c.req.param('operation_id');

  // Only allow cancelling pending operations
  const op = await c.env.DB.prepare(
    'SELECT * FROM async_operations WHERE operation_id = ? AND bank_id = ?'
  ).bind(operationId, bankId).first();

  if (!op) {
    return c.json({ error: 'not_found', message: 'Operation not found' }, 404);
  }

  if (op.status !== 'pending') {
    return c.json({ error: 'invalid_state', message: `Cannot cancel operation in '${op.status}' state` }, 409);
  }

  await c.env.DB.prepare(
    'DELETE FROM async_operations WHERE operation_id = ? AND bank_id = ?'
  ).bind(operationId, bankId).run();

  return c.json({ success: true, deleted: operationId });
});

function formatOperation(row: Record<string, unknown>) {
  return {
    operation_id: row.operation_id,
    bank_id: row.bank_id,
    operation_type: row.operation_type,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    result_metadata: row.result_metadata ? JSON.parse(row.result_metadata as string) : {},
  };
}

export { app as operationsRoutes };
