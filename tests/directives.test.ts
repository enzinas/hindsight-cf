import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request, store } from './helpers';

let testApp: typeof app;

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
  // Pre-create a bank
  store.tables.banks.push({
    bank_id: 'test-bank',
    name: 'Test',
    disposition: '{}',
    mission: '',
    background: '',
    config: '{}',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  });
});

describe('Directives CRUD', () => {
  it('POST creates a directive', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Always be polite',
      content: 'Respond in a polite and professional manner at all times.',
      priority: 10,
      tags: ['tone', 'behavior'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('Always be polite');
    expect(body.content).toBe('Respond in a polite and professional manner at all times.');
    expect(body.priority).toBe(10);
    expect(body.is_active).toBe(true);
    expect(body.tags).toEqual(['tone', 'behavior']);
    expect(body.id).toBeDefined();
  });

  it('GET lists directives', async () => {
    // Create two directives
    await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Rule 1',
      content: 'Content 1',
    });
    await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Rule 2',
      content: 'Content 2',
    });

    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/directives');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(2);
  });

  it('GET single directive by ID', async () => {
    const createRes = await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Test Directive',
      content: 'Test content',
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await request(testApp, 'GET', `/v1/default/banks/test-bank/directives/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('Test Directive');
  });

  it('GET returns 404 for non-existent directive', async () => {
    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/directives/nonexistent');
    expect(res.status).toBe(404);
  });

  it('PATCH updates a directive', async () => {
    const createRes = await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Original',
      content: 'Original content',
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await request(testApp, 'PATCH', `/v1/default/banks/test-bank/directives/${created.id}`, {
      name: 'Updated',
      content: 'Updated content',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('Updated');
  });

  it('DELETE removes a directive', async () => {
    const createRes = await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: 'Delete me',
      content: 'To be deleted',
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await request(testApp, 'DELETE', `/v1/default/banks/test-bank/directives/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it('DELETE returns 404 for non-existent directive', async () => {
    const res = await request(testApp, 'DELETE', '/v1/default/banks/test-bank/directives/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST requires name and content', async () => {
    const res = await request(testApp, 'POST', '/v1/default/banks/test-bank/directives', {
      name: '',
      content: '',
    });
    expect(res.status).toBe(400);
  });
});
