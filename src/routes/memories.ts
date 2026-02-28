/**
 * Memory endpoints: retain, recall, list, get, delete.
 *
 * Route mapping to original:
 *   POST   /banks/{bank_id}/memories          — retain memories
 *   POST   /banks/{bank_id}/memories/recall    — recall memories
 *   GET    /banks/{bank_id}/memories/list      — list memory units
 *   GET    /banks/{bank_id}/memories/{id}      — get memory unit
 *   DELETE /banks/{bank_id}/memories/{id}      — delete memory unit
 *   DELETE /banks/{bank_id}/memories           — clear bank memories
 *   DELETE /banks/{bank_id}/memories/{id}/observations — delete memory observations
 */
import { Hono } from 'hono';
import type { Env } from '../env';
import type { RetainRequest, RecallRequest } from '../types';
import { retainBatch } from '../engine/retain/orchestrator';
import type { RetainContent } from '../engine/retain/types';
import { recall } from '../engine/recall/orchestrator';
import { BUDGET_LIMITS } from '../engine/recall/types';
import type { FactType } from '../types';
import { deleteVectorsBatched } from '../vectorize-utils';

const app = new Hono<{ Bindings: Env }>();

// POST /memories — retain memories (original: POST /banks/{bank_id}/memories)
app.post('/', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<RetainRequest>();

  // Validate request
  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: 'validation_error', message: 'items is required and must be non-empty' }, 400);
  }

  // Convert RetainItem[] to RetainContent[]
  const contents: RetainContent[] = body.items.map((item) => ({
    content: item.content,
    context: item.context ?? '',
    eventDate: item.timestamp ?? new Date().toISOString(),
    metadata: item.metadata ?? {},
    entities: (item.entities ?? []).map((e) => ({ text: e.text, type: e.type ?? 'CONCEPT' })),
    tags: item.tags ?? [],
  }));

  // Determine document_id: use the first item's document_id or generate one
  const documentId = body.items.find((i) => i.document_id)?.document_id ?? undefined;

  // Async mode: enqueue to Cloudflare Queue
  if (body.async) {
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      `INSERT INTO async_operations (operation_id, bank_id, operation_type, status, created_at, updated_at, task_payload)
       VALUES (?, ?, 'retain', 'pending', ?, ?, ?)`,
    )
      .bind(
        operationId,
        bankId,
        now,
        now,
        JSON.stringify({
          items: body.items,
          document_id: documentId,
          document_tags: body.document_tags ?? [],
        }),
      )
      .run();

    await c.env.QUEUE.send({
      operation_id: operationId,
      operation_type: 'retain',
      bank_id: bankId,
      task_payload: {
        items: body.items,
        document_id: documentId,
        document_tags: body.document_tags ?? [],
      },
    });

    return c.json({
      success: true,
      bank_id: bankId,
      items_count: body.items.length,
      async: true,
      operation_id: operationId,
      usage: null,
    });
  }

  try {
    const result = await retainBatch(c.env, bankId, contents, {
      documentId,
      documentTags: body.document_tags ?? [],
    });

    return c.json({
      success: true,
      bank_id: bankId,
      items_count: body.items.length,
      async: false,
      operation_id: null,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    });
  } catch (err) {
    console.error('[retain] Pipeline error:', err);
    return c.json(
      { error: 'retain_error', message: err instanceof Error ? err.message : 'Retain pipeline failed' },
      500,
    );
  }
});

// DELETE /memories — clear bank memories (original: DELETE /banks/{bank_id}/memories)
app.delete('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const factType = c.req.query('type');

  // Collect IDs before deleting so we can remove vectors
  let selectQuery = 'SELECT id FROM memory_units WHERE bank_id = ?';
  let deleteQuery = 'DELETE FROM memory_units WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (factType) {
    selectQuery += ' AND fact_type = ?';
    deleteQuery += ' AND fact_type = ?';
    params.push(factType);
  }

  const rows = await c.env.DB.prepare(selectQuery)
    .bind(...params)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort) so a partial failure doesn't leave ghost vectors
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  const result = await c.env.DB.prepare(deleteQuery)
    .bind(...params)
    .run();
  return c.json({ success: true, deleted_count: result.meta.changes });
});

