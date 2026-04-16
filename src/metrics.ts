/**
 * Metrics collection via Cloudflare Analytics Engine.
 *
 * Write path: fire-and-forget via the ANALYTICS binding (no token needed).
 * Read path:  queries the Analytics Engine SQL API (requires CF_ACCOUNT_ID
 *             + CF_API_TOKEN secrets with Account Analytics:Read permission).
 *
 * If the ANALYTICS binding is missing, writes are silently skipped.
 * If the read secrets are missing, GET /metrics falls back to D1 counts.
 *
 * Data-point layout (one row per event):
 *   index1  = event type: "http" | "operation" | "llm"
 *   blob1   = operation name or HTTP method  (e.g. "retain", "POST")
 *   blob2   = status ("success" | "error") or HTTP status code
 *   blob3   = bank_id (or endpoint path for http events)
 *   blob4   = extra detail (model name for llm, endpoint for http)
 *   double1 = duration in milliseconds
 *   double2 = input tokens  (llm events only)
 *   double3 = output tokens (llm events only)
 */
import type { Env } from './env';

// ---------------------------------------------------------------------------
// Write helpers (fire-and-forget, zero-cost)
// ---------------------------------------------------------------------------

/** Record an HTTP request. Call after the response is sent. */
export function writeHttpMetric(
  env: Env,
  method: string,
  endpoint: string,
  statusCode: number,
  durationMs: number,
) {
  env.ANALYTICS?.writeDataPoint({
    indexes: ['http'],
    blobs: [method, String(statusCode), endpoint, null],
    doubles: [durationMs, 0, 0],
  });
}

/** Record a core operation (retain, recall, reflect, consolidate). */
export function writeOperationMetric(
  env: Env,
  operation: string,
  bankId: string,
  status: 'success' | 'error',
  durationMs: number,
) {
  env.ANALYTICS?.writeDataPoint({
    indexes: ['operation'],
    blobs: [operation, status, bankId, null],
    doubles: [durationMs, 0, 0],
  });
}

/** Record an LLM call (Workers AI or external). */
export function writeLlmMetric(
  env: Env,
  provider: string,
  model: string,
  status: 'success' | 'error',
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
) {
  env.ANALYTICS?.writeDataPoint({
    indexes: ['llm'],
    blobs: [provider, status, model, null],
    doubles: [durationMs, inputTokens, outputTokens],
  });
}

// ---------------------------------------------------------------------------
// Read: query Analytics Engine SQL API
// ---------------------------------------------------------------------------

interface MetricsSummary {
  analytics_engine: boolean;
  period: string;
  http: {
    total_requests: number;
    by_method: Record<string, number>;
    by_status: Record<string, number>;
    avg_duration_ms: number;
  } | null;
  operations: {
    total: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    avg_duration_ms: number;
  } | null;
  llm: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    avg_duration_ms: number;
  } | null;
  d1: {
    banks: number;
    memory_units: number;
    entities: number;
    documents: number;
    async_operations: number;
  };
}

/** Query D1 for basic counts (always available). */
async function getD1Counts(db: D1Database) {
  const [banks, memories, entities, documents, operations] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM banks').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM memory_units').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM entities').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM documents').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM async_operations').first<{ c: number }>(),
  ]);
  return {
    banks: banks?.c ?? 0,
    memory_units: memories?.c ?? 0,
    entities: entities?.c ?? 0,
    documents: documents?.c ?? 0,
    async_operations: operations?.c ?? 0,
  };
}

