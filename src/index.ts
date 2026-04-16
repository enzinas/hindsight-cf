/**
 * hindsight-cf — Cloudflare Workers port of hindsight memory system.
 *
 * Main entry point: Hono router with all API routes.
 * 100% API compatible with the original hindsight-api.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { bearerAuth } from './middleware/auth';

// Route modules
import { healthRoutes } from './routes/health';
import { banksRoutes } from './routes/banks';
import { memoriesRoutes } from './routes/memories';
import { entitiesRoutes } from './routes/entities';
import { documentsRoutes, chunksRoutes } from './routes/documents';
import { directivesRoutes } from './routes/directives';
import { mentalModelsRoutes } from './routes/mental-models';
import { operationsRoutes } from './routes/operations';
import { graphRoutes } from './routes/graph';
import { deleteVectorsBatched } from './vectorize-utils';
import { tagsRoutes } from './routes/tags';
import { filesRoutes } from './routes/files';
import { webhooksRoutes } from './routes/webhooks';
import { auditLogsRoutes } from './routes/audit-logs';
import { writeHttpMetric, writeOperationMetric } from './metrics';

const app = new Hono<{ Bindings: Env }>();

// HTTP metrics middleware — records every request to Analytics Engine
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  // Normalize path: strip UUIDs and numeric IDs to reduce cardinality
  const path = c.req.path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}');
  writeHttpMetric(c.env, c.req.method, path, c.res.status, Date.now() - start);
});

/** Format a bank row into the standard API response shape. */
function formatBank(row: Record<string, unknown>) {
  return {
    bank_id: row.bank_id as string,
    name: (row.name as string) || (row.bank_id as string),
    disposition: typeof row.disposition === 'string' ? JSON.parse(row.disposition) : row.disposition,
    mission: (row.mission as string) || '',
    background: (row.background as string) || null,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Global middleware
app.use('*', cors());

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'internal_error',
      message: 'An unexpected error occurred',
    },
    500,
  );
});

// =============================================================================
// Monitoring endpoints (no prefix)
// =============================================================================
app.route('/', healthRoutes);

// =============================================================================
// API routes — under /v1/:tenant/ (e.g. /v1/default/, /v1/acme/, etc.)
// =============================================================================
const api = new Hono<{ Bindings: Env }>();

// Auth middleware — protects all /v1/:tenant/* routes
api.use('*', bearerAuth());

// Banks (list) — GET /v1/default/banks
api.get('/banks', async (c) => {
  const results = await c.env.DB.prepare('SELECT * FROM banks ORDER BY created_at DESC').all();
  return c.json({
    banks: results.results.map((row: Record<string, unknown>) => formatBank(row)),
  });
});

// Banks (create) — POST /v1/default/banks
api.post('/banks', async (c) => {
  const body = await c.req.json<{ bank_id: string; name?: string }>();

  if (!body.bank_id || typeof body.bank_id !== 'string') {
    return c.json({ error: 'validation_error', message: 'bank_id is required' }, 400);
  }

  // Check if bank already exists
  const existing = await c.env.DB.prepare('SELECT bank_id FROM banks WHERE bank_id = ?')
    .bind(body.bank_id)
    .first();

  if (existing) {
    return c.json({ error: 'conflict', message: `Bank '${body.bank_id}' already exists` }, 409);
  }

  const name = body.name ?? body.bank_id;
  await c.env.DB.prepare('INSERT INTO banks (bank_id, name) VALUES (?, ?)')
    .bind(body.bank_id, name)
    .run();

  const bank = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?')
    .bind(body.bank_id)
    .first();

  return c.json(formatBank(bank as Record<string, unknown>), 201);
});

// Chunks — at top level: GET /v1/default/chunks/:chunk_id (not under banks)
api.route('/chunks', chunksRoutes);

// Bank-scoped routes
const bank = new Hono<{ Bindings: Env }>();

// PUT /banks/:bank_id — update bank
bank.put('/', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
    )
      .bind(body.name, bankId)
      .run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  return c.json(formatBank(updated as Record<string, unknown>));
});

