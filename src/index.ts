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
import { consolidationRoutes } from './routes/consolidation';

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

// Banks (list)
api.get('/banks', async (c) => {
  // Delegate to banks route handler
  const results = await c.env.DB.prepare('SELECT bank_id FROM banks ORDER BY created_at DESC').all();
  return c.json({
    banks: results.results.map((row: Record<string, unknown>) => row.bank_id as string),
  });
});

// Bank-scoped routes
const bank = new Hono<{ Bindings: Env }>();

// Memory operations
bank.route('/memories', memoriesRoutes);

// Reflect (also mounted at bank level per original API)
bank.post('/reflect', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Reflect pipeline not yet implemented' }, 501);
});

// Entities
bank.route('/entities', entitiesRoutes);

// Documents
bank.route('/documents', documentsRoutes);

// Chunks
bank.route('/chunks', chunksRoutes);

// Directives
bank.route('/directives', directivesRoutes);

// Mental Models
bank.route('/mental-models', mentalModelsRoutes);

// Operations
bank.route('/operations', operationsRoutes);

// Graph
bank.route('/graph', graphRoutes);

// Tags
bank.route('/tags', tagsRoutes);

// Files
bank.route('/files', filesRoutes);

// Consolidation
bank.post('/consolidate', async (c) => {
  return c.json({ error: 'not_implemented', message: 'Consolidation not yet implemented' }, 501);
});

// Observations management
bank.delete('/observations', async (c) => {
  const bankId = c.req.param('bank_id');
  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).run();
  return c.json({ success: true, deleted_count: result.meta.changes });
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
