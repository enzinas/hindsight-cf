/**
 * Graph data endpoint.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /graph — get graph data (entities + links)
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = parseInt(c.req.query('limit') || '50');

  // Get top entities by mention count
  const entities = await c.env.DB.prepare(
    'SELECT id, canonical_name, mention_count FROM entities WHERE bank_id = ? ORDER BY mention_count DESC LIMIT ?',
  )
    .bind(bankId, limit)
    .all();

  // Get co-occurrence edges between those entities
  const entityIds = entities.results.map((e: Record<string, unknown>) => e.id as string);

  let edges: D1Result<Record<string, unknown>> = { results: [], success: true, meta: {} as D1Result['meta'] };
  if (entityIds.length > 0) {
    const placeholders = entityIds.map(() => '?').join(', ');
    edges = await c.env.DB.prepare(
      `SELECT entity_id_1, entity_id_2, cooccurrence_count
       FROM entity_cooccurrences
       WHERE entity_id_1 IN (${placeholders}) AND entity_id_2 IN (${placeholders})
       ORDER BY cooccurrence_count DESC
       LIMIT 200`,
    )
      .bind(...entityIds, ...entityIds)
      .all();
  }

  const nodeList = entities.results.map((e: Record<string, unknown>) => ({
    id: e.id,
    label: e.canonical_name,
    size: e.mention_count,
  }));
  const edgeList = edges.results.map((e: Record<string, unknown>) => ({
    from: e.entity_id_1,
    to: e.entity_id_2,
    weight: e.cooccurrence_count,
  }));

  return c.json({
    nodes: nodeList,
    edges: edgeList,
    total_nodes: nodeList.length,
    total_edges: edgeList.length,
    limit,
  });
});

export { app as graphRoutes };
