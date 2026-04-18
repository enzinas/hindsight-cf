/**
 * Workers AI 3043 failure-rate probe.
 *
 * Repeatedly calls `/memories/recall` on an empty bank — each call exercises
 * exactly one `@cf/baai/bge-m3` embedding + one (empty) vector query, with a
 * unique query string to defeat any caching. Measures how often Workers AI
 * returns a 3043 / 500 vs a clean 200, at two request cadences.
 *
 * Not a vitest test — run it manually:
 *
 *   LIVE_TEST_URL=https://hindsight-cf.example.com \
 *   LIVE_TEST_API_KEY=... \
 *     npx tsx tests/live-throttle-probe.ts
 *
 * Three phases, all well under the published Workers AI rate limits
 * (bge-m3 = 3000 req/min, so even 180/min is 6% of budget):
 *   Phase A: 1 call / 4 s for 200 s = 50 calls   (baseline / idle-ish)
 *   Phase B: 1 call / 1 s for 200 s = 200 calls  (sustained)
 *   Phase C: 3 calls / 1 s for 200 s = 600 calls, retry-on-3043 until success
 *            (measures how many retries each 3043 needs to succeed)
 *
 * Each call's outcome is appended to tests/probe-log.jsonl; a summary is
 * printed to stdout at the end.
 */
import { writeFileSync, appendFileSync } from 'node:fs';

const BASE_URL = process.env.LIVE_TEST_URL;
const API_KEY = process.env.LIVE_TEST_API_KEY;
const BANK_ID = '__live-probe-empty';
const LOG_PATH = 'tests/probe-log.jsonl';

if (!BASE_URL) {
  console.error('ERROR: set LIVE_TEST_URL=https://<your-worker>.workers.dev');
  process.exit(1);
}

const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

