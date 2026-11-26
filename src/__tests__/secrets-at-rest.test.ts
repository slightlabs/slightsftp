/**
 * Secrets in config.db (cloud credentials, LDAP bind password, webhook and
 * TOTP secrets) are encrypted with a master key kept outside the database.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createBackup, restoreBackup } from '../backup';
import { DatabaseManager } from '../database';
import { MASTER_KEY_ENV, SECRET_KEY_FILE, SecretBox, SecretUnavailableError, isSealed, keyFromEnvironment } from '../secret-box';
import { SqliteDatabase } from '../sqlite';
import { setCertificateDir } from '../tls';
import { makeTempDir, removeDir } from './helpers/test-env';

const S3_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BIND_PASSWORD = 'Bind-Pass-Do-Not-Leak';
const HOOK_SECRET = 'hook-signing-secret-123';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function rawRows(dbFile: string, sql: string): Promise<any[][]> {
  const raw = new SqliteDatabase(dbFile, { readOnly: true });
  const result = raw.exec(sql);
  raw.close();
  return result.length ? result[0].values : [];
}

async function populate(db: DatabaseManager): Promise<void> {
  db.createStorageConnection({ name: 'bucket', type: 's3', config: { bucket: 'b', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: S3_SECRET } });
  db.setSetting('ldapBindPassword', BIND_PASSWORD);
  db.setSetting('logRetentionDays', '30');
  db.createWebhook({ name: 'hook', url: 'https://example.invalid', events: ['upload'], format: 'json', enabled: true, secret: HOOK_SECRET });
  db.createUser({ username: 'tina', password: 'Tina-Pass-1', passwordEnabled: true, guiEnabled: true });
  db.updateUser('tina', { totpSecret: TOTP_SECRET, totpEnabled: true } as any);
}

describe('SecretBox', () => {
  const box = SecretBox.fromKey(Buffer.alloc(32, 7));

  it('round-trips values and uses a fresh IV each time', () => {
    const a = box.seal('hello');
    const b = box.seal('hello');
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe('hello');
  });

  it('passes empty values and legacy plaintext through, and never double-seals', () => {
    expect(box.seal('')).toBe('');
    expect(box.seal(null)).toBeNull();
    expect(box.open('plain from v1.6')).toBe('plain from v1.6');
    const sealed = box.seal('x');
    expect(box.seal(sealed)).toBe(sealed);
  });

  it('refuses a value sealed with another key, or tampered with', () => {
    const other = SecretBox.fromKey(Buffer.alloc(32, 8));
    const sealed = box.seal('secret');
    expect(() => other.open(sealed)).toThrow(SecretUnavailableError);
    const raw = Buffer.from(sealed.slice('enc:v1:'.length), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => box.open('enc:v1:' + raw.toString('base64'))).toThrow(SecretUnavailableError);
  });

  it('accepts a hex key, a base64 key or a passphrase in the environment', () => {
    const key = Buffer.alloc(32, 9);
    expect(keyFromEnvironment(key.toString('hex'))).toEqual(key);
    expect(keyFromEnvironment(key.toString('base64'))).toEqual(key);
    expect(keyFromEnvironment('correct horse battery staple')).toHaveLength(32);
    expect(keyFromEnvironment('correct horse battery staple')).toEqual(keyFromEnvironment('correct horse battery staple'));
  });
});

describe('secrets in config.db', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir('secrets'); });
  afterEach(() => {
    delete process.env[MASTER_KEY_ENV];
    removeDir(dir);
  });

  it('are encrypted on disk and read back transparently', async () => {
    const file = path.join(dir, 'config.db');
    const db = new DatabaseManager(file);
    await db.init();
    await populate(db);

    expect(db.listStorageConnections()[0].config.secretAccessKey).toBe(S3_SECRET);
    expect(db.getSetting('ldapBindPassword')).toBe(BIND_PASSWORD);
    expect(db.getAllSettings().ldapBindPassword).toBe(BIND_PASSWORD);
    expect(db.listWebhooks()[0].secret).toBe(HOOK_SECRET);
    expect(db.getUser('tina')!.totpSecret).toBe(TOTP_SECRET);
    db.close();

    const bytes = fs.readFileSync(file).toString('latin1');
    for (const secret of [S3_SECRET, BIND_PASSWORD, HOOK_SECRET, TOTP_SECRET]) expect(bytes).not.toContain(secret);
    expect(fs.existsSync(path.join(dir, SECRET_KEY_FILE))).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, SECRET_KEY_FILE)).mode & 0o777).toBe(0o600);

    const reopened = new DatabaseManager(file);
    await reopened.init();
    expect(reopened.listStorageConnections()[0].config.secretAccessKey).toBe(S3_SECRET);
    expect(reopened.getUser('tina')!.totpSecret).toBe(TOTP_SECRET);
    reopened.close();
  });

  it('written in plaintext by older versions are encrypted when the database opens', async () => {
    const file = path.join(dir, 'config.db');
    // an "old" database: same schema, plaintext values, no key file
    const old = new DatabaseManager(file);
    await old.init();
    await populate(old);
    old.close();
    const raw = new SqliteDatabase(file);
    raw.run(`UPDATE storage_connections SET config = ?`, [JSON.stringify({ bucket: 'b', secretAccessKey: S3_SECRET })]);
    raw.run(`UPDATE settings SET value = ? WHERE key = 'ldapBindPassword'`, [BIND_PASSWORD]);
    raw.run(`UPDATE webhooks SET secret = ?`, [HOOK_SECRET]);
    raw.run(`UPDATE users SET totpSecret = ? WHERE username = 'tina'`, [TOTP_SECRET]);
    raw.close();

    const db = new DatabaseManager(file);
    await db.init();
    expect(db.listStorageConnections()[0].config.secretAccessKey).toBe(S3_SECRET);
    expect(db.getSetting('ldapBindPassword')).toBe(BIND_PASSWORD);
    db.close();

    const [[config]] = await rawRows(file, 'SELECT config FROM storage_connections');
    const [[bind]] = await rawRows(file, "SELECT value FROM settings WHERE key = 'ldapBindPassword'");
    const [[hook]] = await rawRows(file, 'SELECT secret FROM webhooks');
    const [[totp]] = await rawRows(file, "SELECT totpSecret FROM users WHERE username = 'tina'");
    for (const value of [config, bind, hook, totp]) expect(isSealed(value)).toBe(true);
  });

  it('fail closed without the right key, without breaking the rest of the configuration', async () => {
    const file = path.join(dir, 'config.db');
    const db = new DatabaseManager(file);
    await db.init();
    await populate(db);
    db.close();
    fs.rmSync(path.join(dir, SECRET_KEY_FILE)); // key lost: a new one is generated

    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const reopened = new DatabaseManager(file);
    await reopened.init();
    expect(reopened.getAllUsers().map(u => u.username)).toContain('tina');
    expect(reopened.listStorageConnections()[0].config).toEqual({});
    expect(reopened.getSetting('ldapBindPassword')).toBeUndefined();
    expect(reopened.listWebhooks()[0].secret).not.toBe(HOOK_SECRET);
    expect(reopened.getUser('tina')!.totpSecret).not.toBe(TOTP_SECRET); // codes never verify
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    reopened.close();
  });

  it('use SLIGHTSFTP_MASTER_KEY instead of a key file when it is set', async () => {
    process.env[MASTER_KEY_ENV] = Buffer.alloc(32, 3).toString('hex');
    const file = path.join(dir, 'config.db');
    const db = new DatabaseManager(file);
    await db.init();
    await populate(db);
    expect(db.secretBox.source).toBe('environment');
    db.close();
    expect(fs.existsSync(path.join(dir, SECRET_KEY_FILE))).toBe(false);

    const reopened = new DatabaseManager(file);
    await reopened.init();
    expect(reopened.getSetting('ldapBindPassword')).toBe(BIND_PASSWORD);
    reopened.close();
  });

  it('restore on another machine: the backup carries the master key', async () => {
    setCertificateDir(path.join(dir, 'keys'));
    const source = new DatabaseManager(path.join(dir, 'a', 'config.db'));
    fs.mkdirSync(path.join(dir, 'a'));
    await source.init();
    await populate(source);
    const bundle = createBackup(source, '0.0.0');
    source.close();
    expect(Object.keys(bundle.files)).toContain(SECRET_KEY_FILE);

    fs.mkdirSync(path.join(dir, 'b'));
    const target = new DatabaseManager(path.join(dir, 'b', 'config.db'));
    await target.init(); // has its own, different key
    await restoreBackup(target, JSON.parse(JSON.stringify(bundle)));
    expect(target.listStorageConnections()[0].config.secretAccessKey).toBe(S3_SECRET);
    expect(target.getUser('tina')!.totpSecret).toBe(TOTP_SECRET);
    target.close();

    // and the restored key is the one on disk now
    const reopened = new DatabaseManager(path.join(dir, 'b', 'config.db'));
    await reopened.init();
    expect(reopened.getSetting('ldapBindPassword')).toBe(BIND_PASSWORD);
    reopened.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
  });
});
