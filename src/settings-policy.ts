/**
 * Which settings the generic settings API may read and write.
 *
 * Security-relevant settings (brute-force protection, LDAP, syslog, recycle
 * bin, audit) have their own validated endpoints; the generic
 * `PUT /api/settings/:key` only accepts the keys below, and secrets are never
 * returned by the generic read endpoints.
 */

import { cleanTrustProxy } from './http-security';

/** Never sent to a client by the generic settings endpoints. */
export const SECRET_SETTINGS: ReadonlySet<string> = new Set(['ldapBindPassword', 'backupPassphrase']);

/** Keys the generic settings endpoint may change. */
export const WRITABLE_SETTINGS: ReadonlySet<string> = new Set([
  'logRetentionDays',
  'webHttps',
  'tlsCertPath',
  'tlsKeyPath',
  'setupComplete',
  'trustProxy',
  'maxConnectionsPerListener',
]);

export function isWritableSetting(key: string): boolean {
  return WRITABLE_SETTINGS.has(key);
}

/** Settings with secrets removed, for clients. */
export function publicSettings(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!SECRET_SETTINGS.has(key)) out[key] = value;
  }
  return out;
}

/** Validate a value for a writable setting; returns an error message or null. */
export function validateSetting(key: string, value: string): string | null {
  if (!isWritableSetting(key)) return `The setting "${key}" cannot be changed here`;
  switch (key) {
    case 'logRetentionDays': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 3650 ? null : 'Log retention must be a whole number of days between 1 and 3650';
    }
    case 'maxConnectionsPerListener': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 100000 ? null : 'Connections per listener must be a whole number between 1 and 100000';
    }
    case 'trustProxy':
      try { cleanTrustProxy(value); return null; } catch (err: any) { return err.message; }
    case 'webHttps':
    case 'setupComplete':
      return value === 'true' || value === 'false' ? null : `${key} must be "true" or "false"`;
    default:
      return value.length <= 4096 ? null : 'Value is too long';
  }
}
