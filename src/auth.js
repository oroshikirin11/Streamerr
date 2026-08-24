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
 * Express middleware. Requests pass when no password is configured yet —
 * otherwise first-run setup would be locked out of its own panel.
 */
export function requireAuth(getPasswordHash) {
  return (req, res, next) => {
    if (!getPasswordHash()) return next(); // not yet configured
    if (validSession(tokenFromRequest(req))) return next();
    res.status(401).json({ error: 'Not authenticated' });
  };
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
