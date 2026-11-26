import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseManager } from '../database';
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

  test('saves leave no temp files behind and survive a reopen', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    db.createUser({ username: 'alice', password: 'alice-pass', passwordEnabled: true, publicKey: '', guiEnabled: false });
    expect(fs.readdirSync(dir).sort()).toEqual(['config.db', 'secret.key']);
    db.close();
    const reopened = new DatabaseManager(dbPath);
    await reopened.init();
    expect(reopened.getUser('alice')).toBeDefined();
    reopened.close();
  });

  test('activity log entries are coalesced into one write and flushed on close', async () => {
    const db = new DatabaseManager(dbPath);
    await db.init();
    const writes = jest.spyOn(require('fs'), 'renameSync');
    for (let i = 0; i < 50; i++) {
      db.logActivity({ listenerId: null, username: 'u', action: 'LOGIN_FAILED', path: '/', success: false });
    }
    expect(writes).not.toHaveBeenCalled();
    db.close();
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();

    const reopened = new DatabaseManager(dbPath);
    await reopened.init();
    expect(reopened.getActivityCount()).toBe(50);
    reopened.close();
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
