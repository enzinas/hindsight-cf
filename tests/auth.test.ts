import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request } from './helpers';

const API_KEY = 'test-secret-key-12345';

// Helper to create a test app with a specific env
function makeApp(env: Record<string, unknown>) {
  return {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
}

describe('Auth middleware', () => {
  describe('when HINDSIGHT_API_KEY is NOT configured', () => {
    let testApp: typeof app;

    beforeEach(() => {
      const env = createMockEnv(); // no HINDSIGHT_API_KEY
      testApp = makeApp(env);
    });

    it('allows requests without Authorization header', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks');
      expect(res.status).toBe(200);
    });

    it('allows requests with an Authorization header (does not break)', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: 'Bearer some-random-key',
      });
      expect(res.status).toBe(200);
    });

    it('health endpoint always accessible', async () => {
      const res = await request(testApp, 'GET', '/health');
      expect(res.status).toBe(200);
    });
  });

  describe('when HINDSIGHT_API_KEY IS configured', () => {
    let testApp: typeof app;

    beforeEach(() => {
      const env = createMockEnv();
      env.HINDSIGHT_API_KEY = API_KEY;
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
        Authorization: `Bearer ${API_KEY}`,
      });
      expect(res.status).toBe(200);
    });

    it('accepts Bearer scheme case-insensitively', async () => {
      const res = await request(testApp, 'GET', '/v1/default/banks', undefined, {
        Authorization: `BEARER ${API_KEY}`,
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
      // Without auth
      const noAuth = await request(testApp, 'GET', '/v1/default/banks/test-bank/profile');
      expect(noAuth.status).toBe(401);

      // With auth
      const withAuth = await request(testApp, 'GET', '/v1/default/banks/test-bank/profile', undefined, {
        Authorization: `Bearer ${API_KEY}`,
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
});
