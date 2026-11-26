import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseManager } from '../database';
import { SqliteDatabase } from '../sqlite';
import { DEFAULT_ADMIN_SEEDED, seedDefaultAdmin } from '../default-admin';
import { publicSettings, validateSetting } from '../settings-policy';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

describe('default admin seeding', () => {
  let db: DatabaseManager;
  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();
  });
  afterEach(() => db.close());

  test('creates admin once on a fresh install', () => {
    expect(seedDefaultAdmin(db)).not.toBeNull();
    const admin = db.getUser('admin')!;
    expect(admin.guiEnabled).toBe(true);
    expect(admin.mustChangePassword).toBe(true);
    expect(db.getSetting(DEFAULT_ADMIN_SEEDED)).toBe('true');
  });

  test('a deleted admin is not recreated with the default password', () => {
    seedDefaultAdmin(db);
    db.createUser({ username: 'boss', password: 'Str0ng-pass', passwordEnabled: true, publicKey: '', guiEnabled: true });
    db.deleteUser('admin');
    expect(seedDefaultAdmin(db)).toBeNull();
    expect(db.getUser('admin')).toBeUndefined();
  });

  test('existing installs (users, no marker) are marked and never seeded', () => {
    db.createUser({ username: 'boss', password: 'Str0ng-pass', passwordEnabled: true, publicKey: '', guiEnabled: true });
    expect(seedDefaultAdmin(db)).toBeNull();
    expect(db.getUser('admin')).toBeUndefined();
    expect(db.getSetting(DEFAULT_ADMIN_SEEDED)).toBe('true');
    db.deleteUser('boss');
    expect(seedDefaultAdmin(db)).toBeNull();
  });
});

describe('database file', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-db-'));
    dbPath = path.join(dir, 'config.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  (process.platform === 'win32' ? test.skip : test)('is readable by its owner only, including databases from older versions', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    db.close();

    fs.chmodSync(dbPath, 0o644);
    const again = new DatabaseManager(dbPath);
    await again.init();
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    again.close();
  });

  test('changes are on disk as soon as they are made, without a save or a clean close', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    db.createUser({ username: 'alice', password: 'alice-pass', passwordEnabled: true, publicKey: '', guiEnabled: false });
    for (let i = 0; i < 50; i++) {
      db.logActivity({ listenerId: null, username: 'u', action: 'LOGIN_FAILED', path: '/', success: false });
    }
    // a second connection (as after a crash, before any close) sees everything
    const other = new DatabaseManager(dbPath);
    await other.init();
    expect(other.getUser('alice')).toBeDefined();
    expect(other.getActivityCount()).toBe(50);
    other.close();
    db.close();
    // a clean close folds the journal back into config.db
    expect(fs.readdirSync(dir).sort()).toEqual(['config.db', 'secret.key']);
  });

  (process.platform === 'win32' ? test.skip : test)('the write-ahead journal is owner-only too', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    db.createUser({ username: 'bob', password: 'bob-pass-1', passwordEnabled: true, publicKey: '', guiEnabled: false });
    for (const file of fs.readdirSync(dir).filter(f => f.startsWith('config.db'))) {
      expect([file, fs.statSync(path.join(dir, file)).mode & 0o777]).toEqual([file, 0o600]);
    }
    db.close();
  });

  test('the audit log keeps entries of deleted listeners (and of listeners it never knew)', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    const id = db.createListener({ name: 'gone soon', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2299, enabled: false });
    db.logActivity({ listenerId: id, username: 'u', action: 'LOGIN', path: '/', success: true });
    db.logActivity({ listenerId: 9999, username: 'u', action: 'LOGIN', path: '/', success: true });
    db.deleteListener(id);
    expect(db.getActivityCount()).toBe(2);
    db.close();
  });

  test('databases from older versions: the audit log loses its cascading foreign key and orphans are removed', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    const listenerId = db.createListener({ name: 'L', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2298, enabled: false });
    db.logActivity({ listenerId, username: 'u', action: 'LOGIN', path: '/', success: true, bytes: 5, checksum: 'abc' });
    db.close();

    // what v1.7 and earlier left on disk (sql.js never enforced foreign keys)
    const raw = new SqliteDatabase(dbPath, { foreignKeys: false });
    raw.run(`ALTER TABLE server_activities RENAME TO old_activities`);
    raw.run(`CREATE TABLE server_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listenerId INTEGER, username TEXT NOT NULL, action TEXT NOT NULL,
      path TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, success INTEGER NOT NULL DEFAULT 1,
      bytes INTEGER, checksum TEXT,
      FOREIGN KEY (listenerId) REFERENCES listeners(id) ON DELETE CASCADE)`);
    raw.run('INSERT INTO server_activities SELECT * FROM old_activities');
    raw.run('DROP TABLE old_activities');
    raw.run(`INSERT INTO user_listeners (userId, listenerId) VALUES (424242, ${listenerId})`);
    raw.close();

    const upgraded = new DatabaseManager(dbPath);
    await upgraded.init();
    upgraded.deleteListener(listenerId);
    const [entry] = upgraded.getRecentActivities(undefined, 10);
    expect(entry).toMatchObject({ action: 'LOGIN', bytes: 5, checksum: 'abc' });
    upgraded.close();

    const check = new SqliteDatabase(dbPath, { readOnly: true });
    expect(check.exec('PRAGMA foreign_key_list(server_activities)')).toEqual([]);
    expect(check.exec('SELECT * FROM user_listeners WHERE userId = 424242')).toEqual([]);
    check.close();
  });

  test('an in-memory database can be backed up and restored', async () => {
    const db = new DatabaseManager(':memory:');
    await db.init();
    db.createUser({ username: 'carol', password: 'carol-pass', passwordEnabled: true, publicKey: '', guiEnabled: false });
    const bytes = db.exportBytes();
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
    db.deleteUser('carol');
    await db.restoreFrom(bytes);
    expect(db.getUser('carol')).toBeDefined();
    await expect(db.restoreFrom(Buffer.from('not a database'))).rejects.toThrow('This is not a SLightSFTP configuration backup');
    expect(db.getUser('carol')).toBeDefined();
    db.close();
  });
});

