/**
 * Directives CRUD endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

// GET /directives — list directives
app.get('/', async (c) => {
  const bankId = c.req.param('bank_id');

  const results = await c.env.DB.prepare(
    'SELECT * FROM directives WHERE bank_id = ? ORDER BY priority DESC, created_at ASC'
  ).bind(bankId).all();

  return c.json({
    items: results.results.map(formatDirective),
  });
});

// POST /directives — create directive
app.post('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{
    name: string;
    content: string;
    priority?: number;
    is_active?: boolean;
    tags?: string[];
  }>();

  if (!body.name || !body.content) {
    return c.json({ error: 'validation_error', message: 'name and content are required' }, 400);
  }

  const id = crypto.randomUUID();
  const tags = JSON.stringify(body.tags || []);

  await c.env.DB.prepare(
    'INSERT INTO directives (id, bank_id, name, content, priority, is_active, tags) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, bankId, body.name, body.content, body.priority ?? 0, body.is_active !== false ? 1 : 0, tags).run();

  const directive = await c.env.DB.prepare('SELECT * FROM directives WHERE id = ?').bind(id).first();
  return c.json(formatDirective(directive as Record<string, unknown>), 201);
});

// GET /directives/:directive_id — get single directive
app.get('/:directive_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const directiveId = c.req.param('directive_id');

  const directive = await c.env.DB.prepare(
    'SELECT * FROM directives WHERE id = ? AND bank_id = ?'
  ).bind(directiveId, bankId).first();

  if (!directive) {
    return c.json({ error: 'not_found', message: 'Directive not found' }, 404);
  }

  return c.json(formatDirective(directive as Record<string, unknown>));
});

// PATCH /directives/:directive_id — update directive
app.patch('/:directive_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const directiveId = c.req.param('directive_id');
  const body = await c.req.json<{
    name?: string;
    content?: string;
    priority?: number;
    is_active?: boolean;
    tags?: string[];
  }>();

  const existing = await c.env.DB.prepare(
    'SELECT * FROM directives WHERE id = ? AND bank_id = ?'
  ).bind(directiveId, bankId).first();

  if (!existing) {
    return c.json({ error: 'not_found', message: 'Directive not found' }, 404);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
  if (body.content !== undefined) { updates.push('content = ?'); values.push(body.content); }
  if (body.priority !== undefined) { updates.push('priority = ?'); values.push(body.priority); }
  if (body.is_active !== undefined) { updates.push('is_active = ?'); values.push(body.is_active ? 1 : 0); }
  if (body.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(body.tags)); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(directiveId, bankId);

    await c.env.DB.prepare(
      `UPDATE directives SET ${updates.join(', ')} WHERE id = ? AND bank_id = ?`
    ).bind(...values).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM directives WHERE id = ?').bind(directiveId).first();
  return c.json(formatDirective(updated as Record<string, unknown>));
});

// DELETE /directives/:directive_id — delete directive
app.delete('/:directive_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const directiveId = c.req.param('directive_id');

  const result = await c.env.DB.prepare(
    'DELETE FROM directives WHERE id = ? AND bank_id = ?'
  ).bind(directiveId, bankId).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Directive not found' }, 404);
  }

  return c.json({ success: true, deleted: directiveId });
});

function formatDirective(row: Record<string, unknown>) {
  return {
    id: row.id,
    bank_id: row.bank_id,
    name: row.name,
    content: row.content,
    priority: row.priority,
    is_active: row.is_active === 1,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { app as directivesRoutes };
