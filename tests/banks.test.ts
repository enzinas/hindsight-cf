import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockEnv, request, store } from './helpers';

let testApp: typeof app;

beforeEach(() => {
  const env = createMockEnv();
  testApp = {
    fetch: (req: Request) => app.fetch(req, env as never),
  } as typeof app;
});

describe('GET /v1/default/banks', () => {
  it('returns empty list when no banks exist', async () => {
    const res = await request(testApp, 'GET', '/v1/default/banks');
    expect(res.status).toBe(200);
    const body = await res.json() as { banks: string[] };
    expect(body.banks).toEqual([]);
  });

  it('returns list of bank IDs', async () => {
    // Pre-populate banks
    store.tables.banks.push(
      { bank_id: 'bank1', name: 'Bank 1', disposition: '{}', mission: '', background: '', config: '{}', created_at: '2024-01-01', updated_at: '2024-01-01' },
      { bank_id: 'bank2', name: 'Bank 2', disposition: '{}', mission: '', background: '', config: '{}', created_at: '2024-01-02', updated_at: '2024-01-02' },
    );

    const res = await request(testApp, 'GET', '/v1/default/banks');
    expect(res.status).toBe(200);
    const body = await res.json() as { banks: string[] };
    expect(body.banks).toHaveLength(2);
    expect(body.banks).toContain('bank1');
    expect(body.banks).toContain('bank2');
  });
});

describe('GET /v1/default/banks/:bank_id/profile', () => {
  it('auto-creates bank if it does not exist', async () => {
    const res = await request(testApp, 'GET', '/v1/default/banks/new-bank/profile');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.bank_id).toBe('new-bank');
    expect(body.disposition).toEqual({ skepticism: 3, literalism: 3, empathy: 3 });
    expect(body.mission).toBe('');
  });

  it('returns existing bank profile', async () => {
    store.tables.banks.push({
      bank_id: 'test-bank',
      name: 'Test Bank',
      disposition: '{"skepticism":1,"literalism":5,"empathy":3}',
      mission: 'Test mission',
      background: '',
      config: '{}',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });

    const res = await request(testApp, 'GET', '/v1/default/banks/test-bank/profile');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.bank_id).toBe('test-bank');
    expect(body.name).toBe('Test Bank');
    expect((body.disposition as Record<string, number>).skepticism).toBe(1);
    expect(body.mission).toBe('Test mission');
  });
});

describe('PUT /v1/default/banks/:bank_id/profile/mission', () => {
  it('sets bank mission', async () => {
    // Auto-creates bank, then set mission
    await request(testApp, 'GET', '/v1/default/banks/mission-test/profile');

    const res = await request(testApp, 'PUT', '/v1/default/banks/mission-test/profile/mission', {
      content: 'I am a helpful AI assistant',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.mission).toBe('I am a helpful AI assistant');
  });
});

describe('PUT /v1/default/banks/:bank_id/profile/disposition', () => {
  it('updates disposition traits', async () => {
    await request(testApp, 'GET', '/v1/default/banks/disp-test/profile');

    const res = await request(testApp, 'PUT', '/v1/default/banks/disp-test/profile/disposition', {
      disposition: { skepticism: 5, literalism: 1, empathy: 4 },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it('rejects out-of-range disposition values', async () => {
    await request(testApp, 'GET', '/v1/default/banks/disp-test2/profile');

    const res = await request(testApp, 'PUT', '/v1/default/banks/disp-test2/profile/disposition', {
      disposition: { skepticism: 10, literalism: 1, empathy: 4 },
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/default/banks/:bank_id', () => {
  it('deletes existing bank', async () => {
    store.tables.banks.push({
      bank_id: 'delete-me',
      name: 'Delete Me',
      disposition: '{}',
      mission: '',
      background: '',
      config: '{}',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    });

    const res = await request(testApp, 'DELETE', '/v1/default/banks/delete-me');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it('returns 404 for non-existent bank', async () => {
    const res = await request(testApp, 'DELETE', '/v1/default/banks/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/default/banks/:bank_id/stats', () => {
  it('returns bank statistics', async () => {
    // Auto-creates bank
    const res = await request(testApp, 'GET', '/v1/default/banks/stats-test/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.bank_id).toBe('stats-test');
    expect(body.memories).toBeDefined();
    expect(body.entities).toBeDefined();
    expect(body.documents).toBeDefined();
    expect(body.directives).toBeDefined();
  });
});

describe('Bank config endpoints', () => {
  it('GET /config returns bank config', async () => {
    await request(testApp, 'GET', '/v1/default/banks/config-test/profile');
    const res = await request(testApp, 'GET', '/v1/default/banks/config-test/config');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.bank_id).toBe('config-test');
    expect(body.config).toEqual({});
  });

  it('PATCH /config merges config', async () => {
    await request(testApp, 'GET', '/v1/default/banks/config-test2/profile');
    const res = await request(testApp, 'PATCH', '/v1/default/banks/config-test2/config', {
      extraction_mode: 'verbose',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.config as Record<string, unknown>).extraction_mode).toBe('verbose');
  });
});
