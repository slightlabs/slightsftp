/**
 * SSH public keys for SFTP sign-in, stored per user like an OpenSSH
 * authorized_keys file: one key per line, e.g.
 *
 *   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... alice@laptop
 *   ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB... backup-key
 *
 * A bare base64 blob (the format used before 1.4) is still accepted.
 */
import * as crypto from 'crypto';
import { utils as sshUtils } from 'ssh2';

export interface AuthorizedKey {
  type: string;
  comment: string;
  /** SHA256:... fingerprint in OpenSSH notation */
  fingerprint: string;
  /** the public key blob as sent by clients */
  blob: Buffer;
  line: string;
  verify(data: Buffer, signature: Buffer, hashAlgo?: string): boolean;
}

const KEY_TYPES = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

export function fingerprintOf(blob: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** Parse one line; returns null for blank lines / comments, throws for garbage. */
export function parseAuthorizedKey(rawLine: string): AuthorizedKey | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  const parts = line.split(/\s+/);
  let text: string;
  let comment = '';
  if (parts.length >= 2 && KEY_TYPES.test(parts[0])) {
    text = `${parts[0]} ${parts[1]}`;
    comment = parts.slice(2).join(' ');
  } else if (parts.length === 1 && /^[A-Za-z0-9+/]+=*$/.test(parts[0])) {
    // legacy: bare base64 blob; the blob itself names its type
    const blob = Buffer.from(parts[0], 'base64');
    const typeLength = blob.length > 4 ? blob.readUInt32BE(0) : 0;
    const type = typeLength > 0 && typeLength < 64 ? blob.subarray(4, 4 + typeLength).toString() : '';
    if (!KEY_TYPES.test(type)) throw new Error('Not an SSH public key');
    text = `${type} ${parts[0]}`;
  } else {
    throw new Error('Not an SSH public key');
  }

  const parsed = sshUtils.parseKey(text);
  if (!parsed || parsed instanceof Error) throw new Error(`Invalid SSH public key${parsed instanceof Error ? ': ' + parsed.message : ''}`);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key.isPrivateKey()) throw new Error('That is a private key — paste the public key (.pub) instead');
  const blob: Buffer = key.getPublicSSH();
  return {
    type: key.type,
    comment,
    fingerprint: fingerprintOf(blob),
    blob,
    line: comment ? `${key.type} ${blob.toString('base64')} ${comment}` : `${key.type} ${blob.toString('base64')}`,
    verify: (data, signature, hashAlgo) => key.verify(data, signature, hashAlgo) === true,
  };
}

/** Parse every key a user has; invalid lines are skipped (validation happens on save). */
export function parseAuthorizedKeys(text: string | null | undefined): AuthorizedKey[] {
  const keys: AuthorizedKey[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    try {
      const key = parseAuthorizedKey(line);
      if (key) keys.push(key);
    } catch { /* ignore */ }
  }
  return keys;
}

/** Validate and normalise the keys field from a form. Throws with the bad line number. */
export function cleanAuthorizedKeys(text: unknown): string {
  const out: string[] = [];
  const seen = new Set<string>();
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    let key: AuthorizedKey | null;
    try {
      key = parseAuthorizedKey(line);
    } catch (err: any) {
      throw new Error(`Line ${i + 1}: ${err.message}`);
    }
    if (key && !seen.has(key.fingerprint)) {
      seen.add(key.fingerprint);
      out.push(key.line);
    }
  });
  return out.join('\n');
}

/** Find the user's key matching the blob the client offered. */
export function findAuthorizedKey(keys: AuthorizedKey[], offered: Buffer): AuthorizedKey | undefined {
  return keys.find(k => k.blob.length === offered.length && crypto.timingSafeEqual(k.blob, offered));
}