// PATCH /banks/:bank_id — update bank
bank.patch('/', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
    )
      .bind(body.name, bankId)
      .run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  return c.json(formatBank(updated as Record<string, unknown>));
});

// DELETE /banks/:bank_id — delete bank
bank.delete('/', async (c) => {
  const bankId = c.req.param('bank_id')!;

  // Collect all memory unit IDs for this bank before deletion
  const rows = await c.env.DB.prepare('SELECT id FROM memory_units WHERE bank_id = ?')
    .bind(bankId)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort), then D1 (cascade handles child tables)
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  const result = await c.env.DB.prepare('DELETE FROM banks WHERE bank_id = ?').bind(bankId).run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }

  return c.json({ success: true, message: 'Deleted successfully', deleted_count: 1 });
});

// Memory operations — POST/DELETE /memories, POST /memories/recall, GET /memories/list, etc.
bank.route('/memories', memoriesRoutes);

// Reflect — POST /banks/{bank_id}/reflect
bank.post('/reflect', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<import('./types').ReflectRequest>();

  if (!body.query || typeof body.query !== 'string') {
    return c.json({ error: 'validation_error', message: 'query is required' }, 400);
  }

  const start = Date.now();
  try {
    const { reflect } = await import('./engine/reflect/agent');
    const result = await reflect(c.env, {
      query: body.query,
      bankId,
      budget: body.budget ?? 'mid',
      context: body.context,
      maxTokens: body.max_tokens,
      responseSchema: body.response_schema,
      tags: body.tags,
      tagsMatch: body.tags_match,
      includeFacts: body.include?.facts !== undefined,
      includeToolCalls: body.include?.tool_calls !== undefined,
      includeToolOutput: body.include?.tool_calls?.output ?? false,
    });

    writeOperationMetric(c.env, 'reflect', bankId, 'success', Date.now() - start);

    return c.json({
      text: result.text,
      based_on: result.basedOn,
      structured_output: result.structuredOutput,
      usage: result.usage
        ? {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
          }
        : null,
      trace: result.trace,
    });
  } catch (err) {
    writeOperationMetric(c.env, 'reflect', bankId, 'error', Date.now() - start);
    console.error('[reflect] Pipeline error:', err);
    return c.json(
      { error: 'reflect_error', message: err instanceof Error ? err.message : 'Reflect pipeline failed' },
      500,
    );
  }
});

// Entities — GET /entities, GET /entities/:id
bank.route('/entities', entitiesRoutes);

// Entity regenerate — POST /entities/:entity_id/regenerate
bank.post('/entities/:entity_id/regenerate', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const entityId = c.req.param('entity_id')!;

  try {
    const { regenerateEntity } = await import('./engine/entity-regenerate');
    const result = await regenerateEntity(c.env, bankId, entityId);
    return c.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'not_found', message: err.message }, 404);
    }
    console.error('[entity-regenerate] Error:', err);
    return c.json(
      { error: 'regenerate_error', message: err instanceof Error ? err.message : 'Entity regeneration failed' },
      500,
    );
  }
});

// Documents — GET /documents, GET /documents/:id, DELETE /documents/:id
bank.route('/documents', documentsRoutes);

// Directives — CRUD
bank.route('/directives', directivesRoutes);

// Mental Models — CRUD
bank.route('/mental-models', mentalModelsRoutes);

// Mental model refresh — POST /mental-models/:model_id/refresh
bank.post('/mental-models/:model_id/refresh', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const modelId = c.req.param('model_id')!;

  try {
    const { refreshMentalModel } = await import('./engine/mental-model-refresh');
    const result = await refreshMentalModel(c.env, bankId, modelId);
    return c.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'not_found', message: err.message }, 404);
    }
    console.error('[mental-model-refresh] Error:', err);
    return c.json(
      { error: 'refresh_error', message: err instanceof Error ? err.message : 'Mental model refresh failed' },
      500,
    );
  }
});

// Operations — GET /operations, GET /operations/:id, DELETE /operations/:id
bank.route('/operations', operationsRoutes);

// Graph — GET /graph
bank.route('/graph', graphRoutes);

// Tags — GET /tags
bank.route('/tags', tagsRoutes);

// Files — POST /files/retain
bank.route('/files', filesRoutes);

