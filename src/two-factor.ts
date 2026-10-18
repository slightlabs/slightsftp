/**
 * Two-factor sign-in (TOTP) shared by the desktop app, the web admin GUI and
 * the file portal: self-service setup, verification with replay protection,
 * and safe user objects for clients.
 */
import QRCode from 'qrcode';
import { DatabaseManager } from './database';
import { TotpReplayGuard, generateTotpSecret, otpauthUrl, verifyTotp } from './totp';
import { User } from './types';

const replayGuards = new WeakMap<DatabaseManager, TotpReplayGuard>();

function replayGuard(db: DatabaseManager): TotpReplayGuard {
  let guard = replayGuards.get(db);
  if (!guard) {
    guard = new TotpReplayGuard();
    replayGuards.set(db, guard);
  }
  return guard;
}

export type SecondFactorResult = 'ok' | 'required' | 'invalid';

/** Check the second factor for a user who already passed the password check. */
export function checkSecondFactor(db: DatabaseManager, user: User, code: unknown): SecondFactorResult {
  if (!user.totpEnabled || !user.totpSecret) return 'ok';
  if (code === undefined || code === null || String(code).trim() === '') return 'required';
  return replayGuard(db).check(user.username, user.totpSecret, code) ? 'ok' : 'invalid';
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}

/** Start (or restart) setup: a new pending secret the user must confirm. */
export async function beginTotpSetup(db: DatabaseManager, username: string): Promise<TotpSetup> {
  const secret = generateTotpSecret();
  db.updateUser(username, { totpPendingSecret: secret });
  const url = otpauthUrl(secret, username);
  return { secret, otpauthUrl: url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }) };
}

/** Confirm setup with a code from the authenticator app. */
export function confirmTotpSetup(db: DatabaseManager, username: string, code: unknown): boolean {
  const user = db.getUser(username);
  if (!user?.totpPendingSecret) return false;
  if (verifyTotp(user.totpPendingSecret, code) === null) return false;
  db.updateUser(username, { totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true });
  // the confirmation code may not be reused to sign in
  replayGuard(db).check(username, user.totpPendingSecret, code);
  return true;
}

/** Turn 2FA off; requires a current code when it is on. */
export function disableTotp(db: DatabaseManager, username: string, code: unknown): boolean {
  const user = db.getUser(username);
  if (!user) return false;
  if (user.totpEnabled && checkSecondFactor(db, user, code) !== 'ok') return false;
  db.updateUser(username, { totpEnabled: false });
  return true;
}

/** Never send password hashes or TOTP secrets to a client. */
export function publicUser<T extends Partial<User>>(user: T): Omit<T, 'password' | 'totpSecret' | 'totpPendingSecret'> {
  const { password: _p, totpSecret: _s, totpPendingSecret: _ps, ...rest } = user;
  return rest;
}
