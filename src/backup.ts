/**
 * Configuration backup / restore: one JSON file with the configuration
 * database plus the SFTP host key and TLS certificate, so a restored server
 * keeps its identity. The master key that encrypts the stored secrets goes
 * with it (unless it comes from SLIGHTSFTP_MASTER_KEY, which the operator
 * manages), so the bundle restores on a new machine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { CERT_FILE, KEY_FILE, SSH_HOST_KEY_FILE, getCertificateDir, setCertificateDir } from './tls';
import { SECRET_KEY_FILE, SecretBox } from './secret-box';

export const BACKUP_FORMAT = 'slightsftp-backup';

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
export async function restoreBackup(db: DatabaseManager, bundle: any): Promise<{ users: number; listeners: number; restoredFiles: string[] }> {
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
