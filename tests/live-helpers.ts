/**
 * Shared helpers for the live-integration test suites (`tests/live.test.ts`,
 * `tests/live-reflect.test.ts`). Provides a typed fetch wrapper and a uniform
 * failure-diagnostic layer so first-time installers see actionable hints when
 * something is misconfigured.
 */

import { expect } from 'vitest';

export const BASE_URL = process.env.LIVE_TEST_URL;
export const API_KEY = process.env.LIVE_TEST_API_KEY;
export const runLive = !!BASE_URL;

export function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  return h;
}

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  rawText: string;
}

/** Convert HTTP status + raw body into a short, user-actionable hint. */
export function statusHint(status: number, rawText: string): string {
  if (!status)
    return `[HINT] No response. Check LIVE_TEST_URL resolves and the worker is reachable.`;
  if (status === 401 || status === 403)
    return `[HINT] Auth rejected. Set LIVE_TEST_API_KEY to a valid bearer (tenant API key) or disable auth on the worker.`;
  if (status === 404)
    return `[HINT] Route or resource not found. Did you deploy the latest worker? Is LIVE_TEST_URL correct (no trailing slash)?`;
  if (status === 413) return `[HINT] Payload rejected as too large — usually the 20 MB file limit.`;
  if (status === 429 || /3040/.test(rawText))
    return `[HINT] Workers AI rate limit hit (code 3040 / HTTP 429). Wait ~60s before re-running. This is real capacity exhaustion, not a transient error.`;
  if (/3043/.test(rawText))
    return `[HINT] Workers AI transient upstream error (code 3043) survived all client retries. This is rare and usually indicates an ongoing CF backend incident. Wait a few minutes and re-run. See 3043-error-test-2026-04-17.md for context.`;
  if (status >= 500)
    return `[HINT] Worker-side error. Check \`wrangler tail\` for the stack. Body: ${rawText.slice(0, 300)}`;
  return `[HINT] Unexpected status ${status}. Body: ${rawText.slice(0, 300)}`;
}

function isRetryable3043(status: number, rawText: string): boolean {
  return status >= 500 && /3043/.test(rawText);
}

/**
 * Fetch → ApiResult with status/body parsed.
 *
 * Transparently retries HTTP 5xx responses whose body contains Workers AI
 * error code `3043` (undocumented transient upstream flake — see
 * 3043-error-test-2026-04-17.md). Up to 3 retries at 100 ms each.
 * Non-3043 failures are not retried. Network errors are not retried.
 */
const MAX_3043_RETRIES = 3;
const RETRY_3043_DELAY_MS = 100;

export async function apiCall<T = unknown>(
  url: string,
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<ApiResult<T>> {
  const opts: RequestInit = { method, headers: headers(extraHeaders) };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let lastStatus = 0;
  let lastRawText = '';

  for (let attempt = 0; attempt <= MAX_3043_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error(
        `[HINT] ${method} ${url} — network error. Is LIVE_TEST_URL reachable and the worker deployed? Underlying: ${(e as Error).message}`,
      );
    }
    const rawText = await res.text();
    lastStatus = res.status;
    lastRawText = rawText;

    if (!isRetryable3043(res.status, rawText) || attempt === MAX_3043_RETRIES) {
      let parsed: unknown = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = { _raw: rawText };
        }
      }
      return { status: res.status, ok: res.ok, body: parsed as T, rawText };
    }

    // Transient 3043 — log once and retry
    if (attempt === 0) {
      console.warn(
        `[live-test] ${method} ${url} hit CF Workers AI 3043 — retrying (max ${MAX_3043_RETRIES}x at ${RETRY_3043_DELAY_MS}ms).`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_3043_DELAY_MS));
  }

  // Unreachable — loop returns on terminal attempt.
  return {
    status: lastStatus,
    ok: false,
    body: { _raw: lastRawText } as unknown as T,
    rawText: lastRawText,
  };
}

/**
 * Assert the call returned the expected HTTP status and return its body.
 * On failure, the vitest error message includes the label, status, hint, and
 * the response body (truncated) so the user can diagnose without `wrangler tail`.
 */
export function expectOk<T>(result: ApiResult<T>, label: string, expected = 200): T {
  expect(
    result.status,
    `${label} expected HTTP ${expected} but got ${result.status}. ${statusHint(result.status, result.rawText)}`,
  ).toBe(expected);
  return result.body;
}