/** Run a SQL query against Analytics Engine. Returns rows or null on failure. */
async function queryAnalyticsEngine(
  accountId: string,
  apiToken: string,
  dataset: string,
  sql: string,
): Promise<Record<string, unknown>[] | null> {
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
      },
    );
    if (!resp.ok) return null;
    const text = await resp.text();
    // The SQL API returns CSV-ish or JSON depending on the endpoint version.
    // The v4 endpoint returns JSON with { data, meta, rows } shape.
    try {
      const json = JSON.parse(text);
      return json.data ?? json.rows ?? null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Build a full metrics summary.
 * If CF_ACCOUNT_ID and CF_API_TOKEN are set, includes Analytics Engine data.
 * Always includes D1 counts.
 */
export async function getMetricsSummary(env: Env): Promise<MetricsSummary> {
  const d1 = await getD1Counts(env.DB);

  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return {
      analytics_engine: false,
      period: 'n/a',
      http: null,
      operations: null,
      llm: null,
      d1,
    };
  }

  const dataset = 'hindsight_metrics';
  const period = 'last 24 hours';

  // Run queries in parallel
  const [httpRows, opsRows, llmRows] = await Promise.all([
    queryAnalyticsEngine(
      accountId,
      apiToken,
      dataset,
      `SELECT
        blob1 AS method,
        blob2 AS status_code,
        COUNT() AS cnt,
        AVG(double1) AS avg_duration
      FROM ${dataset}
      WHERE index1 = 'http'
        AND timestamp > NOW() - INTERVAL '24' HOUR
      GROUP BY method, status_code`,
    ),
    queryAnalyticsEngine(
      accountId,
      apiToken,
      dataset,
      `SELECT
        blob1 AS operation,
        blob2 AS status,
        COUNT() AS cnt,
        AVG(double1) AS avg_duration
      FROM ${dataset}
      WHERE index1 = 'operation'
        AND timestamp > NOW() - INTERVAL '24' HOUR
      GROUP BY operation, status`,
    ),
    queryAnalyticsEngine(
      accountId,
      apiToken,
      dataset,
      `SELECT
        COUNT() AS cnt,
        SUM(double2) AS input_tokens,
        SUM(double3) AS output_tokens,
        AVG(double1) AS avg_duration
      FROM ${dataset}
      WHERE index1 = 'llm'
        AND timestamp > NOW() - INTERVAL '24' HOUR`,
    ),
  ]);

  // Aggregate HTTP metrics
  let http: MetricsSummary['http'] = null;
  if (httpRows && httpRows.length > 0) {
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let durationSum = 0;
    for (const row of httpRows) {
      const cnt = Number(row.cnt) || 0;
      total += cnt;
      durationSum += (Number(row.avg_duration) || 0) * cnt;
      const method = String(row.method);
      const status = String(row.status_code);
      byMethod[method] = (byMethod[method] || 0) + cnt;
      byStatus[status] = (byStatus[status] || 0) + cnt;
    }
    http = {
      total_requests: total,
      by_method: byMethod,
      by_status: byStatus,
      avg_duration_ms: total > 0 ? Math.round(durationSum / total) : 0,
    };
  }

  // Aggregate operation metrics
  let operations: MetricsSummary['operations'] = null;
  if (opsRows && opsRows.length > 0) {
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let durationSum = 0;
    for (const row of opsRows) {
      const cnt = Number(row.cnt) || 0;
      total += cnt;
      durationSum += (Number(row.avg_duration) || 0) * cnt;
      const op = String(row.operation);
      const status = String(row.status);
      byType[op] = (byType[op] || 0) + cnt;
      byStatus[status] = (byStatus[status] || 0) + cnt;
    }
    operations = {
      total,
      by_type: byType,
      by_status: byStatus,
      avg_duration_ms: total > 0 ? Math.round(durationSum / total) : 0,
    };
  }

  // Aggregate LLM metrics
  let llm: MetricsSummary['llm'] = null;
  if (llmRows && llmRows.length > 0) {
    const row = llmRows[0];
    llm = {
      total_calls: Number(row.cnt) || 0,
      total_input_tokens: Number(row.input_tokens) || 0,
      total_output_tokens: Number(row.output_tokens) || 0,
      avg_duration_ms: Math.round(Number(row.avg_duration) || 0),
    };
  }

  return {
    analytics_engine: true,
    period,
    http,
    operations,
    llm,
    d1,
  };
}
