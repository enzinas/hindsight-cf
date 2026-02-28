/**
 * Consolidation endpoint — on-demand only in v1.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { deleteVectorsBatched } from '../vectorize-utils';

const app = new Hono<{ Bindings: Env }>();

// POST /consolidate — trigger on-demand consolidation
app.post('/', async (c) => {
  // TODO: Phase 4 — implement consolidation pipeline
  return c.json({ error: 'not_implemented', message: 'Consolidation not yet implemented' }, 501);
});

// DELETE /observations — delete all observations for a bank
app.delete('/observations', async (c) => {
  const bankId = c.req.param('bank_id');

  const rows = await c.env.DB.prepare(
    "SELECT id FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort), then D1 rows
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).run();

  return c.json({ success: true, deleted_count: result.meta.changes });
});

export { app as consolidationRoutes };
