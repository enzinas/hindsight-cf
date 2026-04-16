/**
 * Health, version, and metrics endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import { getMetricsSummary } from '../metrics';

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

app.get('/metrics', async (c) => {
  const summary = await getMetricsSummary(c.env);
  return c.json(summary);
});

export { app as healthRoutes };
