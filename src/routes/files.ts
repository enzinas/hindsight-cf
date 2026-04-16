/**
 * File upload endpoint — not yet ported to Cloudflare Workers.
 *
 * Upstream hindsight supports POST /files/retain for multipart file upload
 * with automatic chunking, fact extraction, and embedding. This requires
 * document processing pipelines (PDF parsing, chunking strategies, etc.)
 * that are not yet implemented in the CF runtime.
 *
 * Returns 501 Not Implemented with an upstream-compatible error shape.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// POST /files/retain — file upload (not implemented in CF port)
app.post('/retain', (c) => {
  return c.json(
    {
      error: 'not_implemented',
      message: 'File upload is not supported in hindsight-cf. Use POST /memories for text-based retention.',
    },
    501,
  );
});

export { app as filesRoutes };