// Consolidation — POST /consolidate
bank.post('/consolidate', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req
    .json<{
      fact_types?: string[];
      tags?: string[];
      max_groups?: number;
      min_group_size?: number;
    }>()
    .catch(() => ({}) as { fact_types?: string[]; tags?: string[]; max_groups?: number; min_group_size?: number });

  const start = Date.now();
  try {
    const { consolidate } = await import('./engine/consolidate/orchestrator');
    const result = await consolidate(c.env, {
      bankId,
      factTypes: body.fact_types as import('./types').FactType[] | undefined,
      tags: body.tags,
      maxGroups: body.max_groups,
      minGroupSize: body.min_group_size,
    });

    writeOperationMetric(c.env, 'consolidate', bankId, 'success', Date.now() - start);

    return c.json({
      success: result.success,
      observation_count: result.observationCount,
      observation_ids: result.observationIds,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    });
  } catch (err) {
    writeOperationMetric(c.env, 'consolidate', bankId, 'error', Date.now() - start);
    console.error('[consolidate] Pipeline error:', err);
    return c.json(
      { error: 'consolidate_error', message: err instanceof Error ? err.message : 'Consolidation failed' },
      500,
    );
  }
});

// Webhooks — CRUD
bank.route('/webhooks', webhooksRoutes);

// Audit Logs — GET /audit-logs, GET /audit-logs/stats
bank.route('/audit-logs', auditLogsRoutes);

// GET /observations — list all observations
bank.get('/observations', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '100') || 100, 1000));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0') || 0);

  const results = await c.env.DB.prepare(
    "SELECT id, bank_id, text, proof_count, tags, source_memory_ids, history, created_at, updated_at FROM memory_units WHERE bank_id = ? AND fact_type = 'observation' ORDER BY created_at DESC LIMIT ? OFFSET ?",
  )
    .bind(bankId, limit, offset)
    .all();

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'",
  )
    .bind(bankId)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      bank_id: row.bank_id,
      text: row.text,
      proof_count: row.proof_count ?? 1,
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      source_memory_ids: row.source_memory_ids ? JSON.parse(row.source_memory_ids as string) : [],
      history: row.history ? JSON.parse(row.history as string) : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /observations/:model_id — get observations linked to a specific mental model
bank.get('/observations/:model_id', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const modelId = c.req.param('model_id')!;

  // First verify the model exists
  const model = await c.env.DB.prepare(
    "SELECT id FROM memory_units WHERE id = ? AND bank_id = ? AND fact_type = 'mental_model'",
  )
    .bind(modelId, bankId)
    .first();

  if (!model) {
    return c.json({ error: 'not_found', message: 'Mental model not found' }, 404);
  }

  // Find observations that reference this mental model in their source_memory_ids
  const observations = await c.env.DB.prepare(
    `SELECT id, text, proof_count, tags, source_memory_ids, created_at, updated_at
     FROM memory_units
     WHERE bank_id = ? AND fact_type = 'observation'
     ORDER BY created_at DESC`,
  )
    .bind(bankId)
    .all();

  // Filter to observations whose source_memory_ids include the model_id
  const linked = observations.results.filter((row: Record<string, unknown>) => {
    const sourceIds = row.source_memory_ids ? JSON.parse(row.source_memory_ids as string) : [];
    return sourceIds.includes(modelId);
  });

  return c.json({
    model_id: modelId,
    items: linked.map((row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      proof_count: row.proof_count ?? 1,
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      source_memory_ids: row.source_memory_ids ? JSON.parse(row.source_memory_ids as string) : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  });
});

// Observations — DELETE /observations (clear all observations)
bank.delete('/observations', async (c) => {
  const bankId = c.req.param('bank_id')!;

  const rows = await c.env.DB.prepare("SELECT id FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'")
    .bind(bankId)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort), then D1 rows
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  const result = await c.env.DB.prepare("DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'")
    .bind(bankId)
    .run();

  return c.json({ success: true, message: 'Deleted successfully', deleted_count: result.meta.changes });
});

