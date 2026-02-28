/**
 * hindsight-cf — Cloudflare Workers port of hindsight memory system.
 *
 * Main entry point: Hono router with all API routes.
 * 100% API compatible with the original hindsight-api.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';

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
import { tagsRoutes } from './routes/tags';
import { filesRoutes } from './routes/files';

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', cors());

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'internal_error',
      message: err.message || 'An unexpected error occurred',
    },
    500
  );
});

// =============================================================================
// Monitoring endpoints (no prefix)
// =============================================================================
app.route('/', healthRoutes);

// =============================================================================
// API routes — all under /v1/default/
// =============================================================================
const api = new Hono<{ Bindings: Env }>();

// Banks (list) — GET /v1/default/banks
api.get('/banks', async (c) => {
  const results = await c.env.DB.prepare('SELECT bank_id FROM banks ORDER BY created_at DESC').all();
  return c.json({
    banks: results.results.map((row: Record<string, unknown>) => row.bank_id as string),
  });
});

// Chunks — at top level: GET /v1/default/chunks/:chunk_id (not under banks)
api.route('/chunks', chunksRoutes);

// Bank-scoped routes
const bank = new Hono<{ Bindings: Env }>();

// PUT /banks/:bank_id — update bank
bank.put('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
    ).bind(body.name, bankId).run();
  }
  return c.json({ success: true, bank_id: bankId });
});

// PATCH /banks/:bank_id — update bank
bank.patch('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ name?: string }>();
  const { ensureBank } = await import('./routes/banks');
  await ensureBank(c.env.DB, bankId);
  if (body.name !== undefined) {
    await c.env.DB.prepare(
      "UPDATE banks SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
    ).bind(body.name, bankId).run();
  }
  return c.json({ success: true, bank_id: bankId });
});

// DELETE /banks/:bank_id — delete bank
bank.delete('/', async (c) => {
  const bankId = c.req.param('bank_id');
  const result = await c.env.DB.prepare('DELETE FROM banks WHERE bank_id = ?').bind(bankId).run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bank not found' }, 404);
  }
  return c.json({ success: true, deleted: bankId });
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

    return c.json({
      text: result.text,
      based_on: result.basedOn,
      structured_output: result.structuredOutput,
      usage: result.usage ? {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      } : null,
      trace: result.trace,
    });
  } catch (err) {
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
  const body = await c.req.json<{
    fact_types?: string[];
    tags?: string[];
    max_groups?: number;
    min_group_size?: number;
  }>().catch(() => ({} as { fact_types?: string[]; tags?: string[]; max_groups?: number; min_group_size?: number }));

  try {
    const { consolidate } = await import('./engine/consolidate/orchestrator');
    const result = await consolidate(c.env, {
      bankId,
      factTypes: body.fact_types as import('./types').FactType[] | undefined,
      tags: body.tags,
      maxGroups: body.max_groups,
      minGroupSize: body.min_group_size,
    });

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
    console.error('[consolidate] Pipeline error:', err);
    return c.json(
      { error: 'consolidate_error', message: err instanceof Error ? err.message : 'Consolidation failed' },
      500,
    );
  }
});

// Observations — DELETE /observations (clear all observations)
bank.delete('/observations', async (c) => {
  const bankId = c.req.param('bank_id');
  const result = await c.env.DB.prepare(
    "DELETE FROM memory_units WHERE bank_id = ? AND fact_type = 'observation'"
  ).bind(bankId).run();
  return c.json({ success: true, deleted_count: result.meta.changes });
});

// Background — POST /background (original: POST /banks/{bank_id}/background)
bank.post('/background', async (c) => {
  const bankId = c.req.param('bank_id');
  const body = await c.req.json<{ content: string }>();

  const { ensureBank } = await import('./routes/banks');
  const bankRow = await ensureBank(c.env.DB, bankId);
  const existingMission = bankRow.mission as string;
  const newMission = existingMission ? `${existingMission}\n\n${body.content}` : body.content;

  await c.env.DB.prepare(
    "UPDATE banks SET mission = ?, background = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bank_id = ?"
  ).bind(newMission, body.content, bankId).run();

  return c.json({ success: true, mission: newMission });
});

// Bank profile & config (sub-routes of banks)
bank.route('/', banksRoutes);

// Mount bank routes under /banks/:bank_id
api.route('/banks/:bank_id', bank);

// Mount API under /v1/default
app.route('/v1/default', api);

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
        ).bind(payload.operation_id).run();

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
        ).bind(JSON.stringify(resultMetadata), payload.operation_id).run();

        message.ack();
      } catch (err) {
        console.error(`[queue] Error processing ${payload.operation_type}:`, err);

        // Mark operation as failed
        await env.DB.prepare(
          "UPDATE async_operations SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE operation_id = ?",
        ).bind(err instanceof Error ? err.message : 'Unknown error', payload.operation_id).run();

        message.retry();
      }
    }
  },
};

export { app };
