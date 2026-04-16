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
    expect(body.version).toBe('0.1.0-test');
    expect(body.runtime).toBe('cloudflare-workers');

    // Feature flags
    const features = body.features as Record<string, boolean>;
    expect(features.mcp).toBe(false);
    expect(features.file_upload).toBe(false);
    expect(features.multi_tenant).toBe(false);

    // Models
    const models = body.models as Record<string, string>;
    expect(models.llm).toBe('@cf/meta/llama-3.1-70b-instruct');
    expect(models.embedding).toBe('@cf/baai/bge-base-en-v1.5');
    expect(models.reranker).toBe('@cf/baai/bge-reranker-base');
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
