/**
 * Bank template export/import endpoints — aligned with upstream BankTemplateManifest.
 *
 * GET  /export          — export bank config, mental models, directives as template
 * POST /import?dry_run  — import a template manifest (upsert by id/name)
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type {
  BankTemplateManifest,
  BankTemplateConfig,
  BankTemplateMentalModel,
  BankTemplateDirective,
  BankTemplateImportResponse,
} from '../types';

const CURRENT_VERSION = '1';

const app = new Hono<{ Bindings: Env }>();

// ─── Export ────────────────────────────────────────────────────────────────────

app.get('/export', async (c) => {
  const bankId = c.req.param('bank_id')!;

  const bank = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  if (!bank) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }

  // Build BankTemplateConfig from bank columns + config JSON
  const disposition = JSON.parse((bank.disposition as string) || '{}');
  const configOverrides = JSON.parse((bank.config as string) || '{}');

  const bankConfig: BankTemplateConfig = {};
  if (bank.mission) bankConfig.reflect_mission = bank.mission as string;
  if (disposition.skepticism != null) bankConfig.disposition_skepticism = disposition.skepticism;
  if (disposition.literalism != null) bankConfig.disposition_literalism = disposition.literalism;
  if (disposition.empathy != null) bankConfig.disposition_empathy = disposition.empathy;

  // Map config overrides to template fields
  const configFields: (keyof BankTemplateConfig)[] = [
    'retain_mission', 'retain_extraction_mode', 'retain_custom_instructions',
    'retain_chunk_size', 'enable_observations', 'observations_mission',
    'entity_labels', 'entities_allow_free_form', 'retain_default_strategy',
    'retain_strategies', 'retain_chunk_batch_size', 'mcp_enabled_tools',
    'consolidation_llm_batch_size', 'consolidation_source_facts_max_tokens',
    'consolidation_source_facts_max_tokens_per_observation',
    'max_observations_per_scope', 'reflect_source_facts_max_tokens',
  ];
  for (const key of configFields) {
    if (configOverrides[key] != null) {
      (bankConfig as Record<string, unknown>)[key] = configOverrides[key];
    }
  }

  const hasConfig = Object.keys(bankConfig).length > 0;

  // Mental models
  const mmRows = await c.env.DB.prepare(
    "SELECT id, text, context, tags, metadata FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model' ORDER BY created_at ASC",
  )
    .bind(bankId)
    .all();

  const mentalModels: BankTemplateMentalModel[] = mmRows.results.map((row: Record<string, unknown>) => {
    const meta = row.metadata ? JSON.parse(row.metadata as string) : {};
    const tags = row.tags ? JSON.parse(row.tags as string) : [];
    return {
      id: row.id as string,
      name: row.text as string,
      source_query: (row.context as string) || '',
      ...(tags.length > 0 ? { tags } : {}),
      ...(meta.max_tokens ? { max_tokens: meta.max_tokens } : {}),
      ...(meta.trigger ? { trigger: meta.trigger } : {}),
    };
  });

  // Directives
  const dirRows = await c.env.DB.prepare(
    'SELECT name, content, priority, is_active, tags FROM directives WHERE bank_id = ? ORDER BY priority DESC, created_at ASC',
  )
    .bind(bankId)
    .all();

  const directives: BankTemplateDirective[] = dirRows.results.map((row: Record<string, unknown>) => ({
    name: row.name as string,
    content: row.content as string,
    priority: row.priority as number,
    is_active: row.is_active === 1,
    tags: row.tags ? JSON.parse(row.tags as string) : [],
  }));

  const manifest: BankTemplateManifest = {
    version: CURRENT_VERSION,
    ...(hasConfig ? { bank: bankConfig } : {}),
    ...(mentalModels.length > 0 ? { mental_models: mentalModels } : {}),
    ...(directives.length > 0 ? { directives } : {}),
  };

  return c.json(manifest);
});

// ─── Import ────────────────────────────────────────────────────────────────────

app.post('/import', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const dryRun = c.req.query('dry_run') === 'true';

  const manifest = await c.req.json<BankTemplateManifest>();

  // ── Validation ──────────────────────────────────────────────────────────────
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    return c.json(
      { error: 'validation_error', message: `Template validation failed: ${errors.join('; ')}` },
      400,
    );
  }

  // ── Dry run ─────────────────────────────────────────────────────────────────
  if (dryRun) {
    const existingMM = await c.env.DB.prepare(
      "SELECT id FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'",
    )
      .bind(bankId)
      .all();
    const existingMMIds = new Set(existingMM.results.map((r: Record<string, unknown>) => r.id as string));

    const existingDir = await c.env.DB.prepare('SELECT name FROM directives WHERE bank_id = ?')
      .bind(bankId)
      .all();
    const existingDirNames = new Set(existingDir.results.map((r: Record<string, unknown>) => r.name as string));

    const mmCreated: string[] = [];
    const mmUpdated: string[] = [];
    for (const mm of manifest.mental_models ?? []) {
      (existingMMIds.has(mm.id) ? mmUpdated : mmCreated).push(mm.id);
    }

    const dirCreated: string[] = [];
    const dirUpdated: string[] = [];
    for (const d of manifest.directives ?? []) {
      (existingDirNames.has(d.name) ? dirUpdated : dirCreated).push(d.name);
    }

    const response: BankTemplateImportResponse = {
      bank_id: bankId,
      config_applied: manifest.bank != null,
      mental_models_created: mmCreated,
      mental_models_updated: mmUpdated,
      directives_created: dirCreated,
      directives_updated: dirUpdated,
      operation_ids: [],
      dry_run: true,
    };
    return c.json(response);
  }

  // ── Ensure bank exists ──────────────────────────────────────────────────────
  const { ensureBank } = await import('./banks');
  await ensureBank(c.env.DB, bankId);

  // ── Apply bank config ───────────────────────────────────────────────────────
  let configApplied = false;
  if (manifest.bank) {
    const bc = manifest.bank;
    const updates: string[] = [];
    const vals: unknown[] = [];

    // Disposition fields → banks.disposition column
    const currentBank = await c.env.DB.prepare('SELECT disposition, config FROM banks WHERE bank_id = ?')
      .bind(bankId)
      .first();
    const disposition = currentBank ? JSON.parse((currentBank.disposition as string) || '{}') : {};
    let dispositionChanged = false;
    if (bc.disposition_skepticism != null) { disposition.skepticism = bc.disposition_skepticism; dispositionChanged = true; }
    if (bc.disposition_literalism != null) { disposition.literalism = bc.disposition_literalism; dispositionChanged = true; }
    if (bc.disposition_empathy != null) { disposition.empathy = bc.disposition_empathy; dispositionChanged = true; }
    if (dispositionChanged) {
      updates.push('disposition = ?');
      vals.push(JSON.stringify(disposition));
    }

    // reflect_mission → banks.mission column
    if (bc.reflect_mission != null) {
      updates.push('mission = ?');
      vals.push(bc.reflect_mission);
    }

    // Remaining config fields → banks.config JSON column (merge)
    const existingConfig = currentBank ? JSON.parse((currentBank.config as string) || '{}') : {};
    const configFields: (keyof BankTemplateConfig)[] = [
      'retain_mission', 'retain_extraction_mode', 'retain_custom_instructions',
      'retain_chunk_size', 'enable_observations', 'observations_mission',
      'entity_labels', 'entities_allow_free_form', 'retain_default_strategy',
      'retain_strategies', 'retain_chunk_batch_size', 'mcp_enabled_tools',
      'consolidation_llm_batch_size', 'consolidation_source_facts_max_tokens',
      'consolidation_source_facts_max_tokens_per_observation',
      'max_observations_per_scope', 'reflect_source_facts_max_tokens',
    ];
    let configChanged = false;
    for (const key of configFields) {
      if (bc[key] != null) {
        existingConfig[key] = bc[key];
        configChanged = true;
      }
    }
    if (configChanged) {
      updates.push('config = ?');
      vals.push(JSON.stringify(existingConfig));
    }

    if (updates.length > 0) {
      updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(bankId);
      await c.env.DB.prepare(`UPDATE banks SET ${updates.join(', ')} WHERE bank_id = ?`)
        .bind(...vals)
        .run();
      configApplied = true;
    }
  }

  // ── Mental models (upsert by ID) ───────────────────────────────────────────
  const mmCreated: string[] = [];
  const mmUpdated: string[] = [];

  if (manifest.mental_models) {
    const existing = await c.env.DB.prepare(
      "SELECT id FROM memory_units WHERE bank_id = ? AND fact_type = 'mental_model'",
    )
      .bind(bankId)
      .all();
    const existingIds = new Set(existing.results.map((r: Record<string, unknown>) => r.id as string));

    for (const mm of manifest.mental_models) {
      const meta: Record<string, unknown> = {};
      if (mm.max_tokens) meta.max_tokens = mm.max_tokens;
      if (mm.trigger) meta.trigger = mm.trigger;
      const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '{}';
      const tagsJson = JSON.stringify(mm.tags ?? []);

      if (existingIds.has(mm.id)) {
        await c.env.DB.prepare(
          "UPDATE memory_units SET text = ?, context = ?, tags = ?, metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND bank_id = ?",
        )
          .bind(mm.name, mm.source_query, tagsJson, metaJson, mm.id, bankId)
          .run();
        mmUpdated.push(mm.id);
      } else {
        await c.env.DB.prepare(
          "INSERT INTO memory_units (id, bank_id, text, context, fact_type, event_date, tags, metadata) VALUES (?, ?, ?, ?, 'mental_model', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)",
        )
          .bind(mm.id, bankId, mm.name, mm.source_query, tagsJson, metaJson)
          .run();
        mmCreated.push(mm.id);
      }
    }
  }

  // ── Directives (upsert by name) ────────────────────────────────────────────
  const dirCreated: string[] = [];
  const dirUpdated: string[] = [];

  if (manifest.directives) {
    const existing = await c.env.DB.prepare('SELECT id, name FROM directives WHERE bank_id = ?')
      .bind(bankId)
      .all();
    const existingByName = new Map<string, string>();
    for (const r of existing.results) {
      existingByName.set(r.name as string, r.id as string);
    }

    for (const d of manifest.directives) {
      const tagsJson = JSON.stringify(d.tags ?? []);
      const existingId = existingByName.get(d.name);

      if (existingId) {
        await c.env.DB.prepare(
          "UPDATE directives SET content = ?, priority = ?, is_active = ?, tags = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND bank_id = ?",
        )
          .bind(d.content, d.priority ?? 0, d.is_active !== false ? 1 : 0, tagsJson, existingId, bankId)
          .run();
        dirUpdated.push(d.name);
      } else {
        const id = crypto.randomUUID();
        await c.env.DB.prepare(
          'INSERT INTO directives (id, bank_id, name, content, priority, is_active, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
          .bind(id, bankId, d.name, d.content, d.priority ?? 0, d.is_active !== false ? 1 : 0, tagsJson)
          .run();
        dirCreated.push(d.name);
      }
    }
  }

  const response: BankTemplateImportResponse = {
    bank_id: bankId,
    config_applied: configApplied,
    mental_models_created: mmCreated,
    mental_models_updated: mmUpdated,
    directives_created: dirCreated,
    directives_updated: dirUpdated,
    operation_ids: [],
    dry_run: false,
  };
  return c.json(response);
});

// ─── Validation ────────────────────────────────────────────────────────────────

function validateManifest(m: BankTemplateManifest): string[] {
  const errors: string[] = [];

  // Version
  if (!m.version) {
    errors.push('version is required');
  } else {
    const ver = parseInt(m.version, 10);
    if (isNaN(ver)) errors.push(`version must be a numeric string, got '${m.version}'`);
    else if (ver < 1) errors.push('version must be >= 1');
    else if (ver > parseInt(CURRENT_VERSION, 10))
      errors.push(`version '${m.version}' is not supported (max: ${CURRENT_VERSION}). Please upgrade Hindsight.`);
  }

  // Bank config
  if (m.bank) {
    const bc = m.bank;
    if (bc.retain_extraction_mode != null) {
      const valid = ['concise', 'verbose', 'custom', 'chunks'];
      if (!valid.includes(bc.retain_extraction_mode))
        errors.push(`bank.retain_extraction_mode: must be one of [${valid.join(', ')}], got '${bc.retain_extraction_mode}'`);
    }
    if (bc.retain_custom_instructions && bc.retain_extraction_mode !== 'custom')
      errors.push("bank.retain_custom_instructions: requires retain_extraction_mode='custom'");

    for (const trait of ['disposition_skepticism', 'disposition_literalism', 'disposition_empathy'] as const) {
      const v = bc[trait];
      if (v != null && (typeof v !== 'number' || v < 1 || v > 5))
        errors.push(`bank.${trait}: must be a number between 1 and 5`);
    }
  }

  // Mental models — unique IDs, non-empty fields
  if (m.mental_models) {
    const ids = m.mental_models.map((mm) => mm.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) errors.push(`Duplicate mental model ids: [${[...new Set(dupes)].join(', ')}]`);

    m.mental_models.forEach((mm, i) => {
      if (!mm.name?.trim()) errors.push(`mental_models[${i}].name: must not be empty`);
      if (!mm.source_query?.trim()) errors.push(`mental_models[${i}].source_query: must not be empty`);
    });
  }

  // Directives — unique names, non-empty fields
  if (m.directives) {
    const names = m.directives.map((d) => d.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) errors.push(`Duplicate directive names: [${[...new Set(dupes)].join(', ')}]`);

    m.directives.forEach((d, i) => {
      if (!d.name?.trim()) errors.push(`directives[${i}].name: must not be empty`);
      if (!d.content?.trim()) errors.push(`directives[${i}].content: must not be empty`);
    });
  }

  return errors;
}

export { app as bankTemplatesRoutes };
