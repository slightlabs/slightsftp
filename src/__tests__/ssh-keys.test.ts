/**
 * ssh-keys.test.ts — OpenSSH public key sign-in for SFTP with real keys,
 * including a forged-signature attack.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BaseAgent, Client, utils as sshUtils } from 'ssh2';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { cleanAuthorizedKeys, parseAuthorizedKey, parseAuthorizedKeys } from '../authorized-keys';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

const ed = sshUtils.generateKeyPairSync('ed25519', { comment: 'alice@laptop' });
const rsa = sshUtils.generateKeyPairSync('rsa', { bits: 2048, comment: 'backup' });
const stranger = sshUtils.generateKeyPairSync('ed25519');

/** An SSH agent that offers someone else's PUBLIC key and signs with garbage. */
class ForgingAgent extends BaseAgent {
  constructor(private publicLine: string) { super(); }
  getIdentities(cb: (err: Error | null, keys?: any[]) => void) { cb(null, [sshUtils.parseKey(this.publicLine)]); }
  sign(_pub: any, _data: Buffer, ...rest: any[]) {
    const cb = rest[rest.length - 1];
    cb(null, Buffer.alloc(64, 1));
  }
}

function connect(opts: Record<string, any>, port: number): Promise<'ok'> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => { c.end(); resolve('ok'); });
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username: 'alice', readyTimeout: 5000, ...opts });
  });
}

describe('authorized keys parsing', () => {
  test('parses OpenSSH lines with comments, legacy base64 blobs, and skips comments', () => {
    const key = parseAuthorizedKey(ed.public)!;
    expect(key).toMatchObject({ type: 'ssh-ed25519', comment: 'alice@laptop' });
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const blob = ed.public.split(' ')[1];
    expect(parseAuthorizedKey(blob)!.fingerprint).toBe(key.fingerprint);
    expect(parseAuthorizedKey('# comment')).toBeNull();
    expect(parseAuthorizedKey('   ')).toBeNull();
    expect(parseAuthorizedKeys(`${ed.public}\n\n# old\n${rsa.public}\nnot a key`).map(k => k.type)).toEqual(['ssh-ed25519', 'ssh-rsa']);
  });

  test('cleaning normalises, de-duplicates and reports bad lines', () => {
    const cleaned = cleanAuthorizedKeys(`  ${ed.public}  \n${rsa.public}\n${ed.public}\n`);
    expect(cleaned.split('\n')).toHaveLength(2);
    expect(cleaned).toContain('alice@laptop');
    expect(() => cleanAuthorizedKeys(`${ed.public}\nssh-rsa NOTBASE64!!`)).toThrow(/^Line 2: /);
    expect(() => cleanAuthorizedKeys(ed.private)).toThrow(/Line 1/);
    expect(cleanAuthorizedKeys('')).toBe('');
  });
});

describe('SFTP public key sign-in', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let port: number;

  beforeAll(async () => {
    dir = makeTempDir('sshkeys');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const id = db.createUser({ username: 'alice', password: 'Alice-Pass-1', passwordEnabled: false, guiEnabled: false, publicKey: cleanAuthorizedKeys(`${ed.public}\n${rsa.public}`) });
    db.addVirtualPath({ userId: id, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    port = await getFreePort();
    db.subscribeUserToListener(id, db.createListener({ name: 'Keys', protocol: 'SFTP', bindingIp: '127.0.0.1', port, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  test.each([['ed25519', () => ed.private], ['rsa', () => rsa.private]])('accepts the user\'s %s key', async (_name, key) => {
    await expect(connect({ privateKey: key() }, port)).resolves.toBe('ok');
    const login = db.getRecentActivities(undefined, 5).find(a => a.action.startsWith('LOGIN (publickey'));
    expect(login!.action).toMatch(/SHA256:/);
  });

  test('refuses a key that is not on the list', async () => {
    await expect(connect({ privateKey: stranger.private }, port)).rejects.toThrow(/authentication methods failed/);
  });

  test('refuses a forged signature for a listed public key', async () => {
    await expect(connect({ agent: new ForgingAgent(ed.public) }, port)).rejects.toThrow(/authentication methods failed/);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  test('password sign-in stays off when password auth is disabled for the user', async () => {
    await expect(connect({ password: 'Alice-Pass-1' }, port)).rejects.toThrow(/authentication methods failed/);
  });

  test('removing a key revokes it', async () => {
    db.updateUser('alice', { publicKey: cleanAuthorizedKeys(rsa.public) });
    await expect(connect({ privateKey: ed.private }, port)).rejects.toThrow();
    await expect(connect({ privateKey: rsa.private }, port)).resolves.toBe('ok');
  });
});
