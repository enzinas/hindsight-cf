import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, store, request } from './helpers';

const GLOBAL_KEY = 'test-secret-key-12345';
const TENANT_KEY = 'tenant-key-acme-99999';
const TENANT_KEY_2 = 'tenant-key-beta-88888';

// Helper to create a test app with a specific env
function makeApp(env: Record<string, unknown>) {
  return {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
}

describe('Auth middleware', () => {
  // =========================================================================
  // Mode 3: Open access (no HINDSIGHT_API_KEY, no D1 api_keys)
  // =========================================================================
  describe('open mode (no auth configured)', () => {
    let testApp: typeof app;

    beforeEach(() => {
      const env = createMockEnv();
      testApp = makeApp(env);
    });

    it('allows requests without Authorization header', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks');
      expect(res.status).toBe(200);
    });

    it('health endpoint always accessible', async () => {
      const res = await request(testApp, 'GET', '/health');
      expect(res.status).toBe(200);
    });

    it('works with any tenant name', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks');
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // Mode 1: Single-key (HINDSIGHT_API_KEY env var)
  // =========================================================================
  describe('single-key mode (HINDSIGHT_API_KEY)', () => {
    let testApp: typeof app;

    beforeEach(() => {
      const env = createMockEnv();
      env.HINDSIGHT_API_KEY = GLOBAL_KEY;
      testApp = makeApp(env);
    });

    it('rejects requests without Authorization header (401)', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks');
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
    });

    it('rejects requests with malformed Authorization header (401)', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: 'Basic dXNlcjpwYXNz',
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
      expect(body.message).toContain('Bearer');
    });

    it('rejects requests with wrong token (403)', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: 'Bearer wrong-key',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });

    it('allows requests with correct Bearer token', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: `Bearer ${GLOBAL_KEY}`,
      });
      expect(res.status).toBe(200);
    });

    it('accepts Bearer scheme case-insensitively', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: `BEARER ${GLOBAL_KEY}`,
      });
      expect(res.status).toBe(200);
    });

    it('global key works for any tenant name', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: `Bearer ${GLOBAL_KEY}`,
      });
      expect(res.status).toBe(200);
    });

    it('health endpoint remains accessible without auth', async () => {
      const res = await request(testApp, 'GET', '/health');
      expect(res.status).toBe(200);
    });

    it('version endpoint remains accessible without auth', async () => {
      const res = await request(testApp, 'GET', '/version');
      expect(res.status).toBe(200);
    });

    it('metrics endpoint remains accessible without auth', async () => {
      const res = await request(testApp, 'GET', '/metrics');
      expect(res.status).toBe(200);
    });

    it('protects bank-scoped routes', async () => {
      const noAuth = await request(testApp, 'GET', '/v1/default/banks/test-bank/profile');
      expect(noAuth.status).toBe(401);

      const withAuth = await request(testApp, 'GET', '/v1/default/banks/test-bank/profile', undefined, {
        Authorization: `Bearer ${GLOBAL_KEY}`,
      });
      expect(withAuth.status).toBe(200);
    });

    it('protects POST endpoints', async () => {
      const res = await request(
        testApp,
        'POST',
        '/v1/default/banks/test-bank/memories',
        { items: [{ content: 'test' }] },
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Mode 2: Multi-tenant (D1 api_keys table)
  // =========================================================================
  describe('multi-tenant mode (D1 api_keys)', () => {
    let testApp: typeof app;

    beforeEach(() => {
      const env = createMockEnv();
      // No HINDSIGHT_API_KEY — auth comes from D1 api_keys table
      testApp = makeApp(env);

      // Seed two tenant keys
      store.tables.api_keys.push({
        id: 'key-1',
        token: TENANT_KEY,
        tenant_id: 'acme',
        description: 'Acme Corp key',
        created_at: new Date().toISOString(),
        expires_at: null,
      });
      store.tables.api_keys.push({
        id: 'key-2',
        token: TENANT_KEY_2,
        tenant_id: 'beta',
        description: 'Beta Inc key',
        created_at: new Date().toISOString(),
        expires_at: null,
      });
    });

    it('rejects requests without Authorization when keys exist (401)', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks');
      expect(res.status).toBe(401);
    });

    it('allows requests with valid tenant key matching URL tenant', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY}`,
      });
      expect(res.status).toBe(200);
    });

    it('rejects valid key used for wrong tenant (403)', async () => {
      // TENANT_KEY belongs to "acme", but URL says "beta"
      const res = await request(testApp, 'GET', '/v1/beta/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY}`,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain('not authorized for this tenant');
    });

    it('rejects unknown token (403)', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: 'Bearer unknown-token-xyz',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
    });

    it('rejects malformed Authorization header (401)', async () => {
      const res = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: 'Basic dXNlcjpwYXNz',
      });
      expect(res.status).toBe(401);
    });

    it('each tenant can only access their own namespace', async () => {
      // acme key → acme tenant ✓
      const acmeOk = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY}`,
      });
      expect(acmeOk.status).toBe(200);

      // beta key → beta tenant ✓
      const betaOk = await request(testApp, 'GET', '/v1/beta/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY_2}`,
      });
      expect(betaOk.status).toBe(200);

      // acme key → beta tenant ✗
      const acmeBeta = await request(testApp, 'GET', '/v1/beta/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY}`,
      });
      expect(acmeBeta.status).toBe(403);

      // beta key → acme tenant ✗
      const betaAcme = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: `Bearer ${TENANT_KEY_2}`,
      });
      expect(betaAcme.status).toBe(403);
    });

    it('rejects expired keys (403)', async () => {
      // Add an expired key
      store.tables.api_keys.push({
        id: 'key-expired',
        token: 'expired-key-token',
        tenant_id: 'acme',
        description: 'Expired key',
        created_at: new Date().toISOString(),
        expires_at: '2020-01-01T00:00:00.000Z', // in the past
      });

      const res = await request(testApp, 'GET', '/v1/acme/banks', undefined, {
        Authorization: 'Bearer expired-key-token',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain('expired');
    });

    it('health endpoint remains accessible without auth', async () => {
      const res = await request(testApp, 'GET', '/health');
      expect(res.status).toBe(200);
    });

    it('protects bank-scoped routes', async () => {
      const noAuth = await request(testApp, 'GET', '/v1/acme/banks/test-bank/profile');
      expect(noAuth.status).toBe(401);

      const withAuth = await request(testApp, 'GET', '/v1/acme/banks/test-bank/profile', undefined, {
        Authorization: `Bearer ${TENANT_KEY}`,
      });
      expect(withAuth.status).toBe(200);
    });
  });
});
