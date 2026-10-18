/**
 * ftps.test.ts — FTP listeners with explicit TLS (AUTH TLS), using a real FTP client.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as ftp from 'basic-ftp';
import { Readable, Writable } from 'stream';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { getServerCertificate, setCertificateDir } from '../tls';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('FTPS (explicit TLS) listeners', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  const ports: Record<string, number> = {};
  const ids: Record<string, number> = {};
  let fingerprint: string;

  const connect = async (mode: string, secure: boolean) => {
    const client = new ftp.Client(5000);
    await client.access({
      host: '127.0.0.1', port: ports[mode], user: 'tina', password: 'Ftps-Pass-1',
      secure, secureOptions: { rejectUnauthorized: false },
    });
    const peer = () => (client.ftp.socket as tls.TLSSocket).getPeerCertificate();
    return { client, peer };
  };

  beforeAll(async () => {
    dir = makeTempDir('ftps');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'hello.txt'), 'over tls');
    setCertificateDir(dir);
    fingerprint = (await getServerCertificate()).fingerprint256;

    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const userId = db.createUser({ username: 'tina', password: 'Ftps-Pass-1', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId, virtualPath: '/', localPath: root, ...FULL_VPATH_PERMS });

    for (const mode of ['none', 'optional', 'required'] as const) {
      ports[mode] = await getFreePort();
      ids[mode] = db.createListener({ name: `FTP ${mode}`, protocol: 'FTP', bindingIp: '127.0.0.1', port: ports[mode], enabled: true, tlsMode: mode });
      db.subscribeUserToListener(userId, ids[mode]);
    }
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  test('the TLS mode is stored per listener and validated', () => {
    expect(db.getListener(ids.required)!.tlsMode).toBe('required');
    expect(db.getListener(ids.none)!.tlsMode).toBe('none');
    db.updateListener(ids.none, { tlsMode: 'bogus' as any });
    expect(db.getListener(ids.none)!.tlsMode).toBe('none');
  });

  test('plain FTP listeners refuse AUTH TLS', async () => {
    await expect(connect('none', true)).rejects.toThrow();
  });

  test('"optional" accepts plain FTP logins', async () => {
    const { client } = await connect('optional', false);
    expect((await client.list()).map(f => f.name)).toContain('hello.txt');
    client.close();
  });

  test('"optional" upgrades to TLS with the server certificate and transfers over encrypted data channels', async () => {
    const { client, peer } = await connect('optional', true);
    try {
      expect((client.ftp.socket as tls.TLSSocket).encrypted).toBe(true);
      expect(peer().fingerprint256).toBe(fingerprint);
      await client.uploadFrom(Readable.from([Buffer.from('secret upload')]), 'up.txt');
      expect(fs.readFileSync(path.join(root, 'up.txt'), 'utf8')).toBe('secret upload');
      const chunks: Buffer[] = [];
      await client.downloadTo(new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }), 'hello.txt');
      expect(Buffer.concat(chunks).toString()).toBe('over tls');
    } finally {
      client.close();
    }
  });

  test('"required" refuses unencrypted logins and records why', async () => {
    await expect(connect('required', false)).rejects.toThrow(/encrypted connection/);
    const activity = db.getRecentActivities(ids.required, 20);
    expect(activity.some(a => a.action.startsWith('LOGIN_FAILED (TLS required)') && a.username === 'tina')).toBe(true);
  });

  test('"required" accepts TLS logins', async () => {
    const { client } = await connect('required', true);
    expect((await client.list()).map(f => f.name)).toContain('hello.txt');
    client.close();
  });
});
