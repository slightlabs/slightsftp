/**
 * Versioned schema migrations (PRAGMA user_version): older databases are
 * upgraded step by step with a copy kept first, and databases or backups
 * from a newer version are refused instead of being half-understood.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager, DatabaseTooNewError, SCHEMA_VERSION } from '../database';
import { SqliteDatabase } from '../sqlite';
import { makeTempDir, removeDir } from './helpers/test-env';

const version = (file: string) => {
  const raw = new SqliteDatabase(file, { readOnly: true });
  const v = Number(raw.exec('PRAGMA user_version')[0].values[0][0]);
  raw.close();
  return v;
};

describe('schema migrations', () => {
  let dir: string;
  let file: string;
  let logs: jest.SpyInstance;

  beforeEach(() => {
    dir = makeTempDir('schema');
    file = path.join(dir, 'config.db');
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    removeDir(dir);
  });

  const backups = () => fs.readdirSync(dir).filter(f => /^config\.db\.v\d+-\d{8}T\d{6}\.bak$/.test(f));

  test('a fresh database is created at the current version, with no upgrade copy', async () => {
    const db = new DatabaseManager(file);
    await db.init();
    db.close();
    expect(version(file)).toBe(SCHEMA_VERSION);
    expect(backups()).toEqual([]);
  });

  test('a database from v1.7 (no version, fewer columns) is upgraded, after a copy is saved', async () => {
    // what v1.7 and earlier left: tables without the later columns, user_version 0
    const raw = new SqliteDatabase(file, { foreignKeys: false });
    raw.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT,
      passwordEnabled INTEGER NOT NULL DEFAULT 1, publicKey TEXT, guiEnabled INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    raw.run(`INSERT INTO users (username, password, guiEnabled) VALUES ('old-admin', NULL, 1)`);
    raw.close();
    expect(version(file)).toBe(0);

    const db = new DatabaseManager(file);
    await db.init();
    const user = db.getUser('old-admin')!;
    expect(user).toMatchObject({ guiEnabled: true, guiRole: 'admin', authSource: 'local', mustChangePassword: false });
    db.close();
    expect(version(file)).toBe(SCHEMA_VERSION);

    const [copy] = backups();
    expect(copy).toMatch(/^config\.db\.v0-/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, copy)).mode & 0o777).toBe(0o600);
    const saved = new SqliteDatabase(path.join(dir, copy), { readOnly: true });
    expect(Number(saved.exec('PRAGMA user_version')[0].values[0][0])).toBe(0);
    expect(saved.exec("SELECT username FROM users")[0].values).toEqual([['old-admin']]);
    saved.close();

    // nothing more to do on the next start
    const again = new DatabaseManager(file);
    await again.init();
    again.close();
    expect(backups()).toHaveLength(1);
  });

  test('only the newest upgrade copies are kept', async () => {
    for (let i = 0; i < 5; i++) {
      const name = path.join(dir, `config.db.v0-2026010${i}T000000.bak`);
      fs.writeFileSync(name, 'old');
      fs.utimesSync(name, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }
    const db = new DatabaseManager(file);
    await db.init();
    db.close();
    const raw = new SqliteDatabase(file);
    raw.run('PRAGMA user_version = 1');
    raw.close();
    const upgraded = new DatabaseManager(file);
    await upgraded.init();
    upgraded.close();
    expect(backups()).toHaveLength(3);
    expect(backups().some(f => f.startsWith('config.db.v1-'))).toBe(true);
  });

  test('a database written by a newer version is refused and left untouched', async () => {
    const db = new DatabaseManager(file);
    await db.init();
    db.close();
    const raw = new SqliteDatabase(file);
    raw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    const before = fs.readFileSync(file);

    const newer = new DatabaseManager(file);
    await expect(newer.init()).rejects.toThrow(DatabaseTooNewError);
    await expect(new DatabaseManager(file).init()).rejects.toThrow(/written by a newer version of SLightSFTP/);
    expect(version(file)).toBe(SCHEMA_VERSION + 1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
  });

  test('a backup from a newer version is refused and the configuration kept', async () => {
    const db = new DatabaseManager(file);
    await db.init();
    db.createUser({ username: 'keep', password: 'Keep-Pass-1', passwordEnabled: true, guiEnabled: false });

    const other = path.join(dir, 'newer.db');
    const source = new DatabaseManager(other);
    await source.init();
    source.close();
    const raw = new SqliteDatabase(other);
    raw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();

    await expect(db.restoreFrom(fs.readFileSync(other))).rejects.toThrow('This backup was made by a newer version of SLightSFTP');
    expect(db.getUser('keep')).toBeDefined();
    db.close();
  });
});
