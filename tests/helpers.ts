/**
 * Test helpers: in-memory D1 mock and app factory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read [vars] from wrangler.toml so tests stay in sync with config.
 */
function readWranglerVars(): Record<string, string> {
  const toml = readFileSync(resolve(__dirname, '..', 'wrangler.toml'), 'utf-8');
  const vars: Record<string, string> = {};
  let inVars = false;
  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[vars]') {
      inVars = true;
      continue;
    }
    if (inVars && trimmed.startsWith('[')) break; // next section
    if (inVars && trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      const val = rest.join('=').trim().replace(/^"|"$/g, '');
      vars[key.trim()] = val;
    }
  }
  return vars;
}

const wranglerVars = readWranglerVars();

interface Row {
  [key: string]: unknown;
}

/**
 * In-memory store for all tables.
 */
class InMemoryStore {
  tables: Record<string, Row[]> = {};

  constructor() {
    this.clear();
  }

  clear() {
    this.tables = {
      banks: [],
      documents: [],
      chunks: [],
      memory_units: [],
      entities: [],
      unit_entities: [],
      entity_cooccurrences: [],
      memory_links: [],
      directives: [],
      async_operations: [],
      api_keys: [],
      webhooks: [],
      webhook_deliveries: [],
      audit_logs: [],
    };
  }
}

export const store = new InMemoryStore();

/**
 * Minimal D1 mock that operates on the in-memory store.
 * Parses SQL just enough to route to the right table and filter by WHERE clauses.
 */
class MockD1PreparedStatement {
  private sql: string;
  private params: unknown[] = [];

  constructor(sql: string) {
    this.sql = sql;
  }

  bind(...params: unknown[]): MockD1PreparedStatement {
    this.params = params;
    return this;
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const result = this.exec();
    if (result.results.length === 0) return null;
    if (column) return (result.results[0] as Record<string, unknown>)[column] as T;
    return result.results[0] as T;
  }

  async all(): Promise<{ results: Row[]; success: boolean; meta: Record<string, unknown> }> {
    const result = this.exec();
    return { results: result.results, success: true, meta: result.meta };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const result = this.exec();
    return { success: true, meta: { changes: result.meta.changes } };
  }