// Background — POST /background (original: POST /banks/{bank_id}/background)
bank.post('/background', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<{ content: string }>();

  const { ensureBank } = await import('./routes/banks');
  const bankRow = await ensureBank(c.env.DB, bankId);
  const existingMission = bankRow.mission as string;
  const newMission = existingMission ? `${existingMission}\n\n${body.content}` : body.content;

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, background = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?",
  )
    .bind(newMission, body.content, bankId)
    .run();

  return c.json({ success: true, mission: newMission });
});

// POST /consolidation-recover — recover from failed/stuck consolidation operations
bank.post('/consolidation-recover', async (c) => {
  const bankId = c.req.param('bank_id')!;

  // Find stuck operations (processing for too long or failed consolidations)
  const stuck = await c.env.DB.prepare(
    "SELECT operation_id, status FROM async_operations WHERE bank_id = ? AND operation_type = 'consolidate' AND status IN ('processing', 'failed')",
  )
    .bind(bankId)
    .all();

  let recovered = 0;
  for (const op of stuck.results) {
    await c.env.DB.prepare(
      "UPDATE async_operations SET status = 'failed', error_message = 'Recovered via consolidation-recover endpoint', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE operation_id = ?",
    )
      .bind(op.operation_id)
      .run();
    recovered++;
  }

  return c.json({
    success: true,
    recovered_count: recovered,
    operation_ids: stuck.results.map((op: Record<string, unknown>) => op.operation_id),
  });
});

// GET /stats/memories-timeseries — memory creation timeseries
bank.get('/stats/memories-timeseries', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const period = c.req.query('period') || '7d';

  // Parse period to get the start date
  const periodDays = parseInt(period) || 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);
  const startDateStr = startDate.toISOString().split('T')[0];

  const results = await c.env.DB.prepare(
    `SELECT
       substr(created_at, 1, 10) as date,
       fact_type,
       COUNT(*) as count
     FROM memory_units
     WHERE bank_id = ? AND created_at >= ?
     GROUP BY substr(created_at, 1, 10), fact_type
     ORDER BY date ASC`,
  )
    .bind(bankId, startDateStr)
    .all();

  // Pivot into { date, world, experience, observation, mental_model, total }
  const dateMap: Record<string, Record<string, number>> = {};
  for (const row of results.results as Array<Record<string, unknown>>) {
    const date = row.date as string;
    if (!dateMap[date]) {
      dateMap[date] = { world: 0, experience: 0, observation: 0, mental_model: 0, total: 0 };
    }
    const count = row.count as number;
    dateMap[date][row.fact_type as string] = count;
    dateMap[date].total += count;
  }

  const timeseries = Object.entries(dateMap).map(([date, counts]) => ({
    date,
    ...counts,
  }));

  return c.json({
    bank_id: bankId,
    period,
    timeseries,
  });
});

// GET /export — export bank data as a template
bank.get('/export', async (c) => {
  const bankId = c.req.param('bank_id')!;

  const bank = await c.env.DB.prepare('SELECT * FROM banks WHERE bank_id = ?').bind(bankId).first();
  if (!bank) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }

  const [memories, entities, directives, documents] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM memory_units WHERE bank_id = ? ORDER BY created_at ASC').bind(bankId).all(),
    c.env.DB.prepare('SELECT * FROM entities WHERE bank_id = ? ORDER BY canonical_name ASC').bind(bankId).all(),
    c.env.DB.prepare('SELECT * FROM directives WHERE bank_id = ? ORDER BY priority DESC').bind(bankId).all(),
    c.env.DB.prepare('SELECT id, bank_id, content_hash, metadata, created_at FROM documents WHERE bank_id = ?').bind(bankId).all(),
  ]);

  return c.json({
    version: '1.0',
    exported_at: new Date().toISOString(),
    bank: formatBank(bank as Record<string, unknown>),
    memories: memories.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      context: row.context,
      event_date: row.event_date,
      fact_type: row.fact_type,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      proof_count: row.proof_count,
      source_memory_ids: row.source_memory_ids ? JSON.parse(row.source_memory_ids as string) : [],
      created_at: row.created_at,
    })),
    entities: entities.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      canonical_name: row.canonical_name,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      mention_count: row.mention_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    })),
    directives: directives.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      content: row.content,
      priority: row.priority,
      is_active: row.is_active === 1,
      tags: row.tags ? JSON.parse(row.tags as string) : [],
    })),
    documents: documents.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      content_hash: row.content_hash,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      created_at: row.created_at,
    })),
  });
});

