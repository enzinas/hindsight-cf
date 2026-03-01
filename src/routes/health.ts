/**
 * Health and version endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.get('/version', (c) => {
  return c.json({
    version: c.env.HINDSIGHT_VERSION || '0.1.0',
    runtime: 'cloudflare-workers',
    features: {
      mcp: false,
      file_upload: false,
      multi_tenant: false,
    },
    models: {
      llm: c.env.DEFAULT_LLM_MODEL,
      embedding: c.env.DEFAULT_EMBEDDING_MODEL,
      reranker: c.env.DEFAULT_RERANKER_MODEL,
    },
  });
});

app.get('/metrics', (c) => {
  // Support Accept: application/json for generated clients that assume JSON
  const accept = c.req.header('accept') || '';
  if (accept.includes('application/json')) {
    return c.json(null);
  }
  // Default: Prometheus text format
  return c.text('# hindsight-cf metrics stub\n', 200, {
    'Content-Type': 'text/plain',
  });
});

export { app as healthRoutes };
