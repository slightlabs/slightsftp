/**
 * Time-based one-time passwords (RFC 6238, as used by Google Authenticator,
 * Microsoft Authenticator, 1Password, ...): HMAC-SHA1, 6 digits, 30 s steps.
 */
import * as crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random 160-bit secret, base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** HOTP (RFC 4226) value for a counter. */
export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpStep(timeMs = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret: string, timeMs = Date.now()): string {
  return hotp(secret, totpStep(timeMs));
}

/**
 * Check a code, allowing one step of clock drift either way.
 * Returns the matched time step (for replay protection) or null.
 */
export function verifyTotp(secret: string, code: unknown, timeMs = Date.now(), window = 1): number | null {
  const value = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(value)) return null;
  const now = totpStep(timeMs);
  for (let delta = -window; delta <= window; delta++) {
    const candidate = hotp(secret, now + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(value))) return now + delta;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (shown as a QR code). */
export function otpauthUrl(secret: string, username: string, issuer = 'SLightSFTP'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Remembers the last accepted step per user so a code cannot be used twice. */
export class TotpReplayGuard {
  private lastStep = new Map<string, number>();

  /** Verify and consume a code. */
  check(username: string, secret: string, code: unknown, timeMs = Date.now()): boolean {
    const step = verifyTotp(secret, code, timeMs);
    if (step === null) return false;
    const last = this.lastStep.get(username);
    if (last !== undefined && step <= last) return false;
    this.lastStep.set(username, step);
    return true;
  }
}