// POST /import — import bank data from a template
bank.post('/import', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const dryRun = c.req.query('dry_run') === 'true';
  const template = await c.req.json<{
    version?: string;
    bank?: Record<string, unknown>;
    memories?: Array<Record<string, unknown>>;
    entities?: Array<Record<string, unknown>>;
    directives?: Array<Record<string, unknown>>;
  }>();

  // Validate import size limits
  const MAX_IMPORT_MEMORIES = 10000;
  const MAX_IMPORT_ENTITIES = 5000;
  const MAX_IMPORT_DIRECTIVES = 500;

  if (template.memories && template.memories.length > MAX_IMPORT_MEMORIES) {
    return c.json({ error: 'validation_error', message: `memories array exceeds maximum of ${MAX_IMPORT_MEMORIES}` }, 400);
  }
  if (template.entities && template.entities.length > MAX_IMPORT_ENTITIES) {
    return c.json({ error: 'validation_error', message: `entities array exceeds maximum of ${MAX_IMPORT_ENTITIES}` }, 400);
  }
  if (template.directives && template.directives.length > MAX_IMPORT_DIRECTIVES) {
    return c.json({ error: 'validation_error', message: `directives array exceeds maximum of ${MAX_IMPORT_DIRECTIVES}` }, 400);
  }

  const summary = {
    bank_updated: false,
    memories_imported: 0,
    entities_imported: 0,
    directives_imported: 0,
  };

  if (dryRun) {
    // Just count what would be imported
    if (template.bank) summary.bank_updated = true;
    summary.memories_imported = template.memories?.length ?? 0;
    summary.entities_imported = template.entities?.length ?? 0;
    summary.directives_imported = template.directives?.length ?? 0;

    return c.json({ dry_run: true, summary });
  }

  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);

  // Import bank profile
  if (template.bank) {
    const b = template.bank;
    if (b.disposition || b.mission) {
      const updates: string[] = [];
      const vals: unknown[] = [];
      if (b.disposition) {
        updates.push('disposition = ?');
        vals.push(typeof b.disposition === 'string' ? b.disposition : JSON.stringify(b.disposition));
      }
      if (b.mission) {
        updates.push('mission = ?');
        vals.push(b.mission);
      }
      if (b.name) {
        updates.push('name = ?');
        vals.push(b.name);
      }
      updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
      vals.push(bankId);
      await c.env.DB.prepare(`UPDATE banks SET ${updates.join(', ')} WHERE bank_id = ?`)
        .bind(...vals)
        .run();
      summary.bank_updated = true;
    }
  }

  // Import directives
  if (template.directives) {
    for (const d of template.directives) {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        'INSERT INTO directives (id, bank_id, name, content, priority, is_active, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, bankId, d.name, d.content, d.priority ?? 0, d.is_active !== false ? 1 : 0, JSON.stringify(d.tags ?? []))
        .run();
      summary.directives_imported++;
    }
  }

  // Import entities
  if (template.entities) {
    for (const e of template.entities) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO entities (id, canonical_name, bank_id, metadata, mention_count) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(e.id ?? crypto.randomUUID(), e.canonical_name, bankId, JSON.stringify(e.metadata ?? {}), e.mention_count ?? 1)
        .run();
      summary.entities_imported++;
    }
  }

  // Import memories (without re-embedding — raw import)
  if (template.memories) {
    for (const m of template.memories) {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO memory_units (id, bank_id, text, context, event_date, fact_type, metadata, tags, proof_count, source_memory_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          m.id ?? crypto.randomUUID(),
          bankId,
          m.text,
          m.context ?? '',
          m.event_date ?? new Date().toISOString(),
          m.fact_type ?? 'world',
          JSON.stringify(m.metadata ?? {}),
          JSON.stringify(m.tags ?? []),
          m.proof_count ?? 1,
          JSON.stringify(m.source_memory_ids ?? []),
        )
        .run();
      summary.memories_imported++;
    }
  }

  return c.json({ dry_run: false, summary });
});

