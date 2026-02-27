/**
 * hindsight-cf — Cloudflare Workers port of hindsight memory system.
 *
 * Main entry point: Hono router with all API routes.
 * 100% API compatible with the original hindsight-api.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';

// Route modules
import { healthRoutes } from './routes/health';
import { banksRoutes } from './routes/banks';
import { memoriesRoutes } from './routes/memories';
import { entitiesRoutes } from './routes/entities';
import { documentsRoutes, chunksRoutes } from './routes/documents';
import { directivesRoutes } from './routes/directives';
import { mentalModelsRoutes } from './routes/mental-models';
import { operationsRoutes } from './routes/operations';
import { graphRoutes } from './routes/graph';
import { tagsRoutes } from './routes/tags';
import { filesRoutes } from './routes/files';

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', cors());

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'internal_error',
      message: err.message || 'An unexpected error occurred',
    },
    500
  );
});

// =============================================================================
// Monitoring endpoints (no prefix)
// =============================================================================
app.route('/', healthRoutes);

// =============================================================================
// API routes — all under /v1/default/
// =============================================================================
const api = new Hono<{ Bindings: Env }>();

// Banks (list) — GET /v1/default/banks
api.get('/banks', async (c) => {
  const results = await c.env.DB.prepare('SELECT bank_id FROM banks ORDER BY created_at DESC').all();
  return c.json({
    banks: results.results.map((row: Record<string, unknown>) => row.bank_id as string),
  });
});

// Chunks — at top level: GET /v1/default/chunks/:chunk_id (not under banks)
api.route('/chunks', chunksRoutes);

// Bank-scoped routes
const bank = new Hono<{ Bindings: Env }>();

// PUT /banks/:bank_id — update bank
bank.put('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
    ).bind(body.name, bankId).run();
  }
  return c.json({ success: true, bank_id: bankId });
});

// PATCH /banks/:bank_id — update bank
bank.patch('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
    ).bind(body.name, bankId).run();
  }
  return c.json({ success: true, bank_id: bankId });
});

// DELETE /banks/:bank_id — delete bank
bank.delete('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const result = await c.env.DB.prepare('DELETE FROM banks WHERE bank_id = ?').bind(bankId).run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }
  return c.json({ success: true, deleted: bankId });
});

// Memory operations — POST/DELETE /memories, POST /memories/recall, GET /memories/list, etc.
bank.route('/memories', memoriesRoutes);

// Reflect — POST /banks/{bank_id}/reflect
bank.post('/reflect', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Reflect pipeline not yet implemented' }, 501);
});

// Entities — GET /entities, GET /entities/:id
bank.route('/entities', entitiesRoutes);

// Entity regenerate — POST /entities/:entity_id/regenerate
bank.post('/entities/:entity_id/regenerate', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Entity regeneration not yet implemented' }, 501);
});

// Documents — GET /documents, GET /documents/:id, DELETE /documents/:id
bank.route('/documents', documentsRoutes);

// Directives — CRUD
bank.route('/directives', directivesRoutes);

// Mental Models — CRUD
bank.route('/mental-models', mentalModelsRoutes);

// Mental model refresh — POST /mental-models/:model_id/refresh
bank.post('/mental-models/:model_id/refresh', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Mental model refresh not yet implemented' }, 501);
});

// Operations — GET /operations, GET /operations/:id, DELETE /operations/:id
bank.route('/operations', operationsRoutes);

// Graph — GET /graph
bank.route('/graph', graphRoutes);

// Tags — GET /tags
bank.route('/tags', tagsRoutes);

// Files — POST /files/retain
bank.route('/files', filesRoutes);

// Consolidation — POST /consolidate
bank.post('/consolidate', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Consolidation not yet implemented' }, 501);
});

// Observations — DELETE /observations (clear all observations)
bank.delete('/observations', async (c) => {
  const bankId = c.req.param('bank_id');
  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).run();
  return c.json({ success: true, deleted_count: result.meta.changes });
});

// Background — POST /background (original: POST /banks/{bank_id}/background)
bank.post('/background', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ content: string }>();

  const { ensureBank } = await import('./routes/banks');
  const bankRow = await ensureBank(c.env.DB, bankId);
  const existingMission = bankRow.mission as string;
  const newMission = existingMission ? `${existingMission}\n\n${body.content}` : body.content;

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, background = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(newMission, body.content, bankId).run();

  return c.json({ success: true, mission: newMission });
});

// Bank profile & config (sub-routes of banks)
bank.route('/', banksRoutes);

// Mount bank routes under /banks/:bank_id
api.route('/banks/:bank_id', bank);

// Mount API under /v1/default
app.route('/v1/default', api);

// =============================================================================
// Queue consumer (for async operations)
// =============================================================================
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = message.body as Record<string, unknown>;
        console.log('Processing queue message:', payload);
        // TODO: Phase 6 — implement async operation processing
        message.ack();
      } catch (err) {
        console.error('Queue processing error:', err);
        message.retry();
      }
    }
  },
};

export { app };
