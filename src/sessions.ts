/**
 * Sign-in sessions of the web admin GUI and the file portal, kept in the
 * configuration database so a restart (an update, a crash, a container
 * reschedule) does not sign everyone out.
 *
 * The cookie carries a random 256-bit token; only its SHA-256 is stored, so
 * someone who reads config.db or a backup cannot take over a session.
 */
import * as crypto from 'crypto';
import { DatabaseManager, StoredSession } from './database';

export type SessionKind = 'admin' | 'portal';

export interface Session {
  username: string;
  createdAt: number;
  /** set until the user replaces the default / admin-reset password */
  mustChangePassword: boolean;
}

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
  constructor(private readonly db: DatabaseManager, readonly kind: SessionKind, readonly ttlMs: number) {}

  create(token: string, session: Session): void {
    this.db.createSession({ kind: this.kind, tokenHash: hashToken(token), ...session });
  }

  /** The session for a cookie token, or undefined (unknown or expired). */
  get(token: string | undefined): Session | undefined {
    if (!token || typeof token !== 'string') return undefined;
    const stored = this.db.getSession(this.kind, hashToken(token));
    if (!stored) return undefined;
    if (Date.now() - stored.createdAt > this.ttlMs) {
      this.db.deleteSession(this.kind, stored.tokenHash);
      return undefined;
    }
    return { username: stored.username, createdAt: stored.createdAt, mustChangePassword: stored.mustChangePassword };
  }

  has(token: string | undefined): boolean {
    return this.get(token) !== undefined;
  }

  delete(token: string | undefined): void {
    if (token && typeof token === 'string') this.db.deleteSession(this.kind, hashToken(token));
  }

  passwordChanged(token: string): void {
    this.db.updateSession(this.kind, hashToken(token), { mustChangePassword: false });
  }

  /** End every session of a user, optionally keeping one (the caller's). */
  deleteForUser(username: string, exceptToken?: string): void {
    this.db.deleteSessionsForUser(this.kind, username, exceptToken ? hashToken(exceptToken) : undefined);
  }

  /** Forget expired sessions. */
  sweep(): void {
    this.db.deleteSessionsBefore(this.kind, Date.now() - this.ttlMs);
  }
}

export type { StoredSession };
