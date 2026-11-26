/**
 * GUI roles. Administrators can change everything; read-only users ("viewer")
 * can watch the dashboard (listeners, users, sessions, activity, settings)
 * but change nothing, and cannot download users' files or configuration
 * backups (which contain password hashes and keys). Everyone can manage their
 * own sign-in: password, two-factor, personal API tokens.
 *
 * Enforced on the server for the REST API and for the desktop app's IPC.
 */
import { DatabaseManager } from './database';
import { GuiRole, User } from './types';

export const READ_ONLY_ERROR = 'This account is read-only';

export function guiRoleFrom(value: unknown): GuiRole {
  return value === 'viewer' ? 'viewer' : 'admin';
}

export function isReadOnly(user: Pick<User, 'guiRole'> | undefined | null): boolean {
  return user?.guiRole === 'viewer';
}

/** Read endpoints a viewer may still not use: users' file contents and full backups. */
const VIEWER_DENIED_READS = [/^\/backup$/, /^\/files\/download$/];

/** Self-service writes everyone may make. */
const SELF_SERVICE_WRITES: Array<[string, RegExp]> = [
  ['POST', /^\/change-password$/],
  ['POST', /^\/logout$/],
  ['POST', /^\/2fa\/(setup|enable|disable)$/],
  ['POST', /^\/tokens$/],
  ['DELETE', /^\/tokens\/[^/]+$/],
];

/** May a read-only user make this request? `path` is relative to /api. */
export function viewerMayCallApi(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return !VIEWER_DENIED_READS.some(re => re.test(path));
  return SELF_SERVICE_WRITES.some(([verb, re]) => verb === m && re.test(path));
}

/** Desktop IPC channels usable before signing in. */
export const PRE_LOGIN_CHANNELS: ReadonlySet<string> = new Set([
  'authenticate-user', 'set-first-login-password', 'get-authenticated-user', 'logout',
]);

/** Desktop IPC channels a read-only user may use (besides get-*). */
const VIEWER_CHANNELS: ReadonlySet<string> = new Set([
  'browse-files', 'check-for-update', 'open-external', 'save-activity-log', 'logout',
  'totp-setup', 'totp-enable', 'totp-disable',
  'create-api-token', 'revoke-api-token',
]);

export function viewerMayInvoke(channel: string): boolean {
  return (channel.startsWith('get-') || VIEWER_CHANNELS.has(channel));
}

const isGuiAdmin = (u: User) => u.guiEnabled && !isReadOnly(u);

/**
 * Refuse a change that would leave nobody able to administer the server
 * (deleting, demoting or locking out the last GUI administrator).
 */
export function assertAdminRemains(db: DatabaseManager, username: string, change: Partial<User> | 'delete'): void {
  const target = db.getUser(username);
  if (!target || !isGuiAdmin(target)) return;
  const after = change === 'delete' ? null : { ...target, ...change };
  if (after && isGuiAdmin(after as User)) return;
  const others = db.getAllUsers().filter(u => u.username !== username && isGuiAdmin(u));
  if (others.length === 0) {
    throw new Error('This is the last administrator: give another user GUI access as administrator first');
  }
}
