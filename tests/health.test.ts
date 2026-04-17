import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request } from './helpers';

// Bind mock env to app
let testApp: typeof app;

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
});

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await request(testApp, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });
});

describe('GET /version', () => {
  it('returns version info with correct structure', async () => {
    const res = await request(testApp, 'GET', '/version');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBeDefined();
    expect(body.runtime).toBe('cloudflare-workers');

    // Feature flags
    const features = body.features as Record<string, boolean>;
    expect(features.mcp).toBe(false);
    expect(features.file_upload).toBe(true);
    expect(features.multi_tenant).toBe(false);

    // Models — verify structure and that values are non-empty strings (actual values come from wrangler.toml)
    const models = body.models as Record<string, string>;
    expect(typeof models.llm).toBe('string');
    expect(models.llm.length).toBeGreaterThan(0);
    expect(typeof models.embedding).toBe('string');
    expect(models.embedding.length).toBeGreaterThan(0);
    expect(typeof models.reranker).toBe('string');
    expect(models.reranker.length).toBeGreaterThan(0);
    expect(typeof models.vision).toBe('string');
    expect(models.vision.length).toBeGreaterThan(0);
  });
});

describe('GET /metrics', () => {
  it('returns JSON metrics summary with D1 counts', async () => {
    const res = await request(testApp, 'GET', '/metrics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Without CF_API_TOKEN, analytics_engine is false and D1 counts are returned
    expect(body.analytics_engine).toBe(false);
    expect(body).toHaveProperty('d1');
    const d1 = body.d1 as Record<string, number>;
    expect(d1).toHaveProperty('banks');
    expect(d1).toHaveProperty('memory_units');
    expect(d1).toHaveProperty('entities');
    expect(d1).toHaveProperty('documents');
  });
});
