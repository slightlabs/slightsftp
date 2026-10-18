import * as crypto from 'crypto';

/**
 * Password hashing: scrypt with a random per-password salt.
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`.
 * Hashes from versions before 1.3 are unsalted SHA-256 hex strings; they still
 * verify and are reported as needing a rehash so callers can upgrade them.
 */
const PREFIX = 'scrypt';
const KEY_LENGTH = 32;
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };
const LEGACY_SHA256 = /^[0-9a-f]{64}$/i;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = DEFAULT_PARAMS;
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N, r, p });
  return [PREFIX, N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function isLegacyHash(stored: string | null | undefined): boolean {
  return !!stored && LEGACY_SHA256.test(stored);
}

export interface PasswordCheck {
  valid: boolean;
  /** true when the stored hash uses an outdated scheme and should be replaced */
  needsRehash: boolean;
}

export function verifyPasswordHash(stored: string | null | undefined, password: string): PasswordCheck {
  if (!stored || typeof password !== 'string' || password.length === 0) {
    return { valid: false, needsRehash: false };
  }

  if (isLegacyHash(stored)) {
    const candidate = crypto.createHash('sha256').update(password).digest();
    const valid = crypto.timingSafeEqual(candidate, Buffer.from(stored, 'hex'));
    return { valid, needsRehash: valid };
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return { valid: false, needsRehash: false };
  }
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  let candidate: Buffer;
  try {
    candidate = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, params);
  } catch {
    return { valid: false, needsRehash: false };
  }
  const valid = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  const outdated = params.N !== DEFAULT_PARAMS.N || params.r !== DEFAULT_PARAMS.r || params.p !== DEFAULT_PARAMS.p;
  return { valid, needsRehash: valid && outdated };
}

/** The well-known password of the seeded `admin` account. */
export const DEFAULT_ADMIN_PASSWORD = 'admin123';
export const MIN_PASSWORD_LENGTH = 8;

/** Returns an error message when `password` is not acceptable as a new password. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password === DEFAULT_ADMIN_PASSWORD) {
    return 'Choose a password other than the default one';
  }
  return null;
}

/**
 * A user must choose a new password when an admin flagged the account, or when
 * they just signed in with the published default password.
 */
export function requiresPasswordChange(user: { mustChangePassword?: boolean }, passwordUsed: string): boolean {
  return !!user.mustChangePassword || passwordUsed === DEFAULT_ADMIN_PASSWORD;
}