  private exec(): { results: Row[]; meta: { changes: number } } {
    const sql = this.sql.trim();
    const sqlLower = sql.toLowerCase();

    try {
      // SELECT COUNT(*)
      if (sqlLower.includes('select count(*)')) {
        const table = this.getFromTable(sqlLower);
        const rows = this.getFilteredRows(table, sqlLower);
        return { results: [{ total: rows.length }], meta: { changes: 0 } };
      }

      // SELECT DISTINCT
      if (sqlLower.startsWith('select distinct')) {
        const table = this.getFromTable(sqlLower);
        const rows = this.getFilteredRows(table, sqlLower);
        return { results: rows, meta: { changes: 0 } };
      }

      // SELECT with JOIN
      if (sqlLower.includes('join')) {
        return this.execJoin(sqlLower);
      }

      // SELECT
      if (sqlLower.startsWith('select')) {
        const table = this.getFromTable(sqlLower);
        let rows = this.getFilteredRows(table, sqlLower);

        // LIMIT / OFFSET
        const offsetMatch = sqlLower.match(/offset\s+(\?|\d+)/);
        const limitMatch = sqlLower.match(/limit\s+(\?|\d+)/);

        // Count how many ? come before LIMIT and OFFSET to find param indices
        const whereEnd =
          sqlLower.indexOf('order by') !== -1
            ? sqlLower.indexOf('order by')
            : sqlLower.indexOf('limit') !== -1
              ? sqlLower.indexOf('limit')
              : sqlLower.length;
        const wherePart = sqlLower.substring(0, whereEnd);
        const whereParamCount = (wherePart.match(/\?/g) || []).length;

        let offset = 0;
        let limit = rows.length;

        if (limitMatch) {
          limit = limitMatch[1] === '?' ? Number(this.params[whereParamCount]) : parseInt(limitMatch[1]);
        }
        if (offsetMatch) {
          offset = offsetMatch[1] === '?' ? Number(this.params[whereParamCount + 1]) : parseInt(offsetMatch[1]);
        }

        rows = rows.slice(offset, offset + limit);
        return { results: [...rows], meta: { changes: 0 } };
      }

      // INSERT
      if (sqlLower.startsWith('insert')) {
        const table = this.getInsertTable(sqlLower);
        const columns = this.getInsertColumns(sql);
        const hasOnConflict = sqlLower.includes('on conflict');
        const hasReturning = sqlLower.includes('returning');
        const row: Row = {};
        columns.forEach((col, i) => {
          row[col] = i < this.params.length ? this.params[i] : null;
        });
        // Defaults
        if (!row.created_at) row.created_at = new Date().toISOString();
        if (!row.updated_at) row.updated_at = new Date().toISOString();
        if (table === 'banks') {
          if (row.disposition === undefined) row.disposition = '{"skepticism":3,"literalism":3,"empathy":3}';
          if (row.mission === undefined) row.mission = '';
          if (row.background === undefined) row.background = '';
          if (row.config === undefined) row.config = '{}';
          if (row.name === undefined) row.name = row.bank_id || '';
        }
        if (table === 'directives') {
          if (row.is_active === undefined) row.is_active = 1;
          if (row.priority === undefined) row.priority = 0;
          if (row.tags === undefined) row.tags = '[]';
        }
        if (table === 'memory_units') {
          if (row.metadata === undefined) row.metadata = '{}';
          if (row.tags === undefined) row.tags = '[]';
          if (row.proof_count === undefined) row.proof_count = 1;
          if (row.source_memory_ids === undefined) row.source_memory_ids = '[]';
          if (row.history === undefined) row.history = '[]';
        }
        if (table === 'entities') {
          if (row.metadata === undefined) row.metadata = '{}';
          if (row.mention_count === undefined) row.mention_count = 1;
          if (!row.id) {
            row.id = crypto.randomUUID();
          }
        }
        if (!store.tables[table]) store.tables[table] = [];

        // Handle ON CONFLICT by checking for existing row with same key
        if (hasOnConflict) {
          // Try to find existing row by matching key columns
          const existingIdx = store.tables[table].findIndex((existing) => {
            if (table === 'banks') return existing.bank_id === row.bank_id;
            if (table === 'documents') return existing.id === row.id && existing.bank_id === row.bank_id;
            if (table === 'chunks') return existing.chunk_id === row.chunk_id;
            if (table === 'entities') {
              return (
                existing.bank_id === row.bank_id &&
                String(existing.canonical_name).toLowerCase() === String(row.canonical_name).toLowerCase()
              );
            }
            if (table === 'unit_entities')
              return existing.unit_id === row.unit_id && existing.entity_id === row.entity_id;
            if (table === 'entity_cooccurrences')
              return existing.entity_id_1 === row.entity_id_1 && existing.entity_id_2 === row.entity_id_2;
            if (table === 'memory_links') {
              return (
                existing.from_unit_id === row.from_unit_id &&
                existing.to_unit_id === row.to_unit_id &&
                existing.link_type === row.link_type &&
                existing.entity_id === row.entity_id
              );
            }
            return false;
          });

          if (existingIdx >= 0) {
            // ON CONFLICT: update the existing row (simplified DO UPDATE)
            const existing = store.tables[table][existingIdx];
            if (sqlLower.includes('do update')) {
              // Merge: keep old row but update any non-key columns mentioned in SET
              if (table === 'entities') {
                existing.mention_count = ((existing.mention_count as number) || 0) + 1;
                existing.last_seen = row.last_seen;
              } else if (table === 'entity_cooccurrences') {
                existing.cooccurrence_count = ((existing.cooccurrence_count as number) || 0) + 1;
                existing.last_cooccurred = row.last_cooccurred;
              } else if (table === 'documents') {
                existing.original_text = row.original_text;
                existing.content_hash = row.content_hash;
                existing.metadata = row.metadata;
                existing.updated_at = new Date().toISOString();
              } else if (table === 'chunks') {
                existing.chunk_text = row.chunk_text;
              }
            }
            // DO NOTHING: just skip
            if (hasReturning) {
              return { results: [existing], meta: { changes: 0 } };
            }
            return { results: [], meta: { changes: 0 } };
          }
        }

        store.tables[table].push(row);
        if (hasReturning) {
          return { results: [row], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 1 } };
      }

      // UPDATE
      if (sqlLower.startsWith('update')) {
        const table = this.getUpdateTable(sqlLower);
        const rows = store.tables[table] || [];

        // Parse SET col = ? pairs and WHERE col = ? pairs
        const setCols = this.getSetColumns(sql);
        const whereParamCount = this.getWhereParamCount(sqlLower);
        const setParamCount = this.params.length - whereParamCount;
        const setValues = this.params.slice(0, setParamCount);
        const whereValues = this.params.slice(setParamCount);

        let changes = 0;
        for (const row of rows) {
          if (this.rowMatchesWhere(row, sqlLower, whereValues)) {
            let vi = 0;
            for (const col of setCols) {
              if (vi < setValues.length) {
                row[col] = setValues[vi];
                vi++;
              }
            }
            row.updated_at = new Date().toISOString();
            changes++;
          }
        }
        return { results: [], meta: { changes } };
      }

      // DELETE
      if (sqlLower.startsWith('delete')) {
        const table = this.getFromTable(sqlLower);
        const before = (store.tables[table] || []).length;
        store.tables[table] = (store.tables[table] || []).filter(
          (row) => !this.rowMatchesWhere(row, sqlLower, this.params),
        );
        const after = (store.tables[table] || []).length;
        return { results: [], meta: { changes: before - after } };
      }
    } catch (e) {
      console.error('Mock D1 error:', e, '\nSQL:', sql, '\nParams:', this.params);
    }

    return { results: [], meta: { changes: 0 } };
  }