interface CallResult {
  phase: string;
  i: number;
  t_started: string;
  status: number;
  ok: boolean;
  is3043: boolean;
  is3040: boolean;
  latency_ms: number;
  error_snippet: string;
  /** retry_count: only populated for retry-enabled phases. 0 = first try succeeded. */
  retry_count?: number;
  /** total wall time including retries, for retry-enabled phases */
  total_ms?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function oneRecall(phase: string, i: number): Promise<CallResult> {
  const t_started = new Date().toISOString();
  const t0 = Date.now();
  const query = `probe-${phase}-${i}-${Date.now()}`;
  let status = 0;
  let rawText = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/default/banks/${BANK_ID}/memories/recall`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, budget: 'low', limit: 1 }),
    });
    status = res.status;
    rawText = await res.text();
  } catch (e) {
    rawText = `NETWORK_ERROR: ${(e as Error).message}`;
  }
  const latency_ms = Date.now() - t0;
  const is3043 = /3043/.test(rawText);
  const is3040 = /3040/.test(rawText);
  const ok = status === 200;
  return {
    phase,
    i,
    t_started,
    status,
    ok,
    is3043,
    is3040,
    latency_ms,
    error_snippet: ok ? '' : rawText.slice(0, 200),
  };
}

/**
 * Keeps firing the recall call until it succeeds OR we hit `maxRetries`.
 * Used by Phase C to measure how many retries each 3043 needs to clear.
 * Returns a result annotated with retry_count and total_ms.
 */
async function oneRecallWithRetry(
  phase: string,
  i: number,
  maxRetries = 10,
): Promise<CallResult> {
  const overallStart = Date.now();
  let attempt = 0;
  let result = await oneRecall(phase, i);
  while (!result.ok && result.is3043 && attempt < maxRetries) {
    attempt++;
    // No backoff — user asked for "immediate retry"
    result = await oneRecall(phase, i);
  }
  return {
    ...result,
    retry_count: attempt,
    total_ms: Date.now() - overallStart,
  };
}

async function runPhase(
  label: string,
  intervalMs: number,
  totalMs: number,
  opts: { retry?: boolean } = {},
): Promise<CallResult[]> {
  const calls = Math.floor(totalMs / intervalMs);
  const mode = opts.retry ? ' (retry-on-3043)' : '';
  console.log(
    `\n[${label}] Starting: ${calls} calls at ${intervalMs}ms interval (~${Math.round(
      totalMs / 1000,
    )}s total)${mode}`,
  );
  const results: CallResult[] = [];
  const phaseStart = Date.now();
  for (let i = 0; i < calls; i++) {
    const r = opts.retry ? await oneRecallWithRetry(label, i) : await oneRecall(label, i);
    results.push(r);
    appendFileSync(LOG_PATH, JSON.stringify(r) + '\n');

    if ((i + 1) % 25 === 0 || i + 1 === calls) {
      const failures = results.filter((x) => !x.ok).length;
      const n3043 = results.filter((x) => x.is3043).length;
      const n3040 = results.filter((x) => x.is3040).length;
      const totalRetries = results.reduce((s, x) => s + (x.retry_count ?? 0), 0);
      const elapsed = Math.round((Date.now() - phaseStart) / 1000);
      const retryStr = opts.retry ? ` retries:${totalRetries}` : '';
      console.log(
        `[${label}] ${i + 1}/${calls} — final-failures:${failures} (3043:${n3043} 3040:${n3040})${retryStr} — ${elapsed}s elapsed`,
      );
    }

    const remaining = intervalMs - (Date.now() - (phaseStart + i * intervalMs));
    if (i + 1 < calls && remaining > 0) await sleep(remaining);
  }
  return results;
}

function summarize(label: string, results: CallResult[]): void {
  const n = results.length;
  const ok = results.filter((r) => r.ok).length;
  const fail = n - ok;
  const n3043 = results.filter((r) => r.is3043).length;
  const n3040 = results.filter((r) => r.is3040).length;
  const nOther = fail - n3043 - n3040;
  const latencies = results.filter((r) => r.ok).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log(`\n─── ${label} summary ───────────────────────────`);
  console.log(`Total calls      : ${n}`);
  console.log(`Successes (200)  : ${ok} (${((ok / n) * 100).toFixed(1)}%)`);
  console.log(`Failures         : ${fail} (${((fail / n) * 100).toFixed(1)}%)`);
  console.log(`  └ 3043         : ${n3043} (${((n3043 / n) * 100).toFixed(1)}%)`);
  console.log(`  └ 3040 (rate)  : ${n3040} (${((n3040 / n) * 100).toFixed(1)}%)`);
  console.log(`  └ other        : ${nOther}`);
  console.log(`Latency p50 / p95: ${p50}ms / ${p95}ms (successes only)`);

  // Retry-specific stats (only populated for Phase C)
  const hadRetries = results.some((r) => r.retry_count !== undefined);
  if (hadRetries) {
    const retryCounts = results.map((r) => r.retry_count ?? 0);
    const totalRetries = retryCounts.reduce((s, x) => s + x, 0);
    const retried = retryCounts.filter((c) => c > 0).length;
    const maxRetry = Math.max(...retryCounts);
    const dist: Record<number, number> = {};
    for (const c of retryCounts) dist[c] = (dist[c] ?? 0) + 1;
    const totalMs = results.map((r) => r.total_ms ?? r.latency_ms).sort((a, b) => a - b);
    const totalP95 = totalMs[Math.floor(totalMs.length * 0.95)] ?? 0;

    console.log(`Retry stats:`);
    console.log(
      `  Calls that retried    : ${retried} / ${n} (${((retried / n) * 100).toFixed(1)}%)`,
    );
    console.log(`  Total retry attempts  : ${totalRetries}`);
    console.log(`  Max retries needed    : ${maxRetry}`);
    console.log(
      `  Retry distribution    : ${Object.entries(dist)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, v]) => `${k}:${v}`)
        .join('  ')}`,
    );
    console.log(`  End-to-end p95 (incl retries): ${totalP95}ms`);
  }
}

async function main(): Promise<void> {
  writeFileSync(LOG_PATH, '');
  console.log(`Probe target  : ${BASE_URL}`);
  console.log(`Bank          : ${BANK_ID} (empty)`);
  console.log(`Per-call work : 1 embedding (bge-m3) + 1 empty Vectorize query`);
  console.log(`Per-call log  : ${LOG_PATH}`);

  const phaseA = await runPhase('PHASE_A_4s', 4_000, 200_000);
  summarize('PHASE_A (1 call / 4s × 200s = 50 calls)', phaseA);

  console.log('\n[cooldown] 30s before Phase B...');
  await sleep(30_000);

  const phaseB = await runPhase('PHASE_B_1s', 1_000, 200_000);
  summarize('PHASE_B (1 call / 1s × 200s = 200 calls)', phaseB);

  console.log('\n[cooldown] 30s before Phase C...');
  await sleep(30_000);

  // Phase C: 3 calls/second, with immediate retry-on-3043 until success.
  // 3 req/s = 180 req/min, still << bge-m3's 3000 req/min limit.
  const phaseC = await runPhase('PHASE_C_3ps', 333, 200_000, { retry: true });
  summarize('PHASE_C (3 calls / 1s × 200s = 600 calls, retry-on-3043)', phaseC);

  console.log('\n─── Combined ──────────────────────────────────');
  summarize('ALL', [...phaseA, ...phaseB, ...phaseC]);
  console.log(`\nFull per-call log: ${LOG_PATH}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
