/**
 * Password auth for the panel.
 *
 * The panel can start and stop broadcasts and holds the Owncast stream key
 * and Jellyfin API key, so it is not something to leave open on a port.
 *
 * Uses scrypt from node's crypto rather than bcrypt: bcrypt is a native
 * addon, which would mean a compiler in the image and a rebuild on every
 * Node version bump. scrypt is memory-hard, in the standard library, and
 * entirely adequate for a single-admin panel.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const KEYLEN = 64;
const SALT_BYTES = 16;
/** Sessions live in memory — a restart logs everyone out, which is fine. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sessions = new Map(); // token -> { createdAt }

/** Hash a password for storage. Returns "salt:hash", both hex. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time check of a password against a stored "salt:hash". */
export async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;

  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;

  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEYLEN);
  return timingSafeEqual(derived, expected);
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

export function requireAuth(getPasswordHash) {
  return (req, res, next) => {
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
 * no lockout is guessable online; and every attempt runs scrypt on libuv's
 * 4-thread pool, so unauthenticated request spam starves the same pool the
 * broadcast's file I/O uses. Failures cost budget, successes clear it.
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
  // Unbounded growth would be a memory leak on a panel under attack from
  // many addresses; the window expiry above only prunes what is touched.
  if (attempts.size > 5000) {
    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    for (const [k, v] of attempts) if (v.first < cutoff) attempts.delete(k);
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