describe('settings policy', () => {
  test('hides secrets', () => {
    expect(publicSettings({ a: '1', ldapBindPassword: 'x' })).toEqual({ a: '1' });
  });

  test('only plain GUI settings are writable', () => {
    expect(validateSetting('webHttps', 'true')).toBeNull();
    expect(validateSetting('webHttps', 'yes')).not.toBeNull();
    expect(validateSetting('bruteForceEnabled', 'false')).not.toBeNull();
    expect(validateSetting('defaultAdminSeeded', 'false')).not.toBeNull();
  });
});

describe('deleting a user', () => {
  test('removes their tokens, share links and access, also in a saved database (no cascade)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-del-'));
    try {
      const db = new DatabaseManager(path.join(dir, 'config.db'));
      await db.init();
      // reopen: like every real database, it has been exported once (foreign keys off)
      db.close();
      await db.init();
      const { createApiToken, authenticateToken } = require('../api-tokens');
      const id = db.createUser({ username: 'bob', password: 'bob-pass-1', passwordEnabled: true, publicKey: '', guiEnabled: true });
      const listenerId = db.createListener({ name: 'L', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2299, enabled: false });
      db.subscribeUserToListener(id, listenerId);
      db.addVirtualPath({ userId: id, virtualPath: '/', localPath: dir, canRead: true, canWrite: true, canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true });
      const { token } = createApiToken(db, 'bob', 'script');
      expect(authenticateToken(db, token)).toBe('bob');

      db.deleteUser('bob');
      const again = db.createUser({ username: 'bob', password: 'other-pass-1', passwordEnabled: true, publicKey: '', guiEnabled: true });
      expect(authenticateToken(db, token)).toBeNull();
      expect(db.listApiTokens('bob')).toEqual([]);
      expect(db.getVirtualPaths(id)).toEqual([]);
      expect(db.getUserListeners(id)).toEqual([]);
      expect(db.getVirtualPaths(again)).toEqual([]);

      db.deleteListener(listenerId);
      expect(db.getUserListeners(again)).toEqual([]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
