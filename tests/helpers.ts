/**
 * Test helpers: in-memory D1 mock and app factory.
 */

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
        // Return empty for joins — simplifies the mock
        return { results: [], meta: { changes: 0 } };
      }

      // SELECT
      if (sqlLower.startsWith('select')) {
        const table = this.getFromTable(sqlLower);
        let rows = this.getFilteredRows(table, sqlLower);

        // LIMIT / OFFSET
        const offsetMatch = sqlLower.match(/offset\s+(\?|\d+)/);
        const limitMatch = sqlLower.match(/limit\s+(\?|\d+)/);

        // Count how many ? come before LIMIT and OFFSET to find param indices
        const whereEnd = sqlLower.indexOf('order by') !== -1
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
        if (!store.tables[table]) store.tables[table] = [];
        store.tables[table].push(row);
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
          (row) => !this.rowMatchesWhere(row, sqlLower, this.params)
        );
        const after = (store.tables[table] || []).length;
        return { results: [], meta: { changes: before - after } };
      }
    } catch (e) {
      console.error('Mock D1 error:', e, '\nSQL:', sql, '\nParams:', this.params);
    }

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

      // col != '...' — skip (too complex)
      // col LIKE ? — skip
      // col IN (...) — skip
      // If there's an unmatched ?, consume it
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
// Mock Env
// ---------------------------------------------------------------------------

export function createMockEnv(): Record<string, unknown> {
  store.clear();
  return {
    DB: new MockD1Database(),
    VECTORIZE: {},
    R2: {},
    AI: {},
    QUEUE: { send: async () => {} },
    HINDSIGHT_VERSION: '0.1.0-test',
    DEFAULT_LLM_MODEL: '@cf/meta/llama-3.1-70b-instruct',
    DEFAULT_EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
    DEFAULT_RERANKER_MODEL: '@cf/baai/bge-reranker-base',
    EMBEDDING_DIMENSIONS: '768',
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
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await app.fetch(new Request(url, init));
  return {
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  };
}
