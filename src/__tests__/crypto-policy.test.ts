/**
 * Protocol hardening: the SSH listener offers no SHA-1 by default (with a
 * "compatible" profile for old clients), and HTTPS / FTPS honour the minimum
 * TLS version setting.
 */
import * as path from 'path';
import * as tls from 'tls';
import { Client } from 'ssh2';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { getServerCertificate, setCertificateDir } from '../tls';
import { validateSetting } from '../settings-policy';
import { MODERN_SSH_ALGORITHMS, modernSshAlgorithms } from '../crypto-policy';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';

jest.setTimeout(30000);

/** Connect with only the given algorithms; resolves 'ok' or the error message. */
function tryConnect(port: number, algorithms: Record<string, string[]>): Promise<string> {
  return new Promise(resolve => {
    const c = new Client();
    c.on('ready', () => { c.end(); resolve('ok'); });
    c.on('error', err => resolve(err.message));
    // the server may hang up right after the key exchange (resolve() only counts once)
    c.on('close', () => resolve('connection closed'));
    c.connect({ host: '127.0.0.1', port, username: 'kim', password: 'Kim-Pass-123', readyTimeout: 5000, algorithms: algorithms as any });
  });
}

describe('SSH algorithm profiles', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let port: number;
  let id: number;

  beforeAll(async () => {
    dir = makeTempDir('crypto');
    setCertificateDir(path.join(dir, 'keys'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const kim = db.createUser({ username: 'kim', password: 'Kim-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: kim, virtualPath: '/', localPath: dir, canRead: true, canList: true, canWrite: false });
    port = await getFreePort();
    id = db.createListener({ name: 'sftp', protocol: 'SFTP', bindingIp: '127.0.0.1', port, enabled: true });
    db.subscribeUserToListener(kim, id);
    manager = new ServerManager(db);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
    removeDir(dir);
  });

  afterEach(async () => {
    if (manager.isListenerRunning(id)) await manager.stopListener(id);
  });

  test('modern (default): current clients connect; SHA-1 host key signatures, SHA-1 MACs and weak key exchange are refused', async () => {
    await manager.startListener(id);
    expect(await tryConnect(port, {})).toBe('ok');
    expect(await tryConnect(port, { serverHostKey: ['ssh-rsa'] })).not.toBe('ok');
    expect(await tryConnect(port, { cipher: ['aes128-ctr'], hmac: ['hmac-sha1'] })).not.toBe('ok'); // AEAD ciphers carry no MAC
    expect(await tryConnect(port, { kex: ['diffie-hellman-group14-sha1'] })).not.toBe('ok');
    expect(await tryConnect(port, { kex: ['ecdh-sha2-nistp256'] })).not.toBe('ok');
    for (const cipher of MODERN_SSH_ALGORITHMS.cipher) {
      expect([cipher, await tryConnect(port, { cipher: [cipher] })]).toEqual([cipher, 'ok']);
    }
    await manager.stopListener(id);
  });

  test('compatible: old clients that only speak SHA-1 get in', async () => {
    db.setSetting('sshAlgorithms', 'compatible');
    await manager.startListener(id);
    expect(await tryConnect(port, { serverHostKey: ['ssh-rsa'] })).toBe('ok');
    expect(await tryConnect(port, { cipher: ['aes128-ctr'], hmac: ['hmac-sha1'] })).toBe('ok');
    await manager.stopListener(id);
    db.setSetting('sshAlgorithms', 'modern');
  });
});

describe('minimum TLS version', () => {
  let dir: string;
  let db: DatabaseManager;

  beforeAll(async () => {
    dir = makeTempDir('tlsmin');
    setCertificateDir(path.join(dir, 'keys'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
  });
  afterAll(() => {
    db.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
    removeDir(dir);
  });

  const handshake = (port: number, maxVersion: tls.SecureVersion) => new Promise<string>(resolve => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, maxVersion, minVersion: 'TLSv1' }, () => {
      const v = socket.getProtocol() || '';
      socket.end();
      resolve(v);
    });
    socket.on('error', err => resolve(`error: ${err.message}`));
  });

  test.each([
    ['TLSv1.2', 'TLSv1.1', false],
    ['TLSv1.2', 'TLSv1.2', true],
    ['TLSv1.3', 'TLSv1.2', false],
    ['TLSv1.3', 'TLSv1.3', true],
  ] as const)('HTTPS with minimum %s: a client limited to %s connects = %s', async (minimum, clientMax, ok) => {
    db.setSetting('tlsMinVersion', minimum);
    const cert = await getServerCertificate({});
    const port = await getFreePort();
    const web = new WebServer(db, new ServerManager(db), port, { tls: { key: cert.key, cert: cert.cert } });
    await web.start();
    try {
      const result = await handshake(port, clientMax as tls.SecureVersion);
      if (ok) expect(result).toBe(clientMax);
      else expect(result).toMatch(/^error: /);
    } finally {
      await web.stop();
    }
  });
});

describe('modern list', () => {
  test('is limited to what the running ssh2 supports (Electron has no ChaCha20-Poly1305)', () => {
    const electronLike = { kex: MODERN_SSH_ALGORITHMS.kex, serverHostKey: MODERN_SSH_ALGORITHMS.serverHostKey, cipher: ['aes256-gcm@openssh.com', 'aes128-ctr'], hmac: MODERN_SSH_ALGORITHMS.hmac, compress: ['none'] };
    const list = modernSshAlgorithms(electronLike);
    expect(list.cipher).toEqual(['aes256-gcm@openssh.com', 'aes128-ctr']);
    expect(list.compress).toEqual(['none']);
    expect(list.kex).toEqual(MODERN_SSH_ALGORITHMS.kex);
    expect(modernSshAlgorithms(null)).toBe(MODERN_SSH_ALGORITHMS);
  });
});

describe('settings', () => {
  test('only known values are accepted', () => {
    expect(validateSetting('sshAlgorithms', 'modern')).toBeNull();
    expect(validateSetting('sshAlgorithms', 'compatible')).toBeNull();
    expect(validateSetting('sshAlgorithms', 'legacy')).toMatch(/modern/);
    expect(validateSetting('tlsMinVersion', 'TLSv1.3')).toBeNull();
    expect(validateSetting('tlsMinVersion', 'TLSv1.0')).toMatch(/TLSv1\.2/);
  });
});
