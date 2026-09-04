/**
 * Password auth for the panel.
 *
 * The panel can start and stop broadcasts and holds the stream key
 * and Jellyfin API key, so it is not something to leave open on a port.
 *
 * Hashes with Argon2id, which node 26 provides in core — so no native addon,
 * no compiler in the image, and no rebuild on a node bump. That was the whole
 * reason bcrypt was passed over originally and scrypt chosen instead; core
 * support removes the trade entirely.
 */

import { argon2, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const argon2Async = promisify(argon2);

const SALT_BYTES = 16;
const TAG_BYTES = 32;

/**
 * OWASP's floor: 19 MiB, two passes. Deliberately not the heavier 64 MiB
 * profile — this runs on an N100 beside the encoders that keep a broadcast
 * alive, and the login limiter allows several attempts before throttling, so
 * the memory is multiplied by whatever arrives at once. At these settings a
 * hash costs about 19ms.
 */
const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: TAG_BYTES };
const PREFIX = 'argon2id';
/** Sessions live in memory — a restart logs everyone out, which is fine. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessions = new Map(); // token -> { createdAt }

/**
 * Hash a password for storage.
 *
 * The stored string carries its own parameters —
 * "argon2id$m=19456,t=2,p=1$<salt>$<tag>" — so raising them later does not
 * invalidate every existing password; old ones keep verifying against the
 * settings they were made with.
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const tag = await argon2Async(PREFIX, { ...ARGON, message: Buffer.from(password, 'utf8'), nonce: salt });
  return `${PREFIX}$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}`
    + `$${salt.toString('hex')}$${tag.toString('hex')}`;
}

/** Constant-time check of a password against a stored hash. */
export async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [, params, saltHex, tagHex] = String(stored).split('$');
  if (!params || !saltHex || !tagHex) return false;
  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(params);
  if (!m) return false;

  const expected = Buffer.from(tagHex, 'hex');
  // Hex parsing is lenient — it stops at the first bad character rather than
  // throwing — so the length check is what actually rejects a mangled value.
  if (!expected.length || expected.length * 2 !== tagHex.length) return false;

  try {
    const derived = await argon2Async(PREFIX, {
      message: Buffer.from(password, 'utf8'),
      nonce: Buffer.from(saltHex, 'hex'),
      memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]),
      tagLength: expected.length,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function validSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  sessions.delete(token);
}

/** End every session except the caller's — used when the password changes. */
export function destroyOtherSessions(keep) {
  for (const token of sessions.keys()) if (token !== keep) sessions.delete(token);
}

// Expired sessions are otherwise only dropped when that exact token is
// presented again, so a long-lived process accumulates them forever.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}, 60 * 60 * 1000);
sweep.unref?.();

/** Pull the session token from a cookie header or Authorization bearer. */
export function tokenFromRequest(req) {
  const auth = req.headers?.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  const cookie = req.headers?.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'jsr_session') return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Express middleware.
 *
 * Before a password exists, only the two endpoints first-run setup needs are
 * reachable — everything else answers 401. An unconfigured panel used to pass
 * EVERY request through so setup could not lock itself out, which meant a
 * fresh container published on 0.0.0.0 handed the whole API (filesystem
 * browser, config writes, broadcast control) to anyone on the network until
 * its owner happened to set a password. The gate now demands one first, so
 * that window does not exist.
 */
const SETUP_OPEN = new Set(['/auth/status', '/auth/setup']);

export function requireAuth(getPasswordHash, isDisabled = () => false) {
  return (req, res, next) => {
    // "auth": {"disabled": true} in config.json switches the gate off
    // entirely — for test machines and single-user LANs where the operator
    // decides the port is trusted. It must be set by hand in the file; the
    // API can never write it, so a compromised session cannot make itself
    // permanent by turning the lock off.
    if (isDisabled()) return next();
    if (validSession(tokenFromRequest(req))) return next();
    // req.path is relative to the mount point ('/api'), so these are
    // /api/auth/status and /api/auth/setup.
    if (!getPasswordHash() && SETUP_OPEN.has(req.path)) return next();
    res.status(401).json({ error: 'Not authenticated' });
  };
}

/**
 * Per-IP throttle for password attempts.
 *
 * Two reasons, and the second is the sharper one. An 8-character minimum with
 * no lockout is guessable online; and every attempt runs a memory-hard hash
 * on libuv's 4-thread pool, so unauthenticated request spam starves the same
 * pool the broadcast's file I/O uses, and allocates ~19 MiB a time while it
 * does. Failures cost budget, successes clear it.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map(); // ip -> { count, first }

/** @returns {number} seconds to wait, or 0 when the attempt may proceed. */
export function throttleCheck(ip) {
  const rec = attempts.get(ip);
  if (!rec) return 0;
  const age = Date.now() - rec.first;
  if (age > ATTEMPT_WINDOW_MS) { attempts.delete(ip); return 0; }
  if (rec.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((ATTEMPT_WINDOW_MS - age) / 1000);
}

export function throttleFail(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
    return;
  }
  rec.count += 1;
  // Unbounded growth would be a memory leak on a panel under attack from many
  // addresses (an IPv6 /64 makes buckets cheap). Prune expired entries first,
  // and if that is not enough, drop the oldest — losing a little history is
  // better than growing without bound.
  if (attempts.size > 5000) {
    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
    if (attempts.size > 5000) {
      const oldest = [...attempts.entries()].sort((a, b) => a[1].first - b[1].first);
      for (const [k] of oldest.slice(0, attempts.size - 5000)) attempts.delete(k);
    }
  }
}

export function throttleReset(ip) {
  attempts.delete(ip);
}

export const SESSION_COOKIE = 'jsr_session';
export function sessionCookie(token, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
