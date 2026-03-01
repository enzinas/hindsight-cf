/**
 * Optional Bearer-token authentication middleware.
 *
 * Three auth modes (checked in order):
 *
 * 1. **Single-key mode** (`HINDSIGHT_API_KEY` env var set):
 *    All tenants share one key. Bearer token must match the env var.
 *
 * 2. **Multi-tenant mode** (rows in D1 `api_keys` table):
 *    Each tenant has its own key(s). Bearer token is looked up in D1,
 *    and must belong to the tenant in the URL path `/v1/:tenant/...`.
 *
 * 3. **Open mode** (no env var, no D1 keys):
 *    All requests pass through without auth (original Hindsight default).
 */
import type { Context, Next } from 'hono';
import type { Env } from '../env';

/**
 * Constant-time string comparison (best-effort in JS).
 * Prevents timing side-channels when comparing tokens.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against b anyway to avoid short-circuit timing leak on length.
    // We'll return false regardless, but we still iterate to keep timing flat.
    let result = 1; // mismatch
    for (let i = 0; i < b.length; i++) {
      result |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Extract the Bearer token from an Authorization header, or null. */
function parseBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function bearerAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const globalKey = c.env.HINDSIGHT_API_KEY;
    const authHeader = c.req.header('Authorization');

    // ── Mode 1: Single-key via env var ──────────────────────────────────
    if (globalKey) {
      if (!authHeader) {
        return c.json(
          { error: 'unauthorized', message: 'Authorization header is required' },
          401,
        );
      }
      const token = parseBearerToken(authHeader);
      if (token === null) {
        return c.json(
          { error: 'unauthorized', message: 'Authorization header must use Bearer scheme' },
          401,
        );
      }
      if (!timingSafeEqual(token, globalKey)) {
        return c.json(
          { error: 'forbidden', message: 'Invalid API key' },
          403,
        );
      }
      await next();
      return;
    }

    // ── Mode 2: Multi-tenant via D1 api_keys ────────────────────────────
    // If a Bearer token is present, validate it against D1.
    // If no token is present, check whether any keys exist to decide
    // whether auth is enforced.
    if (authHeader) {
      const token = parseBearerToken(authHeader);
      if (token === null) {
        return c.json(
          { error: 'unauthorized', message: 'Authorization header must use Bearer scheme' },
          401,
        );
      }

      let row: { tenant_id: string; expires_at: string | null } | null = null;
      try {
        row = await c.env.DB.prepare(
          'SELECT tenant_id, expires_at FROM api_keys WHERE token = ?',
        )
          .bind(token)
          .first<{ tenant_id: string; expires_at: string | null }>();
      } catch {
        // D1 error (e.g. table missing) — reject token since we can't validate it
        return c.json(
          { error: 'internal_error', message: 'Unable to validate API key' },
          500,
        );
      }

      if (!row) {
        return c.json(
          { error: 'forbidden', message: 'Invalid API key' },
          403,
        );
      }

      // Check expiry
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return c.json(
          { error: 'forbidden', message: 'API key has expired' },
          403,
        );
      }

      // Validate tenant matches the URL path
      const tenant = c.req.param('tenant');
      if (tenant && row.tenant_id !== tenant) {
        return c.json(
          { error: 'forbidden', message: 'API key is not authorized for this tenant' },
          403,
        );
      }

      await next();
      return;
    }

    // No Authorization header and no global key — check if multi-tenant
    // auth is active (any keys in D1). If so, require auth.
    try {
      const keyCount = await c.env.DB.prepare(
        'SELECT COUNT(*) as total FROM api_keys',
      )
        .first<{ total: number }>();

      if (keyCount && keyCount.total > 0) {
        return c.json(
          { error: 'unauthorized', message: 'Authorization header is required' },
          401,
        );
      }
    } catch {
      // If api_keys table doesn't exist or D1 fails, fall through to open mode
    }

    // ── Mode 3: Open access (no keys configured anywhere) ──────────────
    await next();
  };
}
