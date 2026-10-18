/**
 * Configuration backup / restore: one JSON file with the configuration
 * database plus the SFTP host key and TLS certificate, so a restored server
 * keeps its identity.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { CERT_FILE, KEY_FILE, SSH_HOST_KEY_FILE, getCertificateDir, setCertificateDir } from './tls';

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
  await db.restoreFrom(Buffer.from(bundle.database, 'base64'));

  const dir = getCertificateDir();
  const restoredFiles: string[] = [];
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
