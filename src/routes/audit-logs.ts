/**
 * Audit log endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /audit-logs — list audit logs
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '100') || 100, 1000));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0') || 0);
  const action = c.req.query('action');
  const resourceType = c.req.query('resource_type');

  let query = 'SELECT * FROM audit_logs WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (action) {
    query += ' AND action = ?';
    params.push(action);
  }
  if (resourceType) {
    query += ' AND resource_type = ?';
    params.push(resourceType);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  let countQuery = 'SELECT COUNT(*) as total FROM audit_logs WHERE bank_id = ?';
  const countParams: unknown[] = [bankId];
  if (action) {
    countQuery += ' AND action = ?';
    countParams.push(action);
  }
  if (resourceType) {
    countQuery += ' AND resource_type = ?';
    countParams.push(resourceType);
  }
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map(formatAuditLog),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /audit-logs/stats — audit log statistics
app.get('/stats', async (c) => {
  const bankId = c.req.param('bank_id');

  const totalResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM audit_logs WHERE bank_id = ?')
    .bind(bankId)
    .first<{ total: number }>();

  const byAction = await c.env.DB.prepare(
    'SELECT action, COUNT(*) as count FROM audit_logs WHERE bank_id = ? GROUP BY action ORDER BY count DESC',
  )
    .bind(bankId)
    .all();

  const byResource = await c.env.DB.prepare(
    'SELECT resource_type, COUNT(*) as count FROM audit_logs WHERE bank_id = ? GROUP BY resource_type ORDER BY count DESC',
  )
    .bind(bankId)
    .all();

  return c.json({
    bank_id: bankId,
    total: totalResult?.total ?? 0,
    by_action: byAction.results.map((r: Record<string, unknown>) => ({
      action: r.action,
      count: r.count,
    })),
    by_resource: byResource.results.map((r: Record<string, unknown>) => ({
      resource_type: r.resource_type,
      count: r.count,
    })),
  });
});

function formatAuditLog(row: Record<string, unknown>) {
  return {
    id: row.id,
    bank_id: row.bank_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    details: row.details ? JSON.parse(row.details as string) : {},
    actor: row.actor,
    created_at: row.created_at,
  };
}

export { app as auditLogsRoutes };
