/**
 * Scheduled configuration backups: every N hours, write a backup bundle
 * (encrypted when a passphrase is set) to a folder and keep the newest few.
 *
 * Settings (own endpoint; the passphrase is stored encrypted and never sent
 * back): backupScheduleEnabled, backupIntervalHours, backupKeep,
 * backupDirectory, backupPassphrase, and the last run's time and result.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { exportBackup } from './backup';
import logger from './logger';

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  /** '' = the "backups" folder next to config.db */
  directory: string;
  hasPassphrase: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface BackupScheduleInput {
  enabled?: boolean;
  intervalHours?: number;
  keep?: number;
  directory?: string;
  /** a new passphrase; '' or undefined keeps the current one, null removes it */
  passphrase?: string | null;
}

export const BACKUP_FILE_PATTERN = /^slightsftp-backup-\d{8}T\d{6}Z\.json$/;

export function defaultBackupDirectory(db: DatabaseManager): string {
  const file = db.filePath === ':memory:' ? path.join(process.cwd(), 'config.db') : path.resolve(db.filePath);
  return path.join(path.dirname(file), 'backups');
}

export function readBackupSchedule(db: DatabaseManager): BackupSchedule {
  const get = (k: string) => db.getSetting(k);
  const num = (k: string, fallback: number) => {
    const n = Number(get(k));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: get('backupScheduleEnabled') === 'true',
    intervalHours: num('backupIntervalHours', 24),
    keep: num('backupKeep', 7),
    directory: get('backupDirectory') || '',
    hasPassphrase: !!get('backupPassphrase'),
    lastRunAt: get('backupLastRunAt') || null,
    lastResult: get('backupLastResult') || null,
  };
}

/** Validate and store; throws an Error with a user-facing message. */
export function saveBackupSchedule(db: DatabaseManager, input: BackupScheduleInput): BackupSchedule {
  if (input.intervalHours !== undefined) {
    const h = Number(input.intervalHours);
    if (!Number.isInteger(h) || h < 1 || h > 720) throw new Error('Back up every 1 to 720 hours');
  }
  if (input.keep !== undefined) {
    const k = Number(input.keep);
    if (!Number.isInteger(k) || k < 1 || k > 365) throw new Error('Keep 1 to 365 backups');
  }
  if (input.directory !== undefined && input.directory !== '' && !path.isAbsolute(String(input.directory))) {
    throw new Error('The backup folder must be an absolute path (or empty for the default)');
  }
  if (typeof input.passphrase === 'string' && input.passphrase !== '' && input.passphrase.length < 8) {
    throw new Error('Choose a backup passphrase of at least 8 characters');
  }

  if (input.intervalHours !== undefined) db.setSetting('backupIntervalHours', String(Number(input.intervalHours)));
  if (input.keep !== undefined) db.setSetting('backupKeep', String(Number(input.keep)));
  if (input.directory !== undefined) db.setSetting('backupDirectory', String(input.directory).trim());
  if (input.passphrase === null) db.setSetting('backupPassphrase', '');
  else if (typeof input.passphrase === 'string' && input.passphrase !== '') db.setSetting('backupPassphrase', input.passphrase);
  if (input.enabled !== undefined) db.setSetting('backupScheduleEnabled', input.enabled ? 'true' : 'false');
  return readBackupSchedule(db);
}

/** Write one backup now and prune old ones; records the outcome in the settings. */
export function runBackup(db: DatabaseManager, appVersion: string, now = new Date()): { file: string; encrypted: boolean } {
  const schedule = readBackupSchedule(db);
  const dir = schedule.directory || defaultBackupDirectory(db);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const passphrase = db.getSetting('backupPassphrase') || undefined;
    const bundle = exportBackup(db, appVersion, passphrase);
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const file = path.join(dir, `slightsftp-backup-${stamp}.json`);
    const temp = `${file}.part`;
    fs.writeFileSync(temp, JSON.stringify(bundle), { mode: 0o600 });
    fs.renameSync(temp, file);

    // keep the newest N of our own files; anything else in the folder is left alone
    const ours = fs.readdirSync(dir).filter(f => BACKUP_FILE_PATTERN.test(f)).sort().reverse();
    for (const old of ours.slice(schedule.keep)) fs.rmSync(path.join(dir, old), { force: true });

    db.setSetting('backupLastRunAt', now.toISOString());
    db.setSetting('backupLastResult', `ok: ${path.basename(file)}${passphrase ? ' (encrypted)' : ''}`);
    db.logActivity({ listenerId: null, username: 'system', action: 'BACKUP_SCHEDULED', path: file, success: true });
    return { file, encrypted: !!passphrase };
  } catch (err: any) {
    db.setSetting('backupLastRunAt', now.toISOString());
    db.setSetting('backupLastResult', `failed: ${err?.message || err}`);
    db.logActivity({ listenerId: null, username: 'system', action: 'BACKUP_SCHEDULED_FAILED', path: dir, success: false });
    throw err;
  }
}

/** Is a scheduled backup due at `now`? */
export function backupDue(schedule: BackupSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;
  const last = Date.parse(schedule.lastRunAt);
  return !Number.isFinite(last) || now.getTime() - last >= schedule.intervalHours * 3_600_000;
}

/** Checks every few minutes whether a backup is due (and after a restart, catches up). */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DatabaseManager, private readonly appVersion: string, private readonly checkEveryMs = 5 * 60_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.checkEveryMs);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 60_000).unref?.(); // shortly after start-up
  }

  /** Run a backup if one is due; never throws. */
  tick(now = new Date()): void {
    try {
      if (!backupDue(readBackupSchedule(this.db), now)) return;
      const { file } = runBackup(this.db, this.appVersion, now);
      logger.info(`Scheduled backup written: ${file}`);
    } catch (err: any) {
      logger.error(`Scheduled backup failed: ${err?.message || err}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
