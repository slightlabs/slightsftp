import * as crypto from 'crypto';
import * as path from 'path';
import { hashPassword, verifyPasswordHash, isLegacyHash } from '../password';
import { DatabaseManager } from '../database';
import { makeTempDir, removeDir } from './helpers/test-env';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('password hashing (scrypt)', () => {
  test('hashes are salted: same password, different hashes, both verify', () => {
    const a = hashPassword('correct horse');
    const b = hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(verifyPasswordHash(a, 'correct horse')).toEqual({ valid: true, needsRehash: false });
    expect(verifyPasswordHash(b, 'correct horse').valid).toBe(true);
  });

  test('wrong, empty and non-string passwords are rejected', () => {
    const h = hashPassword('secret');
    expect(verifyPasswordHash(h, 'Secret').valid).toBe(false);
    expect(verifyPasswordHash(h, '').valid).toBe(false);
    expect(verifyPasswordHash(h, undefined as any).valid).toBe(false);
    expect(verifyPasswordHash(null, 'secret').valid).toBe(false);
  });

  test('malformed stored hashes never verify', () => {
    for (const bad of ['scrypt$1$2', 'bcrypt$x$y$z$a$b', 'scrypt$abc$8$1$AA==$AA==', 'plaintext']) {
      expect(verifyPasswordHash(bad, 'plaintext').valid).toBe(false);
    }
  });

  test('legacy SHA-256 hashes verify and are flagged for rehash', () => {
    expect(isLegacyHash(sha256('old'))).toBe(true);
    expect(verifyPasswordHash(sha256('old'), 'old')).toEqual({ valid: true, needsRehash: true });
    expect(verifyPasswordHash(sha256('old'), 'new')).toEqual({ valid: false, needsRehash: false });
  });

  test('hashes with outdated scrypt parameters are flagged for rehash', () => {
    const salt = crypto.randomBytes(16);
    const weak = ['scrypt', 1024, 8, 1, salt.toString('base64'), crypto.scryptSync('pw', salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64')].join('$');
    expect(verifyPasswordHash(weak, 'pw')).toEqual({ valid: true, needsRehash: true });
  });
});

describe('DatabaseManager password storage', () => {
  let dir: string;
  let db: DatabaseManager;

  beforeAll(async () => {
    dir = makeTempDir('pw');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
  });

  afterAll(() => { db.close(); removeDir(dir); });

  test('createUser / updateUser store scrypt hashes', () => {
    db.createUser({ username: 'u1', password: 'p1', passwordEnabled: true, guiEnabled: false });
    expect(db.getUser('u1')!.password).toMatch(/^scrypt\$/);
    expect(db.verifyPassword('u1', 'p1')).toBe(true);

    db.updateUser('u1', { password: 'p2' });
    expect(db.verifyPassword('u1', 'p1')).toBe(false);
    expect(db.verifyPassword('u1', 'p2')).toBe(true);
  });

  test('a legacy SHA-256 user is upgraded to scrypt on the first successful login', () => {
    db.createUser({ username: 'legacy', passwordEnabled: true, guiEnabled: true });
    (db as any).db.run('UPDATE users SET password = ? WHERE username = ?', [sha256('old-pass'), 'legacy']);

    expect(db.checkPassword('legacy', 'wrong')).toBe(false);
    expect(db.getUser('legacy')!.password).toBe(sha256('old-pass')); // untouched on failure

    expect(db.checkPassword('legacy', 'old-pass')).toBe(true);
    const upgraded = db.getUser('legacy')!.password!;
    expect(upgraded).toMatch(/^scrypt\$/);
    expect(db.checkPassword('legacy', 'old-pass')).toBe(true);
  });

  test('the upgrade survives a restart', async () => {
    db.close();
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    expect(db.getUser('legacy')!.password).toMatch(/^scrypt\$/);
    expect(db.checkPassword('legacy', 'old-pass')).toBe(true);
  });

  test('protocol logins require password auth to be enabled; GUI checks do not', () => {
    db.createUser({ username: 'keyonly', password: 'pw', passwordEnabled: false, guiEnabled: true });
    expect(db.verifyPassword('keyonly', 'pw')).toBe(false);
    expect(db.checkPassword('keyonly', 'pw')).toBe(true);
  });

  test('unknown users and users without a password never verify', () => {
    db.createUser({ username: 'nopw', passwordEnabled: true, guiEnabled: false });
    expect(db.checkPassword('nopw', '')).toBe(false);
    expect(db.checkPassword('ghost', 'x')).toBe(false);
  });
});