  /**
   * Handle SELECT ... JOIN queries for the recall pipeline.
   * Supports:
   *   - memory_units_fts JOIN memory_units (FTS search)
   *   - unit_entities JOIN entities (entity hydration)
   *   - unit_entities JOIN memory_units (entity observations)
   */
  private execJoin(sqlLower: string): { results: Row[]; meta: { changes: number } } {
    // FTS JOIN: memory_units_fts fts JOIN memory_units m
    if (sqlLower.includes('memory_units_fts')) {
      // FTS mock: do a simple text search across memory_units
      const matchIdx = sqlLower.indexOf('match');
      if (matchIdx >= 0) {
        const ftsQuery = this.params[0] as string;
        const bankId = this.params[1] as string;
        const limit = (this.params[2] as number) ?? 50;

        // Parse OR-separated terms
        const terms = (ftsQuery || '').split(/\s+OR\s+/i).map((t: string) => t.trim().toLowerCase());
        const rows = (store.tables.memory_units || []).filter((row) => {
          if (bankId && String(row.bank_id) !== String(bankId)) return false;
          const text = String(row.text || '').toLowerCase();
          return terms.some((t: string) => t && text.includes(t));
        });

        // Add mock FTS rank
        const results = rows.slice(0, limit).map((row, i) => ({
          ...row,
          fts_rank: -(rows.length - i), // More negative = more relevant
        }));
        return { results, meta: { changes: 0 } };
      }
    }

    // unit_entities JOIN entities
    if (sqlLower.includes('unit_entities') && sqlLower.includes('join') && sqlLower.includes('entities')) {
      const unitEntities = store.tables.unit_entities || [];
      const entities = store.tables.entities || [];
      const results: Row[] = [];

      // Figure out what we're filtering by from params
      if (sqlLower.includes('ue.unit_id in')) {
        // Entity hydration: find entities linked to given unit IDs
        const bankId = this.params[this.params.length - 1] as string;
        const unitIds = this.params.slice(0, this.params.length - 1) as string[];

        for (const ue of unitEntities) {
          if (!unitIds.includes(String(ue.unit_id))) continue;
          const entity = entities.find((e) => e.id === ue.entity_id);
          if (!entity) continue;
          if (bankId && String(entity.bank_id) !== String(bankId)) continue;
          results.push({
            unit_id: ue.unit_id,
            entity_id: entity.id,
            canonical_name: entity.canonical_name,
          });
        }
      } else if (sqlLower.includes('ue.entity_id in')) {
        // Observation hydration: find memory_units linked to given entity IDs
        const memoryUnits = store.tables.memory_units || [];
        const bankId = this.params[this.params.length - 1] as string;
        const entityIds = this.params.slice(0, this.params.length - 1) as string[];

        for (const ue of unitEntities) {
          if (!entityIds.includes(String(ue.entity_id))) continue;
          const unit = memoryUnits.find((m) => m.id === ue.unit_id);
          if (!unit) continue;
          if (bankId && String(unit.bank_id) !== String(bankId)) continue;
          results.push({
            entity_id: ue.entity_id,
            text: unit.text,
            mentioned_at: unit.mentioned_at,
          });
        }
      }

      return { results, meta: { changes: 0 } };
    }

    // Default: return empty
    return { results: [], meta: { changes: 0 } };
  }

