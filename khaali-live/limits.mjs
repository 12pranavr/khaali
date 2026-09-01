// Rate limiting for the five routes that cost money per call.
//
// Text-to-speech, speech-to-text, the copilot and the two narrators each
// spend a paid credit on every request, and none of them had a limit. Anyone
// could hold a key in a loop until the balance hit zero, and the Sarvam key
// has already died once. This is a fixed-window counter per caller: cheap,
// no dependencies, and it fails safe by letting the request through when the
// caller cannot be identified rather than blocking everyone behind a proxy.

const buckets = new Map();               // key -> { n, resetAt }
let sweepAt = Date.now();

/**
 * Count one hit for `key`. Returns { ok: true } while under `limit` in the
 * current window, otherwise { ok: false, retryAfter } in seconds.
 */
export function hit(key, limit = 20, windowMs = 60000, now = Date.now()) {
  if (now - sweepAt > windowMs) {        // forget quiet callers now and then
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    sweepAt = now;
  }
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) { b = { n: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (b.n <= limit) return { ok: true, remaining: limit - b.n };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

/** The caller behind a proxy, else the socket. Railway sets x-forwarded-for. */
export function callerOf(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Test helper. */
export function reset() { buckets.clear(); }
