/**
 * Scheduled backups: due at the interval, written atomically and owner-only,
 * encrypted with the stored passphrase, pruned to the newest N, and managed
 * through the REST API without ever returning the passphrase.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { decryptBackup, isEncryptedBackup, restoreBackup } from '../backup';
import { BackupScheduler, backupDue, defaultBackupDirectory, readBackupSchedule, runBackup, saveBackupSchedule } from '../backup-schedule';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { SqliteDatabase } from '../sqlite';
import { setCertificateDir } from '../tls';
import { WebServer } from '../web-server';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';

jest.setTimeout(30000);

describe('scheduled backups', () => {
  let dir: string;
  let db: DatabaseManager;

  beforeEach(async () => {
    dir = makeTempDir('backup-schedule');
    setCertificateDir(path.join(dir, 'keys'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
  });
  afterEach(() => {
    db.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
    removeDir(dir);
  });

  test('defaults: off, daily, keep 7, the "backups" folder next to config.db', () => {
    expect(readBackupSchedule(db)).toEqual({ enabled: false, intervalHours: 24, keep: 7, directory: '', hasPassphrase: false, lastRunAt: null, lastResult: null });
    expect(defaultBackupDirectory(db)).toBe(path.join(dir, 'backups'));
  });

  test('settings are validated', () => {
    expect(() => saveBackupSchedule(db, { intervalHours: 0 })).toThrow('Back up every 1 to 720 hours');
    expect(() => saveBackupSchedule(db, { keep: 1000 })).toThrow('Keep 1 to 365 backups');
    expect(() => saveBackupSchedule(db, { directory: 'relative/path' })).toThrow(/absolute path/);
    expect(() => saveBackupSchedule(db, { passphrase: 'short' })).toThrow(/at least 8 characters/);
  });

  test('a backup is due when enabled and the interval has passed since the last run', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const base = readBackupSchedule(db);
    expect(backupDue(base, now)).toBe(false);
    expect(backupDue({ ...base, enabled: true }, now)).toBe(true);
    expect(backupDue({ ...base, enabled: true, intervalHours: 6, lastRunAt: '2026-11-27T07:00:00Z' }, now)).toBe(false);
    expect(backupDue({ ...base, enabled: true, intervalHours: 6, lastRunAt: '2026-11-27T05:59:00Z' }, now)).toBe(true);
  });

  test('runs write owner-only files, encrypt with the stored passphrase and keep the newest N', async () => {
    saveBackupSchedule(db, { enabled: true, keep: 2, passphrase: 'scheduled pass 1' });
    const stray = path.join(dir, 'backups', 'notes.txt');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, 'not ours');

    const files: string[] = [];
    for (let i = 0; i < 3; i++) files.push(runBackup(db, '0.0.0', new Date(Date.UTC(2026, 10, 27, i))).file);
    const left = fs.readdirSync(path.join(dir, 'backups')).sort();
    expect(left).toEqual(['notes.txt', 'slightsftp-backup-20261127T010000Z.json', 'slightsftp-backup-20261127T020000Z.json']);
    if (process.platform !== 'win32') expect(fs.statSync(files[2]).mode & 0o777).toBe(0o600);

    const bundle = JSON.parse(fs.readFileSync(files[2], 'utf8'));
    expect(isEncryptedBackup(bundle)).toBe(true);
    expect(decryptBackup(bundle, 'scheduled pass 1').format).toBe('slightsftp-backup');
    const schedule = readBackupSchedule(db);
    expect(schedule).toMatchObject({ hasPassphrase: true, lastRunAt: '2026-11-27T02:00:00.000Z', lastResult: 'ok: slightsftp-backup-20261127T020000Z.json (encrypted)' });

    // the passphrase is stored encrypted, like the other secrets
    const raw = new SqliteDatabase(path.join(dir, 'config.db'), { readOnly: true });
    expect(String(raw.exec("SELECT value FROM settings WHERE key = 'backupPassphrase'")[0].values[0][0])).toMatch(/^enc:v1:/);
    raw.close();

    // and a scheduled backup restores
    db.deleteUser('admin');
    await restoreBackup(db, bundle, 'scheduled pass 1');
    expect(db.getUser('admin')).toBeDefined();
  });

  test('a failing run is recorded and the scheduler keeps going', () => {
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    saveBackupSchedule(db, { enabled: true, directory: blocker });
    const scheduler = new BackupScheduler(db, '0.0.0', 60_000);
    expect(() => scheduler.tick(new Date())).not.toThrow();
    expect(readBackupSchedule(db).lastResult).toMatch(/^failed: /);
    scheduler.stop();
  });

  test('REST: read and change the schedule (passphrase never returned), and run now', async () => {
    const port = await getFreePort();
    const web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    try {
      const admin = request.agent(`http://127.0.0.1:${port}`);
      await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
      await admin.put('/api/backup/schedule').send({ keep: 0 }).expect(400);
      const saved = await admin.put('/api/backup/schedule').send({ enabled: true, intervalHours: 12, keep: 3, passphrase: 'rest passphrase' }).expect(200);
      expect(saved.body).toMatchObject({ enabled: true, intervalHours: 12, keep: 3, hasPassphrase: true });
      expect(JSON.stringify(saved.body)).not.toContain('rest passphrase');
      expect(JSON.stringify((await admin.get('/api/settings').expect(200)).body)).not.toContain('rest passphrase');

      const run = await admin.post('/api/backup/schedule/run').expect(200);
      expect(run.body).toMatchObject({ success: true, encrypted: true });
      expect(fs.existsSync(run.body.file)).toBe(true);
    } finally {
      await web.stop();
    }
  });
});
