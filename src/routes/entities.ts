/**
 * Entity endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /entities — list entities
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '100') || 100, 1000));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0') || 0);

  const results = await c.env.DB.prepare(
    'SELECT id, canonical_name, mention_count, first_seen, last_seen, metadata FROM entities WHERE bank_id = ? ORDER BY mention_count DESC LIMIT ? OFFSET ?',
  )
    .bind(bankId, limit, offset)
    .all();

  const countResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM entities WHERE bank_id = ?')
    .bind(bankId)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      canonical_name: row.canonical_name,
      mention_count: row.mention_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /entities/:entity_id — get entity detail
app.get('/:entity_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const entityId = c.req.param('entity_id');

  const entity = await c.env.DB.prepare('SELECT * FROM entities WHERE id = ? AND bank_id = ?')
    .bind(entityId, bankId)
    .first();

  if (!entity) {
    return c.json({ error: 'not_found', message: 'Entity not found' }, 404);
  }

  // Get observations about this entity (memory units linked via unit_entities)
  const observations = await c.env.DB.prepare(
    `SELECT mu.text, mu.mentioned_at
     FROM memory_units mu
     JOIN unit_entities ue ON ue.unit_id = mu.id
     WHERE ue.entity_id = ? AND mu.bank_id = ?
     ORDER BY mu.event_date DESC
     LIMIT 50`,
  )
    .bind(entityId, bankId)
    .all();

  return c.json({
    id: entity.id,
    canonical_name: entity.canonical_name,
    mention_count: entity.mention_count,
    first_seen: entity.first_seen,
    last_seen: entity.last_seen,
    metadata: entity.metadata ? JSON.parse(entity.metadata as string) : {},
    observations: observations.results.map((row: Record<string, unknown>) => ({
      text: row.text,
      mentioned_at: row.mentioned_at,
    })),
  });
});

export { app as entitiesRoutes };