// Bank profile & config (sub-routes of banks)
bank.route('/', banksRoutes);

// Mount bank routes under /banks/:bank_id
api.route('/banks/:bank_id', bank);

// Mount API under /v1/:tenant (e.g. /v1/default, /v1/acme, etc.)
app.route('/v1/:tenant', api);

// GET /v1/bank-template-schema — JSON Schema for the bank template manifest format
// Global route (not tenant-scoped), used to validate template manifests before importing.
app.get('/v1/bank-template-schema', (c) => {
  return c.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'BankTemplateManifest',
    description:
      'A bank template manifest for import/export. Version field enables forward-compatible schema evolution.',
    type: 'object',
    required: ['version'],
    properties: {
      version: { type: 'string', description: "Manifest schema version (currently '1')" },
      bank: {
        type: 'object',
        description: 'Bank configuration fields (per-bank, no credentials)',
        properties: {
          reflect_mission: { type: ['string', 'null'], description: 'Mission/context for Reflect operations' },
          retain_mission: { type: ['string', 'null'], description: 'Steers what gets extracted during retain' },
          retain_extraction_mode: {
            type: ['string', 'null'],
            description: "Fact extraction mode: 'concise' (default), 'verbose', or 'custom'",
          },
          retain_custom_instructions: {
            type: ['string', 'null'],
            description: "Custom extraction prompt (when mode='custom')",
          },
          retain_chunk_size: { type: ['integer', 'null'], description: 'Max token size for each content chunk' },
          enable_observations: { type: ['boolean', 'null'], description: 'Toggle observation consolidation' },
          observations_mission: { type: ['string', 'null'], description: 'Controls what gets synthesised' },
          disposition_skepticism: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 5,
            description: 'Skepticism trait (1-5)',
          },
          disposition_literalism: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 5,
            description: 'Literalism trait (1-5)',
          },
          disposition_empathy: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 5,
            description: 'Empathy trait (1-5)',
          },
          entity_labels: {
            type: ['array', 'null'],
            items: { type: 'object' },
            description: 'Controlled vocabulary for entity labels',
          },
          entities_allow_free_form: {
            type: ['boolean', 'null'],
            description: 'Allow entities outside the label vocabulary',
          },
          retain_default_strategy: {
            type: ['string', 'null'],
            description: 'Name of the default retain strategy',
          },
          retain_strategies: {
            type: ['object', 'null'],
            description: 'Map of retain strategy name to per-strategy config dict',
          },
          retain_chunk_batch_size: {
            type: ['integer', 'null'],
            description: 'Max chunks per streaming batch (0 disables batching)',
          },
          mcp_enabled_tools: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'MCP tool allowlist for this bank (null = all tools)',
          },
          consolidation_llm_batch_size: {
            type: ['integer', 'null'],
            description: 'LLM batch size for observation consolidation',
          },
        },
        additionalProperties: false,
      },
      mental_models: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          required: ['id', 'name', 'source_query'],
          properties: {
            id: {
              type: 'string',
              pattern: '^[a-z0-9][a-z0-9-]*$',
              description: 'Unique ID (alphanumeric lowercase with hyphens)',
            },
            name: { type: 'string', description: 'Human-readable name' },
            source_query: { type: 'string', description: 'Query to generate content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for scoped visibility' },
            max_tokens: {
              type: 'integer',
              minimum: 256,
              maximum: 8192,
              default: 2048,
              description: 'Maximum tokens for generated content',
            },
            trigger: {
              type: 'object',
              properties: {
                refresh_after_consolidation: { type: 'boolean' },
              },
              description: 'Trigger settings',
            },
          },
        },
      },
      directives: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          required: ['name', 'content'],
          properties: {
            name: { type: 'string', description: 'Directive name (match key on re-import)' },
            content: { type: 'string', description: 'Directive text to inject into prompts' },
            priority: { type: 'integer', default: 0, description: 'Higher priority = injected first' },
            is_active: { type: 'boolean', default: true, description: 'Whether this directive is active' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
          },
        },
      },
    },
    additionalProperties: false,
    example: {
      version: '1',
      bank: {
        reflect_mission: 'You are helping a support agent remember customer interactions.',
        retain_mission: 'Extract customer issues, resolutions, and sentiment.',
        disposition_empathy: 5,
        enable_observations: true,
      },
      mental_models: [
        {
          id: 'sentiment-overview',
          name: 'Customer Sentiment Overview',
          source_query: 'What is the overall sentiment trend?',
          trigger: { refresh_after_consolidation: true },
        },
      ],
      directives: [
        {
          name: 'Always be empathetic',
          content: 'Always respond with empathy and understanding.',
          priority: 10,
        },
      ],
    },
  });
});

