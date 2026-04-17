/**
 * Bank management endpoints.
 *
 * These routes are mounted under /banks/:bank_id in index.ts,
 * so bank_id is already a param from the parent router.
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { BankProfileResponse, DispositionTraits } from '../types';

const app = new Hono<{ Bindings: Env }>();

// GET /profile — get bank profile
app.get('/profile', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const bank = await ensureBank(c.env.DB, bankId);

  const response: BankProfileResponse = {
    bank_id: bank.bank_id as string,
    name: (bank.name as string) || (bank.bank_id as string),
    disposition: JSON.parse(bank.disposition as string),
    mission: bank.mission as string,
    background: (bank.background as string) || null,
  };

  return c.json(response);
});

// PUT /profile — update full profile (disposition + mission)
app.put('/profile', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ disposition?: DispositionTraits; mission?: string }>();
  await ensureBank(c.env.DB, bankId);

  if (body.disposition) {
    const { skepticism, literalism, empathy } = body.disposition;
    if (
      [skepticism, literalism, empathy].some(
        (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 5,
      )
    ) {
      return c.json({ error: 'validation_error', message: 'Disposition traits must be numbers between 1 and 5' }, 400);
    }
    await c.env.DB.prepare(
      "UPDATE banks SET disposition = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
    )
      .bind(JSON.stringify(body.disposition), bankId)
      .run();
  }

  if (body.mission !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET mission = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
    )
      .bind(body.mission, bankId)
      .run();
  }

  return c.json({ success: true, bank_id: bankId });
});

// PUT /profile/disposition — update disposition
app.put('/profile/disposition', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ disposition: DispositionTraits }>();
  await ensureBank(c.env.DB, bankId);

  const { skepticism, literalism, empathy } = body.disposition;
  if (
    [skepticism, literalism, empathy].some(
      (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 5,
    )
  ) {
    return c.json({ error: 'validation_error', message: 'Disposition traits must be numbers between 1 and 5' }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE banks SET disposition = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(JSON.stringify(body.disposition), bankId)
    .run();

  return c.json({ success: true, disposition: body.disposition });
});

// PUT /profile/mission — set mission
app.put('/profile/mission', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ content: string }>();
  await ensureBank(c.env.DB, bankId);

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(body.content, bankId)
    .run();

  return c.json({ success: true, mission: body.content });
});

// POST /profile/background — merge into mission (deprecated route kept for compat)
app.post('/profile/background', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ content: string }>();
  const bank = await ensureBank(c.env.DB, bankId);

  const existingMission = bank.mission as string;
  const newMission = existingMission ? `${existingMission}\n\n${body.content}` : body.content;

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, background = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(newMission, body.content, bankId)
    .run();

  return c.json({ success: true, mission: newMission });
});

// GET /stats — bank statistics
app.get('/stats', async (c) => {
  const bankId = c.req.param('bank_id')!;
  await ensureBank(c.env.DB, bankId);

  const stats = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ?').bind(bankId),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'world'").bind(
      bankId,
    ),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'experience'").bind(
      bankId,
    ),
    c.env.DB.prepare("SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'").bind(
      bankId,
    ),
    c.env.DB.prepare(
      "SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'",
    ).bind(bankId),
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

// Default config values — resolved config = defaults merged with overrides
const CONFIG_DEFAULTS: Record<string, unknown> = {
  strategies: {},
};

function resolveConfig(overrides: Record<string, unknown>) {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

// GET /config — get bank config (resolved + overrides)
app.get('/config', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const bank = await ensureBank(c.env.DB, bankId);

  const overrides = JSON.parse(bank.config as string);
  return c.json({
    bank_id: bankId,
    config: resolveConfig(overrides),
    overrides,
  });
});

// PATCH /config — update bank config overrides (merge)
app.patch('/config', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<Record<string, unknown>>();
  const bank = await ensureBank(c.env.DB, bankId);

  const existingOverrides = JSON.parse(bank.config as string);
  const mergedOverrides = { ...existingOverrides, ...body };

  await c.env.DB.prepare(
    "UPDATE banks SET config = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(JSON.stringify(mergedOverrides), bankId)
    .run();

  return c.json({ bank_id: bankId, config: resolveConfig(mergedOverrides), overrides: mergedOverrides });
});

// DELETE /config — reset bank config overrides to defaults
app.delete('/config', async (c) => {
  const bankId = c.req.param('bank_id')!;
  await ensureBank(c.env.DB, bankId);

  await c.env.DB.prepare(
    "UPDATE banks SET config = '{}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(bankId)
    .run();

  return c.json({ bank_id: bankId, config: resolveConfig({}), overrides: {} });
});

/**
 * Ensure a bank exists, creating it with defaults if not.
 * This matches the original's auto-creation behavior.
 */
async function ensureBank(db: D1Database, bankId: string): Promise<Record<string, unknown>> {
  let bank = await db.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();

  if (!bank) {
    await db.prepare('INSERT INTO banks (bank_id, name) VALUES (?, ?)').bind(bankId, bankId).run();

    bank = await db.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  }

  return bank as Record<string, unknown>;
}

export { app as banksRoutes, ensureBank };