  private getFromTable(sqlLower: string): string {
    const match = sqlLower.match(/from\s+(\w+)/);
    return match ? match[1] : '';
  }

  private getInsertTable(sqlLower: string): string {
    const match = sqlLower.match(/insert\s+into\s+(\w+)/);
    return match ? match[1] : '';
  }

  private getUpdateTable(sqlLower: string): string {
    const match = sqlLower.match(/update\s+(\w+)/);
    return match ? match[1] : '';
  }

  private getInsertColumns(sql: string): string[] {
    const match = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!match) return [];
    return match[1].split(',').map((c) => c.trim());
  }

  private getSetColumns(sql: string): string[] {
    const match = sql.match(/SET\s+(.+?)\s+WHERE/is);
    if (!match) return [];
    return match[1]
      .split(',')
      .map((c) => {
        const parts = c.trim().split(/\s*=\s*/);
        return parts[0].trim();
      })
      .filter((c) => !c.toLowerCase().includes('strftime'));
  }

  private getWhereParamCount(sqlLower: string): number {
    const idx = sqlLower.indexOf('where');
    if (idx === -1) return 0;
    const wherePart = sqlLower.substring(idx);
    return (wherePart.match(/\?/g) || []).length;
  }

  private getFilteredRows(table: string, sqlLower: string): Row[] {
    const rows = store.tables[table] || [];
    return rows.filter((row) => this.rowMatchesWhere(row, sqlLower, this.params));
  }

  private rowMatchesWhere(row: Row, sqlLower: string, params: unknown[]): boolean {
    const whereIdx = sqlLower.indexOf('where');
    if (whereIdx === -1) return true;

    // Extract only the WHERE portion (stop at ORDER BY, LIMIT, GROUP BY)
    let wherePart = sqlLower.substring(whereIdx + 5);
    for (const kw of ['order by', 'limit', 'group by']) {
      const ki = wherePart.indexOf(kw);
      if (ki !== -1) wherePart = wherePart.substring(0, ki);
    }

    const clauses = wherePart.split(/\s+and\s+/);
    let paramIdx = 0;

    for (const clause of clauses) {
      const trimmed = clause.trim();

      // col = ?
      const paramMatch = trimmed.match(/^(\w+)\s*=\s*\?/);
      if (paramMatch && paramIdx < params.length) {
        const col = paramMatch[1];
        if (String(row[col]) !== String(params[paramIdx])) return false;
        paramIdx++;
        continue;
      }

      // col = 'literal'
      const literalMatch = trimmed.match(/(\w+)\s*=\s*'([^']+)'/);
      if (literalMatch) {
        if (String(row[literalMatch[1]]) !== literalMatch[2]) return false;
        continue;
      }

      // col IN (?, ?, ...)
      const inMatch = trimmed.match(/^(\w+)\s+in\s*\(([^)]+)\)/);
      if (inMatch) {
        const col = inMatch[1];
        const placeholders = inMatch[2].split(',').map((s: string) => s.trim());
        const inValues: unknown[] = [];
        for (const ph of placeholders) {
          if (ph === '?') {
            if (paramIdx < params.length) {
              inValues.push(params[paramIdx++]);
            }
          } else {
            inValues.push(ph.replace(/'/g, ''));
          }
        }
        if (!inValues.map(String).includes(String(row[col]))) return false;
        continue;
      }

      // col BETWEEN ? AND ?
      const betweenMatch = trimmed.match(/^(\w+)\s+between\s+\?\s+and\s+\?/i);
      if (betweenMatch) {
        const col = betweenMatch[1];
        const low = params[paramIdx++] as string;
        const high = params[paramIdx++] as string;
        const val = String(row[col]);
        if (val < low || val > high) return false;
        continue;
      }

      // col != '...' — skip (too complex)
      // col LIKE ? — consume param
      if (trimmed.includes('?') && paramIdx < params.length) {
        paramIdx++;
      }
    }
    return true;
  }
}