// =============================================================================
// Queue consumer (for async operations)
// =============================================================================
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const payload = message.body as {
        operation_id: string;
        operation_type: string;
        bank_id: string;
        task_payload: Record<string, unknown>;
      };

      console.log(`[queue] Processing ${payload.operation_type} operation ${payload.operation_id}`);

      try {
        // Mark operation as processing
        await env.DB.prepare(
          "UPDATE async_operations SET status = 'processing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE operation_id = ?",
        )
          .bind(payload.operation_id)
          .run();

        let resultMetadata: Record<string, unknown> = {};

        switch (payload.operation_type) {
          case 'retain': {
            const { retainBatch } = await import('./engine/retain/orchestrator');
            const items = (payload.task_payload.items ?? []) as Array<{
              content: string;
              context?: string;
              timestamp?: string;
              metadata?: Record<string, string>;
              entities?: Array<{ text: string; type?: string }>;
              tags?: string[];
            }>;
            const contents = items.map((item) => ({
              content: item.content,
              context: item.context ?? '',
              eventDate: item.timestamp ?? new Date().toISOString(),
              metadata: item.metadata ?? {},
              entities: (item.entities ?? []).map((e) => ({ text: e.text, type: e.type ?? 'CONCEPT' })),
              tags: item.tags ?? [],
            }));
            const result = await retainBatch(env, payload.bank_id, contents, {
              documentId: payload.task_payload.document_id as string | undefined,
              documentTags: (payload.task_payload.document_tags ?? []) as string[],
            });
            resultMetadata = {
              items_count: items.length,
              facts_stored: result.unitIdsByContent.flat().length,
              usage: result.usage,
            };
            break;
          }

          case 'consolidate': {
            const { consolidate } = await import('./engine/consolidate/orchestrator');
            const result = await consolidate(env, {
              bankId: payload.bank_id,
              factTypes: payload.task_payload.fact_types as import('./types').FactType[] | undefined,
              tags: payload.task_payload.tags as string[] | undefined,
            });
            resultMetadata = {
              observation_count: result.observationCount,
              observation_ids: result.observationIds,
              usage: result.usage,
            };
            break;
          }

          case 'entity_regenerate': {
            const { regenerateEntity } = await import('./engine/entity-regenerate');
            const result = await regenerateEntity(env, payload.bank_id, payload.task_payload.entity_id as string);
            resultMetadata = { ...result };
            break;
          }

          case 'mental_model_refresh': {
            const { refreshMentalModel } = await import('./engine/mental-model-refresh');
            const result = await refreshMentalModel(env, payload.bank_id, payload.task_payload.model_id as string);
            resultMetadata = { ...result };
            break;
          }

          default:
            console.warn(`[queue] Unknown operation type: ${payload.operation_type}`);
            resultMetadata = { error: `Unknown operation type: ${payload.operation_type}` };
        }

        // Mark operation as completed
        await env.DB.prepare(
          "UPDATE async_operations SET status = 'completed', result_metadata = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE operation_id = ?",
        )
          .bind(JSON.stringify(resultMetadata), payload.operation_id)
          .run();

        message.ack();
      } catch (err) {
        console.error(`[queue] Error processing ${payload.operation_type}:`, err);

        // Mark operation as failed
        await env.DB.prepare(
          "UPDATE async_operations SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE operation_id = ?",
        )
          .bind(err instanceof Error ? err.message : 'Unknown error', payload.operation_id)
          .run();

        message.retry();
      }
    }
  },
};

export { app };
