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
    expect(fs.readdirSync(dir)).toEqual(['config.db']);
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
