/**
 * Limits that keep one listener from being exhausted by idle or hostile
 * connections, and the address FTP passive mode tells clients to use.
 */
import { DatabaseManager } from './database';

export const DEFAULT_MAX_CONNECTIONS = 200;
/** SSH clients must finish signing in within this time (SLIGHTSFTP_PRE_AUTH_TIMEOUT_MS overrides). */
export const PRE_AUTH_TIMEOUT_MS = 30_000;

export function preAuthTimeoutMs(): number {
  const n = Number(process.env.SLIGHTSFTP_PRE_AUTH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : PRE_AUTH_TIMEOUT_MS;
}

/** Concurrent connections allowed per listener (setting maxConnectionsPerListener). */
export function maxConnections(db: DatabaseManager): number {
  const n = Number(db.getSetting?.('maxConnectionsPerListener'));
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_CONNECTIONS;
}

const WILDCARDS = new Set(['', '0.0.0.0', '::', '::0', '[::]']);

export function isWildcardAddress(address: string | undefined | null): boolean {
  return WILDCARDS.has(String(address ?? '').trim());
}

/** "::ffff:10.0.0.5" → "10.0.0.5" (PASV replies only carry IPv4). */
function plainIpv4(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const v = address.startsWith('::ffff:') ? address.slice(7) : address;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : undefined;
}

/**
 * What FTP passive mode should advertise:
 * - FTP_PASV_URL when set (NAT / containers),
 * - the listener's binding address when it is a specific address,
 * - otherwise the local address the client's control connection reached, so
 *   a listener on 0.0.0.0 no longer tells clients to connect to "0,0,0,0".
 * `localAddressFor(clientIp)` looks up that control connection's local address.
 */
export function passiveAddressResolver(
  bindingIp: string,
  localAddressFor: (clientIp: string) => string | undefined,
  envUrl = process.env.FTP_PASV_URL,
): string | ((clientIp: string) => string) {
  if (envUrl) return envUrl;
  if (!isWildcardAddress(bindingIp)) return bindingIp;
  return (clientIp: string) => plainIpv4(localAddressFor(clientIp)) || '127.0.0.1';
}
