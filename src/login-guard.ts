/**
 * Brute-force protection shared by every login surface (SFTP, FTP, web admin,
 * file portal, share-link passwords): after too many failed attempts from one
 * IP address within a time window, that address is banned for a while.
 *
 * Bans are stored in the database so they survive restarts and can be listed
 * and lifted from the GUI. Addresses on the allow-list (loopback by default)
 * are never banned.
 */
import * as net from 'net';
import { DatabaseManager } from './database';

export interface GuardSettings {
  enabled: boolean;
  maxFailures: number;
  windowMinutes: number;
  banMinutes: number;
  allowlist: string;
}

export const GUARD_DEFAULTS: GuardSettings = {
  enabled: true,
  maxFailures: 5,
  windowMinutes: 10,
  banMinutes: 15,
  allowlist: '127.0.0.0/8, ::1',
};

export interface IpBan {
  ip: string;
  reason: string;
  bannedAt: string;
  expiresAt: string;
}

/** "::ffff:10.0.0.1" → "10.0.0.1"; trims whitespace. */
export function normalizeIp(ip: string | undefined | null): string {
  const value = String(ip || '').trim();
  return value.startsWith('::ffff:') && net.isIPv4(value.slice(7)) ? value.slice(7) : value;
}

/**
 * Parse "10.0.0.0/8, 192.168.1.5, 2001:db8::/32" into a BlockList.
 * Invalid entries are reported in `invalid`.
 */
export function parseCidrList(list: string | undefined | null): { blockList: net.BlockList; entries: string[]; invalid: string[] } {
  const blockList = new net.BlockList();
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const raw of String(list || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)) {
    const [address, prefixText] = raw.split('/');
    const ip = normalizeIp(address);
    const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    if (!type) { invalid.push(raw); continue; }
    if (prefixText === undefined) {
      blockList.addAddress(ip, type);
    } else {
      const prefix = Number(prefixText);
      const max = type === 'ipv4' ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) { invalid.push(raw); continue; }
      blockList.addSubnet(ip, prefix, type);
    }
    entries.push(raw);
  }
  return { blockList, entries, invalid };
}

export function ipInList(ip: string, list: net.BlockList): boolean {
  const value = normalizeIp(ip);
  if (net.isIPv4(value)) return list.check(value, 'ipv4');
  if (net.isIPv6(value)) return list.check(value, 'ipv6');
  return false;
}

export class LoginGuard {
  private failures = new Map<string, number[]>();

  constructor(private db: DatabaseManager) {}

  settings(): GuardSettings {
    const get = (key: string) => this.db.getSetting(key);
    const num = (key: string, fallback: number) => {
      const n = Number(get(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      enabled: (get('bruteForceEnabled') ?? 'true') !== 'false',
      maxFailures: num('bruteForceMaxFailures', GUARD_DEFAULTS.maxFailures),
      windowMinutes: num('bruteForceWindowMinutes', GUARD_DEFAULTS.windowMinutes),
      banMinutes: num('bruteForceBanMinutes', GUARD_DEFAULTS.banMinutes),
      allowlist: get('ipAllowlist') ?? GUARD_DEFAULTS.allowlist,
    };
  }

  private allowlisted(ip: string): boolean {
    return ipInList(ip, parseCidrList(this.settings().allowlist).blockList);
  }

  /** Is this address currently banned? */
  isBanned(ip: string | undefined | null): boolean {
    const value = normalizeIp(ip);
    if (!value || !this.settings().enabled || this.allowlisted(value)) return false;
    const ban = this.db.getIpBan(value);
    if (!ban) return false;
    if (Date.parse(ban.expiresAt) <= Date.now()) {
      this.db.deleteIpBan(value);
      return false;
    }
    return true;
  }

  /** Record a failed login; returns true when this attempt caused a ban. */
  recordFailure(ip: string | undefined | null, source: string, username?: string): boolean {
    const value = normalizeIp(ip);
    const s = this.settings();
    if (!value || !s.enabled || this.allowlisted(value)) return false;

    const now = Date.now();
    const windowStart = now - s.windowMinutes * 60_000;
    const recent = (this.failures.get(value) || []).filter(t => t > windowStart);
    recent.push(now);
    this.failures.set(value, recent);

    if (recent.length < s.maxFailures || this.isBanned(value)) return false;

    const expiresAt = new Date(now + s.banMinutes * 60_000).toISOString();
    const reason = `${recent.length} failed logins in ${s.windowMinutes} min (last: ${source}${username ? ' as ' + username : ''})`;
    this.db.addIpBan({ ip: value, reason, bannedAt: new Date(now).toISOString(), expiresAt });
    this.failures.delete(value);
    this.db.logActivity({ listenerId: null, username: username || 'unknown', action: 'IP_BANNED', path: `${value} until ${expiresAt}: ${reason}`, success: false });
    return true;
  }

  /** A successful login clears the address's failure count. */
  recordSuccess(ip: string | undefined | null): void {
    this.failures.delete(normalizeIp(ip));
  }

  unban(ip: string): void {
    const value = normalizeIp(ip);
    this.db.deleteIpBan(value);
    this.failures.delete(value);
  }

  listBans(): IpBan[] {
    const now = Date.now();
    return this.db.listIpBans().filter(b => Date.parse(b.expiresAt) > now);
  }
}

const guards = new WeakMap<DatabaseManager, LoginGuard>();

/** One guard per database, shared by every server in the process. */
export function getLoginGuard(db: DatabaseManager): LoginGuard {
  let guard = guards.get(db);
  if (!guard) {
    guard = new LoginGuard(db);
    guards.set(db, guard);
  }
  return guard;
}

export const TOO_MANY_ATTEMPTS = 'Too many failed attempts. Try again later.';

/** Validate and store guard settings from the GUI / API. */
export function saveGuardSettings(db: DatabaseManager, input: Partial<GuardSettings>): void {
  const positive = (v: unknown, name: string, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be a whole number between 1 and ${max}`);
    return String(n);
  };
  if (input.allowlist !== undefined) {
    const { invalid } = parseCidrList(input.allowlist);
    if (invalid.length) throw new Error(`Invalid address or range: ${invalid.join(', ')}`);
  }
  if (input.enabled !== undefined) db.setSetting('bruteForceEnabled', input.enabled ? 'true' : 'false');
  if (input.maxFailures !== undefined) db.setSetting('bruteForceMaxFailures', positive(input.maxFailures, 'Failed attempts', 1000));
  if (input.windowMinutes !== undefined) db.setSetting('bruteForceWindowMinutes', positive(input.windowMinutes, 'Window', 1440));
  if (input.banMinutes !== undefined) db.setSetting('bruteForceBanMinutes', positive(input.banMinutes, 'Ban duration', 525600));
  if (input.allowlist !== undefined) db.setSetting('ipAllowlist', String(input.allowlist));
}

/** Per-user allow-list: true when the user has none, or `ip` is inside it. */
export function userIpAllowed(user: { allowedIps?: string | null }, ip: string | undefined | null): boolean {
  if (!user.allowedIps || !String(user.allowedIps).trim()) return true;
  return ipInList(normalizeIp(ip), parseCidrList(user.allowedIps).blockList);
}

/** Validate an allowed-IPs field from a form; returns the cleaned value or null. */
export function cleanAllowedIps(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const { entries, invalid } = parseCidrList(String(value));
  if (invalid.length) throw new Error(`Invalid address or range: ${invalid.join(', ')}`);
  return entries.join(', ');
}
