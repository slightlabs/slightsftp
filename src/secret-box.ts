/**
 * Encryption at rest for the secrets kept in config.db: cloud storage
 * credentials, the LDAP bind password, webhook signing secrets and TOTP
 * secrets. Password hashes and API token hashes are already one-way.
 *
 * Values are sealed with AES-256-GCM under a master key and stored as
 * "enc:v1:<base64 iv | tag | ciphertext>". The key comes from
 *   1. SLIGHTSFTP_MASTER_KEY (64 hex characters or base64 of 32 bytes; any
 *      other string is treated as a passphrase and stretched with scrypt), or
 *   2. a key file (secret.key, owner-only) next to config.db, generated on
 *      first use.
 * Keeping the key outside the database means a copied config.db alone does
 * not reveal the secrets. Values written by older versions (plaintext) are
 * still read, and re-sealed when the database opens.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const SECRET_PREFIX = 'enc:v1:';
export const SECRET_KEY_FILE = 'secret.key';
export const MASTER_KEY_ENV = 'SLIGHTSFTP_MASTER_KEY';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** The master key is missing or wrong for a sealed value. */
export class SecretUnavailableError extends Error {
  constructor() {
    super(`A stored secret cannot be decrypted: the master key (${SECRET_KEY_FILE} or ${MASTER_KEY_ENV}) is missing or different from the one it was saved with`);
    this.name = 'SecretUnavailableError';
  }
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/** Turn SLIGHTSFTP_MASTER_KEY into 32 key bytes. */
export function keyFromEnvironment(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === KEY_BYTES) return bytes;
  }
  // a passphrase: stretch it (fixed salt, since the result must be stable)
  return crypto.scryptSync(value, 'slightsftp-master-key', KEY_BYTES);
}

export class SecretBox {
  /** Where the key came from: the environment, a key file, or memory only. */
  readonly source: 'environment' | 'file' | 'ephemeral';

  private constructor(private readonly key: Buffer, source: SecretBox['source'], readonly keyFile?: string) {
    this.source = source;
  }

  /**
   * The key for a database at dbPath. In-memory databases (tests) get a
   * throwaway key; nothing they hold outlives the process.
   */
  static forDatabase(dbPath: string, env: NodeJS.ProcessEnv = process.env): SecretBox {
    if (env[MASTER_KEY_ENV]) return new SecretBox(keyFromEnvironment(env[MASTER_KEY_ENV]!), 'environment');
    if (dbPath === ':memory:') return new SecretBox(crypto.randomBytes(KEY_BYTES), 'ephemeral');
    const keyFile = path.join(path.dirname(path.resolve(dbPath)), SECRET_KEY_FILE);
    return new SecretBox(SecretBox.loadOrCreateKeyFile(keyFile), 'file', keyFile);
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) throw new Error('A master key is 32 bytes');
    return new SecretBox(key, 'ephemeral');
  }

  private static loadOrCreateKeyFile(keyFile: string): Buffer {
    if (fs.existsSync(keyFile)) {
      const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (key.length !== KEY_BYTES) throw new Error(`${keyFile} is not a SLightSFTP master key`);
      return key;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    // 'wx': never overwrite a key another process created meanwhile
    try {
      fs.writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (err: any) {
      if (err?.code === 'EEXIST') return SecretBox.loadOrCreateKeyFile(keyFile);
      throw err;
    }
    return key;
  }

  /** The key file's contents, for configuration backups. */
  exportKey(): string {
    return this.key.toString('base64') + '\n';
  }

  seal(plain: string): string;
  seal(plain: string | null | undefined): string | null | undefined;
  seal(plain: string | null | undefined): string | null | undefined {
    if (plain === null || plain === undefined || plain === '' || isSealed(plain)) return plain;
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return SECRET_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  /** Decrypt a sealed value; plaintext from older versions passes through. */
  open(value: string): string;
  open(value: string | null | undefined): string | null | undefined;
  open(value: string | null | undefined): string | null | undefined {
    if (!isSealed(value)) return value;
    const raw = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new SecretUnavailableError();
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretUnavailableError();
    }
  }
}
