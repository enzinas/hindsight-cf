/**
 * Webhook CRUD endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /webhooks — list webhooks
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');

  const results = await c.env.DB.prepare(
    'SELECT * FROM webhooks WHERE bank_id = ? ORDER BY created_at DESC',
  )
    .bind(bankId)
    .all();

  return c.json({
    webhooks: results.results.map(formatWebhook),
  });
});

// POST /webhooks — create webhook
app.post('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{
    url: string;
    events?: string[];
    secret?: string;
    is_active?: boolean;
    description?: string;
  }>();

  if (!body.url) {
    return c.json({ error: 'validation_error', message: 'url is required' }, 400);
  }

  const urlError = validateWebhookUrl(body.url);
  if (urlError) {
    return c.json({ error: 'validation_error', message: urlError }, 400);
  }

  const id = crypto.randomUUID();
  const events = JSON.stringify(body.events ?? []);

  await c.env.DB.prepare(
    'INSERT INTO webhooks (id, bank_id, url, events, secret, is_active, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, bankId, body.url, events, body.secret ?? null, body.is_active !== false ? 1 : 0, body.description ?? null)
    .run();

  const webhook = await c.env.DB.prepare('SELECT * FROM webhooks WHERE id = ?').bind(id).first();
  return c.json(formatWebhook(webhook as Record<string, unknown>), 201);
});

// PATCH /webhooks/:webhook_id — update webhook
app.patch('/:webhook_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const webhookId = c.req.param('webhook_id');
  const body = await c.req.json<{
    url?: string;
    events?: string[];
    secret?: string;
    is_active?: boolean;
    description?: string;
  }>();

  const existing = await c.env.DB.prepare('SELECT * FROM webhooks WHERE id = ? AND bank_id = ?')
    .bind(webhookId, bankId)
    .first();

  if (!existing) {
    return c.json({ error: 'not_found', message: 'Webhook not found' }, 404);
  }

  if (body.url !== undefined) {
    const urlError = validateWebhookUrl(body.url);
    if (urlError) {
      return c.json({ error: 'validation_error', message: urlError }, 400);
    }
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.url !== undefined) {
    updates.push('url = ?');
    values.push(body.url);
  }
  if (body.events !== undefined) {
    updates.push('events = ?');
    values.push(JSON.stringify(body.events));
  }
  if (body.secret !== undefined) {
    updates.push('secret = ?');
    values.push(body.secret);
  }
  if (body.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(body.is_active ? 1 : 0);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    values.push(body.description);
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(webhookId, bankId);

    await c.env.DB.prepare(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ? AND bank_id = ?`)
      .bind(...values)
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM webhooks WHERE id = ?').bind(webhookId).first();
  return c.json(formatWebhook(updated as Record<string, unknown>));
});

// DELETE /webhooks/:webhook_id — delete webhook
app.delete('/:webhook_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const webhookId = c.req.param('webhook_id');

  const result = await c.env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND bank_id = ?')
    .bind(webhookId, bankId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Webhook not found' }, 404);
  }

  return c.json({ success: true, message: 'Deleted successfully', deleted_count: 1 });
});

// GET /webhooks/:webhook_id/deliveries — list webhook deliveries
app.get('/:webhook_id/deliveries', async (c) => {
  const bankId = c.req.param('bank_id');
  const webhookId = c.req.param('webhook_id');
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50') || 50, 200));
  const cursor = c.req.query('cursor');

  // Verify webhook belongs to this bank
  const webhook = await c.env.DB.prepare('SELECT id FROM webhooks WHERE id = ? AND bank_id = ?')
    .bind(webhookId, bankId)
    .first();

  if (!webhook) {
    return c.json({ error: 'not_found', message: 'Webhook not found' }, 404);
  }

  let query = 'SELECT * FROM webhook_deliveries WHERE webhook_id = ?';
  const params: unknown[] = [webhookId];

  if (cursor) {
    query += ' AND attempted_at < ?';
    params.push(cursor);
  }

  query += ' ORDER BY attempted_at DESC LIMIT ?';
  params.push(limit);

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  const deliveries = results.results.map((row: Record<string, unknown>) => ({
    id: row.id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    payload: row.payload ? JSON.parse(row.payload as string) : {},
    response_status: row.response_status,
    response_body: row.response_body,
    success: row.success === 1,
    attempted_at: row.attempted_at,
  }));

  const nextCursor = deliveries.length === limit ? deliveries[deliveries.length - 1].attempted_at : null;

  return c.json({
    deliveries,
    cursor: nextCursor,
  });
});

/** Validate webhook URL: must be https (or http for localhost dev), no private IPs. */
function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'URL must use http or https scheme';
  }

  // Block private/internal IPs to prevent SSRF
  const hostname = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,  // link-local
    /^\[::1\]$/,    // IPv6 loopback
    /^\[fc/,        // IPv6 private
    /^\[fd/,        // IPv6 private
    /^\[fe80:/,     // IPv6 link-local
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(hostname)) {
      return 'URL must not point to private or internal addresses';
    }
  }

  return null;
}

function formatWebhook(row: Record<string, unknown>) {
  // Redact secret — never expose full secret in API responses
  const secret = row.secret as string | null;
  const redactedSecret = secret ? `${secret.substring(0, 4)}${'*'.repeat(Math.max(0, secret.length - 4))}` : null;

  return {
    id: row.id,
    bank_id: row.bank_id,
    url: row.url,
    events: row.events ? JSON.parse(row.events as string) : [],
    secret: redactedSecret,
    is_active: row.is_active === 1,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { app as webhooksRoutes };
