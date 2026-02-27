/**
 * Bank management endpoints.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { BankProfileResponse, DispositionTraits } from '../types';

const app = new Hono<{ Bindings: Env }>();

// GET /banks — list all banks
app.get('/', async (c) => {
  const results = await c.env.DB.prepare('SELECT bank_id FROM banks ORDER BY created_at DESC').all();
  return c.json({
    banks: results.results.map((row: Record<string, unknown>) => row.bank_id as string),
  });
});

// GET /banks/:bank_id/profile — get bank profile
app.get('/:bank_id/profile', async (c) => {
  const bankId = c.req.param('bank_id');
  const bank = await ensureBank(c.env.DB, bankId);

  const response: BankProfileResponse = {
    bank_id: bank.bank_id as string,
    name: (bank.name as string) || (bank.bank_id as string),
    disposition: JSON.parse(bank.disposition as string),
    mission: bank.mission as string,
    background: bank.background as string || null,
  };

  return c.json(response);
});

// PATCH /banks/:bank_id — update bank
app.patch('/:bank_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ name?: string }>();
  await ensureBank(c.env.DB, bankId);

  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
    ).bind(body.name, bankId).run();
  }

  return c.json({ success: true, bank_id: bankId });
});

// DELETE /banks/:bank_id — delete bank
app.delete('/:bank_id', async (c) => {
  const bankId = c.req.param('bank_id');

  const result = await c.env.DB.prepare('DELETE FROM banks WHERE bank_id = ?').bind(bankId).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }

  // TODO: Also clean up Vectorize vectors for this bank
  return c.json({ success: true, deleted: bankId });
});

// GET /banks/:bank_id/stats — bank statistics
app.get('/:bank_id/stats', async (c) => {
  const bankId = c.req.param('bank_id');
  await ensureBank(c.env.DB, bankId);

  const stats = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ?').bind(bankId),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'world'").bind(bankId),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'experience'").bind(bankId),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'").bind(bankId),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'").bind(bankId),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM entities WHERE bank_id = ?').bind(bankId),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM documents WHERE bank_id = ?').bind(bankId),
    c.env.DB.prepare('SELECT COUNT(*) as total FROM directives WHERE bank_id = ?').bind(bankId),
  ]);

  return c.json({
    bank_id: bankId,
    memories: {
      total: (stats[0].results[0] as Record<string, unknown>).total,
      world: (stats[1].results[0] as Record<string, unknown>).total,
      experience: (stats[2].results[0] as Record<string, unknown>).total,
      observation: (stats[3].results[0] as Record<string, unknown>).total,
      mental_model: (stats[4].results[0] as Record<string, unknown>).total,
    },
    entities: (stats[5].results[0] as Record<string, unknown>).total,
    documents: (stats[6].results[0] as Record<string, unknown>).total,
    directives: (stats[7].results[0] as Record<string, unknown>).total,
  });
});

// GET /banks/:bank_id/config — get bank config
app.get('/:bank_id/config', async (c) => {
  const bankId = c.req.param('bank_id');
  const bank = await ensureBank(c.env.DB, bankId);

  return c.json({
    bank_id: bankId,
    config: JSON.parse(bank.config as string),
  });
});

// PATCH /banks/:bank_id/config — update bank config
app.patch('/:bank_id/config', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<Record<string, unknown>>();
  const bank = await ensureBank(c.env.DB, bankId);

  const existingConfig = JSON.parse(bank.config as string);
  const mergedConfig = { ...existingConfig, ...body };

  await c.env.DB.prepare(
    "UPDATE banks SET config = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(JSON.stringify(mergedConfig), bankId).run();

  return c.json({ bank_id: bankId, config: mergedConfig });
});

// PUT /banks/:bank_id/profile/disposition — update disposition
app.put('/:bank_id/profile/disposition', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ disposition: DispositionTraits }>();
  await ensureBank(c.env.DB, bankId);

  const { skepticism, literalism, empathy } = body.disposition;
  if ([skepticism, literalism, empathy].some((v) => v < 1 || v > 5)) {
    return c.json({ error: 'validation_error', message: 'Disposition traits must be between 1 and 5' }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE banks SET disposition = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(JSON.stringify(body.disposition), bankId).run();

  return c.json({ success: true, disposition: body.disposition });
});

// POST /banks/:bank_id/profile/background — merge into mission
app.post('/:bank_id/profile/background', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ content: string }>();
  const bank = await ensureBank(c.env.DB, bankId);

  const existingMission = bank.mission as string;
  const newMission = existingMission ? `${existingMission}\n\n${body.content}` : body.content;

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, background = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(newMission, body.content, bankId).run();

  return c.json({ success: true, mission: newMission });
});

// PUT /banks/:bank_id/profile/mission — set mission
app.put('/:bank_id/profile/mission', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ content: string }>();
  await ensureBank(c.env.DB, bankId);

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(body.content, bankId).run();

  return c.json({ success: true, mission: body.content });
});

/**
 * Ensure a bank exists, creating it with defaults if not.
 * This matches the original's auto-creation behavior.
 */
async function ensureBank(db: D1Database, bankId: string): Promise<Record<string, unknown>> {
  let bank = await db.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();

  if (!bank) {
    await db.prepare(
      'INSERT INTO banks (bank_id, name) VALUES (?, ?)'
    ).bind(bankId, bankId).run();

    bank = await db.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  }

  return bank as Record<string, unknown>;
}

export { app as banksRoutes, ensureBank };