// POST /memories/recall — recall memories
app.post('/recall', async (c) => {
  const bankId = c.req.param('bank_id')!;
  const body = await c.req.json<RecallRequest>();

  if (!body.query || typeof body.query !== 'string') {
    return c.json({ error: 'validation_error', message: 'query is required' }, 400);
  }

  try {
    const maxResults = body.max_tokens ? Math.min(body.max_tokens, 200) : (BUDGET_LIMITS[body.budget ?? 'mid'] ?? 25);

    const result = await recall(c.env, bankId, body.query, {
      maxResults,
      factTypes: body.types as FactType[] | undefined,
      tags: body.tags ?? undefined,
      tagsMatch: body.tags_match,
      queryTimestamp: body.query_timestamp,
      trace: body.trace ?? false,
      includeEntities: !!body.include?.entities,
      includeChunks: !!body.include?.chunks,
      includeSourceFacts: !!body.include?.source_facts,
      entityMaxTokens: body.include?.entities?.max_tokens,
      chunkMaxTokens: body.include?.chunks?.max_tokens,
      sourceFactMaxTokens: body.include?.source_facts?.max_tokens,
    });

    return c.json(result);
  } catch (err) {
    console.error('[recall] Pipeline error:', err);
    return c.json(
      { error: 'recall_error', message: err instanceof Error ? err.message : 'Recall pipeline failed' },
      500,
    );
  }
});

// GET /memories/list — list memory units
app.get('/list', async (c) => {
  const bankId = c.req.param('bank_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const factType = c.req.query('type');

  let query = 'SELECT id, text, fact_type, context, event_date, created_at FROM memory_units WHERE bank_id = ?';
  const params: unknown[] = [bankId];

  if (factType) {
    query += ' AND fact_type = ?';
    params.push(factType);
  }

  query += ' ORDER BY event_date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = await c.env.DB.prepare(query)
    .bind(...params)
    .all();

  const countQuery = factType
    ? 'SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ? AND fact_type = ?'
    : 'SELECT COUNT(*) as total FROM memory_units WHERE bank_id = ?';
  const countParams = factType ? [bankId, factType] : [bankId];
  const countResult = await c.env.DB.prepare(countQuery)
    .bind(...countParams)
    .first<{ total: number }>();

  return c.json({
    items: results.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      type: row.fact_type,
      context: row.context,
      event_date: row.event_date,
      created_at: row.created_at,
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /memories/:memory_id — get single memory unit
app.get('/:memory_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  const row = await c.env.DB.prepare('SELECT * FROM memory_units WHERE id = ? AND bank_id = ?')
    .bind(memoryId, bankId)
    .first();

  if (!row) {
    return c.json({ error: 'not_found', message: 'Memory unit not found' }, 404);
  }

  return c.json(row);
});

// DELETE /memories/:memory_id — delete memory unit
app.delete('/:memory_id', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  // Check existence first so we can 404 without side effects
  const exists = await c.env.DB.prepare('SELECT id FROM memory_units WHERE id = ? AND bank_id = ?')
    .bind(memoryId, bankId)
    .first();

  if (!exists) {
    return c.json({ error: 'not_found', message: 'Memory unit not found' }, 404);
  }

  // Delete vector first (best-effort), then D1 row
  await deleteVectorsBatched(c.env.VECTORIZE, [memoryId]);

  await c.env.DB.prepare('DELETE FROM memory_units WHERE id = ? AND bank_id = ?').bind(memoryId, bankId).run();

  return c.json({ success: true, deleted: memoryId });
});

// DELETE /memories/:memory_id/observations — delete observations for a memory
app.delete('/:memory_id/observations', async (c) => {
  const bankId = c.req.param('bank_id');
  const memoryId = c.req.param('memory_id');

  const rows = await c.env.DB.prepare(
    "SELECT id FROM memory_units WHERE bank_id = ? AND fact_type = 'observation' AND id IN (SELECT id FROM memory_units WHERE source_memory_ids LIKE ?)",
  )
    .bind(bankId, `%${memoryId}%`)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);

  // Delete vectors first (best-effort), then D1 rows
  await deleteVectorsBatched(c.env.VECTORIZE, ids);

  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation' AND id IN (SELECT id FROM memory_units WHERE source_memory_ids LIKE ?)",
  )
    .bind(bankId, `%${memoryId}%`)
    .run();

  return c.json({ success: true, deleted_count: result.meta.changes });
});

export { app as memoriesRoutes };
