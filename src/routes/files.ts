/**
 * File upload endpoint — disabled in v1 (feature flag off).
 * Matches original behavior when HINDSIGHT_API_ENABLE_FILE_UPLOAD_API is off.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// POST /files/retain — file upload (disabled in v1)
app.post('/retain', (c) => {
  return c.json(
    {
      error: 'feature_disabled',
      message: 'File upload is not enabled. This feature will be available in a future release.',
    },
    404,
  );
});

export { app as filesRoutes };
