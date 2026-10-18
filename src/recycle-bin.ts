/**
 * Recycle bin: deleted files (SFTP, FTP, portal) are moved to a trash folder
 * outside every user's root instead of being destroyed, can be restored by
 * the owner or an admin, and are purged after a retention period.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { getCertificateDir } from './tls';
import logger from './logger';

export interface TrashItem {
  id: number;
  username: string;
  virtualPath: string;
  originalPath: string;
  trashPath: string;
  size: number;
  deletedAt: string;
}

export interface RecycleSettings {
  enabled: boolean;
  retentionDays: number;
}

export function recycleSettings(db: DatabaseManager): RecycleSettings {
  const days = Number(db.getSetting('recycleBinRetentionDays'));
  return {
    enabled: db.getSetting('recycleBinEnabled') !== 'false',
    retentionDays: Number.isInteger(days) && days > 0 ? days : 30,
  };
}

export function saveRecycleSettings(db: DatabaseManager, input: Partial<RecycleSettings>): void {
  if (input.retentionDays !== undefined) {
    const n = Number(input.retentionDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Retention must be between 1 and 3650 days');
    db.setSetting('recycleBinRetentionDays', String(n));
  }
  if (input.enabled !== undefined) db.setSetting('recycleBinEnabled', input.enabled ? 'true' : 'false');
}

export function trashDir(db: DatabaseManager): string {
  return db.getSetting('recycleBinDir') || path.join(getCertificateDir(), 'recycle-bin');
}

/** rename, falling back to copy + delete across file systems */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err: any) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Delete a file the way the recycle-bin settings say: move it to the trash, or
 * remove it permanently when the bin is off (or the move fails).
 */
export function deleteFile(db: DatabaseManager, username: string, virtualPath: string, localPath: string): 'trashed' | 'deleted' {
  let settings: RecycleSettings;
  try {
    settings = recycleSettings(db);
  } catch {
    settings = { enabled: false, retentionDays: 30 };
  }
  if (settings.enabled) {
    try {
      const size = fs.statSync(localPath).size;
      const folder = path.join(trashDir(db), crypto.randomBytes(8).toString('hex'));
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, path.basename(localPath));
      moveFile(localPath, target);
      db.addTrashItem({ username, virtualPath, originalPath: path.resolve(localPath), trashPath: target, size });
      return 'trashed';
    } catch (err: any) {
      if (err?.code === 'ENOENT' && !fs.existsSync(localPath)) throw err;
      logger.warn(`Recycle bin unavailable (${err?.message}); deleting ${localPath} permanently`);
    }
  }
  fs.unlinkSync(localPath);
  return 'deleted';
}

/** Put an item back where it was ("name (restored).ext" if that name is taken). */
export function restoreItem(db: DatabaseManager, item: TrashItem): string {
  if (!fs.existsSync(item.trashPath)) {
    db.deleteTrashItem(item.id);
    throw new Error('The file is no longer in the recycle bin');
  }
  fs.mkdirSync(path.dirname(item.originalPath), { recursive: true });
  let target = item.originalPath;
  if (fs.existsSync(target)) {
    const ext = path.extname(target);
    const stem = target.slice(0, target.length - ext.length);
    target = `${stem} (restored)${ext}`;
    for (let i = 2; fs.existsSync(target); i++) target = `${stem} (restored ${i})${ext}`;
  }
  moveFile(item.trashPath, target);
  fs.rmSync(path.dirname(item.trashPath), { recursive: true, force: true });
  db.deleteTrashItem(item.id);
  return target;
}

export function purgeItem(db: DatabaseManager, item: TrashItem): void {
  fs.rmSync(path.dirname(item.trashPath), { recursive: true, force: true });
  db.deleteTrashItem(item.id);
}

/** Remove items older than the retention period; returns how many were purged. */
export function purgeExpired(db: DatabaseManager, now = Date.now()): number {
  const { retentionDays } = recycleSettings(db);
  const cutoff = now - retentionDays * 86_400_000;
  let count = 0;
  for (const item of db.listTrashItems()) {
    if (Date.parse(item.deletedAt) < cutoff) {
      purgeItem(db, item);
      count++;
    }
  }
  return count;
}