class MockD1Database {
  prepare(sql: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(sql);
  }

  async batch(statements: MockD1PreparedStatement[]): Promise<Array<{ results: Row[] }>> {
    const results = [];
    for (const stmt of statements) {
      const result = await stmt.all();
      results.push({ results: result.results });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Mock Workers AI
// ---------------------------------------------------------------------------

class MockWorkersAI {
  async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    // Embedding models: return deterministic vectors matching configured dimensions
    const dims = parseInt(wranglerVars.EMBEDDING_DIMENSIONS || '1024');
    if (model.includes('bge-base') || model.includes('bge-m3') || model.includes('embedding')) {
      const texts = inputs.text as string[];
      const data = texts.map((text) => {
        // Deterministic pseudo-embedding from text hash
        const vec = new Array(dims).fill(0);
        for (let i = 0; i < text.length && i < dims; i++) {
          vec[i % dims] = (text.charCodeAt(i) - 64) / 100;
        }
        // Normalize
        const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
        if (norm > 0) {
          for (let i = 0; i < vec.length; i++) vec[i] /= norm;
        }
        return vec;
      });
      return { data };
    }

    // Chat/LLM models: return fact extraction JSON
    if (model.includes('llama') || model.includes('mistral') || model.includes('instruct') || model.includes('qwen')) {
      const messages = inputs.messages as Array<{ role: string; content: string }>;
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';

      // Parse out facts from the user message text
      const textMatch = userMsg.match(/Text to extract facts from:\n([\s\S]+)/);
      const text = textMatch ? textMatch[1].trim() : userMsg;

      // Generate a simple fact from the text
      const facts = [
        {
          fact_text: text.length > 200 ? text.substring(0, 200) : text,
          fact_type: 'world',
          entities: extractSimpleEntities(text),
          occurred_start: null,
          occurred_end: null,
          where: null,
        },
      ];

      return { response: JSON.stringify(facts) };
    }

    // Reranker models: return scores for all documents
    if (model.includes('reranker')) {
      const documents = (inputs.documents as string[]) ?? [];
      const data = documents.map((_doc: string, i: number) => ({
        index: i,
        score: 1.0 - i * 0.1, // Decreasing scores
      }));
      return { data };
    }

    return { response: '' };
  }
}

function extractSimpleEntities(text: string): string[] {
  // Extract capitalized words as entity candidates
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
  return [...new Set(matches ?? [])].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Mock Vectorize
// ---------------------------------------------------------------------------

class MockVectorizeIndex {
  private vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];

  async upsert(
    vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<{ count: number }> {
    for (const vec of vectors) {
      const existingIdx = this.vectors.findIndex((v) => v.id === vec.id);
      const entry = { id: vec.id, values: vec.values, metadata: vec.metadata ?? {} };
      if (existingIdx >= 0) {
        this.vectors[existingIdx] = entry;
      } else {
        this.vectors.push(entry);
      }
    }
    return { count: vectors.length };
  }

  async query(
    vector: number[],
    options?: { topK?: number; filter?: Record<string, unknown> },
  ): Promise<{ matches: Array<{ id: string; score: number }> }> {
    const topK = options?.topK ?? 5;
    const filter = options?.filter ?? {};

    // Filter by metadata
    let candidates = this.vectors;
    for (const [key, value] of Object.entries(filter)) {
      candidates = candidates.filter((v) => v.metadata[key] === value);
    }

    // Compute cosine similarity and rank
    const scored = candidates.map((c) => ({
      id: c.id,
      score: cosineSim(vector, c.values),
    }));

    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, topK) };
  }

  async deleteByIds(ids: string[]): Promise<{ count: number }> {
    const before = this.vectors.length;
    this.vectors = this.vectors.filter((v) => !ids.includes(v.id));
    return { count: before - this.vectors.length };
  }

  clear(): void {
    this.vectors = [];
  }
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Mock R2 Bucket
// ---------------------------------------------------------------------------

class MockR2Bucket {
  private objects = new Map<string, { body: ArrayBuffer; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }>();

  async put(key: string, value: ReadableStream | ArrayBuffer | string | Blob | null, options?: Record<string, unknown>): Promise<unknown> {
    let body: ArrayBuffer;
    if (value instanceof ArrayBuffer) {
      body = value;
    } else if (typeof value === 'string') {
      body = new TextEncoder().encode(value).buffer as ArrayBuffer;
    } else if (value instanceof Blob) {
      body = await value.arrayBuffer();
    } else if (value && typeof value === 'object' && 'getReader' in value) {
      // ReadableStream
      const reader = (value as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) chunks.push(result.value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      body = merged.buffer as ArrayBuffer;
    } else {
      body = new ArrayBuffer(0);
    }
    this.objects.set(key, {
      body,
      httpMetadata: (options?.httpMetadata as Record<string, string>) ?? {},
      customMetadata: (options?.customMetadata as Record<string, string>) ?? {},
    });
    return { key };
  }

  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> } | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      arrayBuffer: async () => obj.body,
      text: async () => new TextDecoder().decode(obj.body),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Mock Env
// ---------------------------------------------------------------------------

export function createMockEnv(): Record<string, unknown> {
  store.clear();
  return {
    DB: new MockD1Database(),
    VECTORIZE: new MockVectorizeIndex(),
    R2: new MockR2Bucket(),
    AI: new MockWorkersAI(),
    QUEUE: { send: async () => {} },
    ANALYTICS: { writeDataPoint: () => {} },
    HINDSIGHT_VERSION: wranglerVars.HINDSIGHT_VERSION || '0.1.0-test',
    DEFAULT_LLM_MODEL: wranglerVars.DEFAULT_LLM_MODEL,
    DEFAULT_VISION_MODEL: wranglerVars.DEFAULT_VISION_MODEL,
    DEFAULT_EMBEDDING_MODEL: wranglerVars.DEFAULT_EMBEDDING_MODEL,
    DEFAULT_RERANKER_MODEL: wranglerVars.DEFAULT_RERANKER_MODEL,
    EMBEDDING_DIMENSIONS: wranglerVars.EMBEDDING_DIMENSIONS,
  };
}

/**
 * Helper to make requests to the app.
 */
export async function request(
  app: { fetch: (req: Request) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  const mergedHeaders: Record<string, string> = { ...headers };
  if (body) {
    init.body = JSON.stringify(body);
    mergedHeaders['Content-Type'] = 'application/json';
  }
  if (Object.keys(mergedHeaders).length > 0) {
    init.headers = mergedHeaders;
  }
  const response = await app.fetch(new Request(url, init));
  return {
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  };
}
