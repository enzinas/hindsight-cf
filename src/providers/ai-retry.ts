/**
 * Retry wrapper for Workers AI calls.
 *
 * Background: Workers AI's `env.AI.run(...)` intermittently throws
 * `3043: Internal server error` — an undocumented, transient upstream
 * failure that affects embeddings (bge-m3), text generation, and vision
 * models. Empirical measurement (see 3043-error-test-2026-04-17.md):
 *
 *   - Steady-state baseline: <1% failure rate
 *   - During CF backend incidents: up to ~22% within a short window
 *   - Not rate-correlated (0 failures at 3 req/s × 600 calls in a healthy window)
 *   - Failures cluster — retries typically succeed within 100–300 ms
 *
 * Retry policy:
 *   - 3043 / transient: up to 3 retries, 100 ms between (enough for TCP/stack
 *     hygiene, invisible to users, but gives the incident window a chance to
 *     move on)
 *   - 3040 / 429 "Out of capacity" (the real rate-limit code): 1 retry after
 *     5 s (we've never observed this in practice, but a real rate limiter
 *     needs real breathing room)
 *   - Anything else: throw immediately
 */
import type { Env } from '../env';
import { writeAiRetryMetric } from '../metrics';

const MAX_RETRIES_3043 = 3;
const MAX_RETRIES_3040 = 1;
const DELAY_3043_MS = 100;
const DELAY_3040_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Drop-in replacement for `env.AI.run(...)` that retries transient Workers
 * AI infrastructure errors. Same signature, same return shape.
 */
export async function aiRunWithRetry<T = unknown>(
  env: Env,
  model: Parameters<Ai['run']>[0],
  body: Parameters<Ai['run']>[1],
  opts?: Parameters<Ai['run']>[2],
): Promise<T> {
  const start = Date.now();
  let attempts3043 = 0;
  let attempts3040 = 0;
  // Track the FIRST retryable error code seen — that's what we're
  // attributing the retry event to. If both occur, 3040 wins because it's
  // the more serious condition (real rate limit).
  let firstRetryCode: '3043' | '3040' | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = (await env.AI.run(model, body, opts)) as T;
      // Success — if we had to retry to get here, emit a "recovered" metric.
      if (firstRetryCode !== null) {
        writeAiRetryMetric(
          env,
          String(model),
          firstRetryCode,
          'recovered',
          Date.now() - start,
          attempts3043 + attempts3040 + 1,
        );
      }
      return result;
    } catch (e) {
      const msg = errorMessage(e);

      if (/3043/.test(msg) && attempts3043 < MAX_RETRIES_3043) {
        if (firstRetryCode === null) firstRetryCode = '3043';
        attempts3043++;
        console.warn(
          `[ai-retry] model=${String(model)} hit 3043 (upstream transient), retry ${attempts3043}/${MAX_RETRIES_3043} after ${DELAY_3043_MS}ms`,
        );
        await sleep(DELAY_3043_MS);
        continue;
      }

      if ((/3040/.test(msg) || /capacity/i.test(msg)) && attempts3040 < MAX_RETRIES_3040) {
        // 3040 dominates: if we had a prior 3043 attribution, upgrade it.
        firstRetryCode = '3040';
        attempts3040++;
        console.warn(
          `[ai-retry] model=${String(model)} hit 3040 (rate limit), retry ${attempts3040}/${MAX_RETRIES_3040} after ${DELAY_3040_MS}ms`,
        );
        await sleep(DELAY_3040_MS);
        continue;
      }

      // Exhausted or non-retryable — if we actually retried, record it.
      if (firstRetryCode !== null) {
        writeAiRetryMetric(
          env,
          String(model),
          firstRetryCode,
          'exhausted',
          Date.now() - start,
          attempts3043 + attempts3040 + 1,
        );
      }
      throw e;
    }
  }
}
