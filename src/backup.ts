/**
 * Configuration backup / restore: one JSON file with the configuration
 * database plus the SFTP host key and TLS certificate, so a restored server
 * keeps its identity. The master key that encrypts the stored secrets goes
 * with it (unless it comes from SLIGHTSFTP_MASTER_KEY, which the operator
 * manages), so the bundle restores on a new machine.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { CERT_FILE, KEY_FILE, SSH_HOST_KEY_FILE, getCertificateDir, setCertificateDir } from './tls';
import { SECRET_KEY_FILE, SecretBox } from './secret-box';

export const BACKUP_FORMAT = 'slightsftp-backup';
export const ENCRYPTED_BACKUP_FORMAT = 'slightsftp-backup-encrypted';

/** The backup is encrypted and no (or the wrong) passphrase was given. */
export class BackupPassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupPassphraseError';
  }
}

export interface EncryptedBackup {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string; // base64 ciphertext of the JSON BackupBundle
}

// scrypt cost for backup passphrases (OWASP: N=2^17, r=8, p=1)
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;

function backupKey(passphrase: string, kdf: EncryptedBackup['kdf']): Buffer {
  const { N, r, p } = kdf;
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) {
    throw new Error('This is not a SLightSFTP configuration backup');
  }
  return crypto.scryptSync(passphrase, Buffer.from(kdf.salt, 'base64'), 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** Encrypt a bundle with a passphrase (AES-256-GCM, key from scrypt). */
export function encryptBackup(bundle: BackupBundle, passphrase: string): EncryptedBackup {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new BackupPassphraseError(`Choose a backup passphrase of at least ${MIN_PASSPHRASE} characters`);
  }
  const kdf = { name: 'scrypt' as const, ...SCRYPT, salt: crypto.randomBytes(16).toString('base64') };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', backupKey(passphrase, kdf), iv);
  // the header is authenticated too: changing the KDF parameters breaks decryption
  cipher.setAAD(Buffer.from(ENCRYPTED_BACKUP_FORMAT));
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: 1,
    createdAt: bundle.createdAt,
    kdf,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function isEncryptedBackup(value: any): value is EncryptedBackup {
  return !!value && value.format === ENCRYPTED_BACKUP_FORMAT;
}

export function decryptBackup(encrypted: EncryptedBackup, passphrase: string | undefined): BackupBundle {
  if (!passphrase) throw new BackupPassphraseError('This backup is encrypted: enter its passphrase');
  if (encrypted.cipher !== 'aes-256-gcm' || encrypted.kdf?.name !== 'scrypt') {
    throw new Error('This is not a SLightSFTP configuration backup');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey(passphrase, encrypted.kdf), Buffer.from(encrypted.iv, 'base64'));
    decipher.setAAD(Buffer.from(ENCRYPTED_BACKUP_FORMAT));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (err) {
    if (err instanceof BackupPassphraseError) throw err;
    throw new BackupPassphraseError('Wrong passphrase for this backup');
  }
}

/** A backup for download: encrypted when a passphrase is given. */
export function exportBackup(db: DatabaseManager, appVersion: string, passphrase?: string): BackupBundle | EncryptedBackup {
  const bundle = createBackup(db, appVersion);
  return passphrase ? encryptBackup(bundle, passphrase) : bundle;
}

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  createdAt: string;
  database: string; // base64 SQLite
  files: Record<string, string>; // base64, keyed by file name
}

const KEY_FILES = [SSH_HOST_KEY_FILE, CERT_FILE, KEY_FILE];

export function createBackup(db: DatabaseManager, appVersion: string): BackupBundle {
  const dir = getCertificateDir();
  const files: Record<string, string> = {};
  for (const name of KEY_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) files[name] = fs.readFileSync(p).toString('base64');
  }
  const box = db.secretBox;
  if (box.source === 'file') files[SECRET_KEY_FILE] = Buffer.from(box.exportKey()).toString('base64');
  return {
    format: BACKUP_FORMAT,
    version: 1,
    appVersion,
    createdAt: new Date().toISOString(),
    database: db.exportBytes().toString('base64'),
    files,
  };
}

/** Restore a bundle into the running server; returns a short summary. */
export async function restoreBackup(db: DatabaseManager, bundle: any, passphrase?: string): Promise<{ users: number; listeners: number; restoredFiles: string[] }> {
  if (isEncryptedBackup(bundle)) bundle = decryptBackup(bundle, passphrase);
  if (!bundle || bundle.format !== BACKUP_FORMAT || typeof bundle.database !== 'string') {
    throw new Error('This is not a SLightSFTP configuration backup');
  }
  // the backup's master key first: restoring re-seals any plaintext secrets with it
  const restoredFiles: string[] = [];
  const key = bundle.files?.[SECRET_KEY_FILE];
  const box = db.secretBox;
  if (typeof key === 'string' && box.source === 'file' && box.keyFile) {
    const restored = SecretBox.fromKey(Buffer.from(Buffer.from(key, 'base64').toString('utf8').trim(), 'base64'));
    fs.writeFileSync(box.keyFile, restored.exportKey(), { mode: 0o600 });
    db.useSecretBox(SecretBox.forDatabase(path.join(path.dirname(box.keyFile), 'config.db')));
    restoredFiles.push(SECRET_KEY_FILE);
  }
  await db.restoreFrom(Buffer.from(bundle.database, 'base64'));

  const dir = getCertificateDir();
  for (const name of KEY_FILES) {
    const content = bundle.files?.[name];
    if (typeof content !== 'string') continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(content, 'base64'), { mode: name === CERT_FILE ? 0o644 : 0o600 });
    restoredFiles.push(name);
  }
  setCertificateDir(dir); // drop cached keys / certificates so the restored ones are used
  return { users: db.getAllUsers().length, listeners: db.getAllListeners().length, restoredFiles };
}
