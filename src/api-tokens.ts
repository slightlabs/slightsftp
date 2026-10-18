/**
 * Personal access tokens for the REST API ("Authorization: Bearer sst_...").
 * Tokens are random 256-bit values; only their SHA-256 is stored, so a token
 * is shown exactly once, when it is created.
 */
import * as crypto from 'crypto';
import { DatabaseManager } from './database';

export const TOKEN_PREFIX = 'sst_';

export interface ApiTokenInfo {
  id: number;
  username: string;
  name: string;
  /** first characters, to recognise a token in lists */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createApiToken(db: DatabaseManager, username: string, name: unknown, expiresInDays?: unknown): { token: string; info: ApiTokenInfo } {
  const label = String(name ?? '').trim();
  if (!label || label.length > 100) throw new Error('Give the token a name (up to 100 characters)');
  let expiresAt: string | null = null;
  if (expiresInDays !== undefined && expiresInDays !== null && String(expiresInDays) !== '') {
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Expiry must be between 1 and 3650 days');
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = db.addApiToken({ username, name: label, tokenHash: hashToken(token), hint: token.slice(0, 10), expiresAt });
  return { token, info: db.listApiTokens(username).find(t => t.id === id)! };
}

/** Resolve a bearer token to its user name, or null when invalid / expired. */
export function authenticateToken(db: DatabaseManager, token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = db.findApiToken(hashToken(token));
  if (!row) return null;
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
  db.touchApiToken(row.id);
  return row.username;
}
