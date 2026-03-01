/**
 * Optional Bearer-token authentication middleware.
 *
 * Behaviour matches the original Hindsight API:
 *  - If HINDSIGHT_API_KEY is not set → all requests are allowed.
 *  - If HINDSIGHT_API_KEY is set → `Authorization: Bearer <token>` must match.
 *    - Missing/malformed header → 401
 *    - Wrong token → 403
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

export function bearerAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const expectedKey = c.env.HINDSIGHT_API_KEY;

    // No key configured → open access (matches original Hindsight default)
    if (!expectedKey) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json(
        { error: 'unauthorized', message: 'Authorization header is required' },
        401,
      );
    }

    // Parse "Bearer <token>" (case-insensitive scheme)
    const match = authHeader.match(/^bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        { error: 'unauthorized', message: 'Authorization header must use Bearer scheme' },
        401,
      );
    }

    const token = match[1];

    if (!timingSafeEqual(token, expectedKey)) {
      return c.json(
        { error: 'forbidden', message: 'Invalid API key' },
        403,
      );
    }

    await next();
  };
}
