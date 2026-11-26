import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { Client as SshClient } from 'ssh2';
import { DatabaseManager } from '../database';
import { WebServer } from '../web-server';
import { SFTPServer } from '../sftp-server';
import { cleanTrustProxy, CONTENT_SECURITY_POLICY } from '../http-security';
import { isWildcardAddress, maxConnections, passiveAddressResolver } from '../connection-limits';
import { hashPassword, verifyPasswordHash, verifyPasswordHashAsync } from '../password';
import { validateSetting } from '../settings-policy';

const SftpClient = require('ssh2-sftp-client');

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const fakeServerManager: any = {
  on: jest.fn(), off: jest.fn(), emit: jest.fn(),
  getActiveSessions: jest.fn().mockReturnValue([]),
  isListenerRunning: jest.fn().mockReturnValue(false),
  stopAllListeners: jest.fn(), startAllEnabledListeners: jest.fn(),
};

async function webFixture() {
  const db = new DatabaseManager(':memory:');
  await db.init();
  db.createUser({ username: 'admin', password: 'Admin#2026', passwordEnabled: true, publicKey: '', guiEnabled: true });
  return { db, web: new WebServer(db, fakeServerManager, 0) };
}

describe('HTTP hardening', () => {
  test('security headers are sent on every page', async () => {
    const { web, db } = await webFixture();
    const res = await request(web.getApp()).get('/files');
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    db.close();
  });

  test('cross-site state-changing requests are refused; same-site and non-browser ones pass', async () => {
    const { web, db } = await webFixture();
    const app = web.getApp();
    const body = { username: 'admin', password: 'Admin#2026' };
    await request(app).post('/api/login').set('Origin', 'https://evil.example').send(body).expect(403);
    await request(app).post('/api/login').set('Origin', 'null').send(body).expect(403);
    await request(app).post('/files/api/login').set('Referer', 'https://evil.example/page').send(body).expect(403);
    await request(app).post('/api/login').set('Host', 'gui.local:3000').set('Origin', 'https://gui.local:3000').send(body).expect(200);
    await request(app).post('/api/login').send(body).expect(200); // curl / scripts send no Origin
    db.close();
  });

  test('activity log page size is capped', async () => {
    const { web, db } = await webFixture();
    const spy = jest.spyOn(db, 'getRecentActivities');
    const agent = request.agent(web.getApp());
    await agent.post('/api/login').send({ username: 'admin', password: 'Admin#2026' }).expect(200);
    await agent.get('/api/activity?limit=999999999').expect(200);
    expect(spy).toHaveBeenLastCalledWith(undefined, 1000);
    await agent.get('/api/activity?limit=abc').expect(200);
    expect(spy).toHaveBeenLastCalledWith(undefined, 100);
    db.close();
  });
});

describe('trusted reverse proxies', () => {
  test('cleanTrustProxy accepts addresses, ranges and keywords, never "trust everyone"', () => {
    expect(cleanTrustProxy('')).toBe('');
    expect(cleanTrustProxy('loopback, 10.0.0.0/8 ,::1')).toBe('loopback, 10.0.0.0/8, ::1');
    expect(() => cleanTrustProxy('true')).toThrow(/Invalid proxy/);
    expect(() => cleanTrustProxy('*')).toThrow(/Invalid proxy/);
    expect(validateSetting('trustProxy', 'loopback')).toBeNull();
    expect(validateSetting('trustProxy', 'everyone')).not.toBeNull();
  });

  test('without a trusted proxy, X-Forwarded-For is ignored (a client cannot pick its address)', async () => {
    const { web, db } = await webFixture();
    db.setSetting('ipAllowlist', ''); // count loopback failures for this test
    const app = web.getApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/login').set('X-Forwarded-For', `198.51.100.${i}`).send({ username: 'admin', password: 'nope' });
    }
    expect(db.listIpBans().map(b => b.ip)).toEqual(['127.0.0.1']);
    db.close();
  });

  test('behind a trusted proxy, bans hit the real client, not the proxy', async () => {
    const { web, db } = await webFixture();
    db.setSetting('trustProxy', 'loopback');
    web.applyTrustProxy();
    const app = web.getApp();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/login').set('X-Forwarded-For', '203.0.113.9').send({ username: 'admin', password: 'nope' });
    }
    expect(db.listIpBans().map(b => b.ip)).toEqual(['203.0.113.9']);
    // the proxy itself (other clients) still gets through
    await request(app).post('/api/login').set('X-Forwarded-For', '203.0.113.10').send({ username: 'admin', password: 'Admin#2026' }).expect(200);
    await request(app).post('/api/login').set('X-Forwarded-For', '203.0.113.9').send({ username: 'admin', password: 'Admin#2026' }).expect(429);
    db.close();
  });
});

describe('async password verification', () => {
  test('agrees with the synchronous check', async () => {
    const hash = hashPassword('correct horse');
    expect(await verifyPasswordHashAsync(hash, 'correct horse')).toEqual(verifyPasswordHash(hash, 'correct horse'));
    expect((await verifyPasswordHashAsync(hash, 'wrong')).valid).toBe(false);
    expect((await verifyPasswordHashAsync(hash, '')).valid).toBe(false);
    expect((await verifyPasswordHashAsync('garbage', 'x')).valid).toBe(false);
  });

  test('does not block the event loop', async () => {
    const hash = hashPassword('pw');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await Promise.all(Array.from({ length: 8 }, () => verifyPasswordHashAsync(hash, 'nope')));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('FTP passive address', () => {
  test('FTP_PASV_URL wins, then a specific binding address', () => {
    expect(passiveAddressResolver('0.0.0.0', () => undefined, '203.0.113.1')).toBe('203.0.113.1');
    expect(passiveAddressResolver('192.168.1.10', () => undefined, '')).toBe('192.168.1.10');
  });

  test('a wildcard listener advertises the address the client reached', () => {
    const resolve = passiveAddressResolver('0.0.0.0', ip => (ip === '10.1.1.1' ? '::ffff:10.0.0.5' : undefined), '') as (ip: string) => string;
    expect(typeof resolve).toBe('function');
    expect(resolve('10.1.1.1')).toBe('10.0.0.5');
    expect(resolve('10.9.9.9')).toBe('127.0.0.1');
    expect(isWildcardAddress('::')).toBe(true);
  });
});

describe('SFTP connection limits and attributes', () => {
  let db: DatabaseManager;
  let server: SFTPServer;
  let dir: string;
  let port: number;

  const freePort = () => new Promise<number>(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-p1-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    db = new DatabaseManager(':memory:');
    await db.init();
    const userId = db.createUser({ username: 'u', password: 'pw-123456', passwordEnabled: true, publicKey: '', guiEnabled: false });
    port = await freePort();
    const listenerId = db.createListener({ name: 'T', protocol: 'SFTP', bindingIp: '127.0.0.1', port, enabled: true });
    db.subscribeUserToListener(userId, listenerId);
    db.setPermission({ userId, listenerId, canRead: true, canCreate: true, canEdit: true, canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true });
    db.addVirtualPath({ userId, virtualPath: '/', localPath: dir, canRead: true, canWrite: true, canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true, applyToSubdirs: true });
  });

  afterEach(async () => {
    delete process.env.SLIGHTSFTP_PRE_AUTH_TIMEOUT_MS;
    await server?.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = async () => {
    server = new SFTPServer(db.getListener(db.getAllListeners()[0].id!)!, db);
    await server.start();
  };

  test('clients that never sign in are disconnected', async () => {
    process.env.SLIGHTSFTP_PRE_AUTH_TIMEOUT_MS = '300';
    await start();
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.resume(); // read (and discard) the server's greeting so end/close are seen
    const closedAfter = await new Promise<number>(resolve => {
      const t0 = Date.now();
      socket.write('SSH-2.0-test\r\n');
      // the server dropping the connection: we see end (and usually close)
      socket.once('end', () => resolve(Date.now() - t0));
      socket.once('close', () => resolve(Date.now() - t0));
    });
    expect(closedAfter).toBeLessThan(5000);
    socket.destroy();
  });

  test('the listener refuses connections beyond maxConnectionsPerListener', async () => {
    db.setSetting('maxConnectionsPerListener', '1');
    expect(maxConnections(db)).toBe(1);
    await start();
    const first = new SshClient();
    await new Promise<void>((resolve, reject) => {
      first.on('ready', () => resolve()).on('error', reject)
        .connect({ host: '127.0.0.1', port, username: 'u', password: 'pw-123456' });
    });
    const second = new SshClient();
    const err = await new Promise<any>(resolve => {
      second.on('ready', () => resolve(null)).on('error', resolve).on('close', () => resolve(new Error('closed')))
        .connect({ host: '127.0.0.1', port, username: 'u', password: 'pw-123456', readyTimeout: 3000 });
    });
    expect(err).toBeTruthy();
    first.end();
    second.end();
  });

  test('uploads can preserve the modification time (SETSTAT / FSETSTAT) and FSTAT reports the size', async () => {
    await start();
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port, username: 'u', password: 'pw-123456' });
    const sftp = client.sftp;
    const mtime = 1_600_000_000;
    await new Promise<void>((resolve, reject) => sftp.setstat('/a.txt', { atime: mtime, mtime }, (e: any) => (e ? reject(e) : resolve())));
    expect(Math.floor(fs.statSync(path.join(dir, 'a.txt')).mtimeMs / 1000)).toBe(mtime);

    const size = await new Promise<number>((resolve, reject) => sftp.open('/a.txt', 'r', (e: any, h: Buffer) => {
      if (e) return reject(e);
      sftp.fstat(h, (e2: any, st: any) => sftp.close(h, () => (e2 ? reject(e2) : resolve(st.size))));
    }));
    expect(size).toBe(5);

    await new Promise<void>((resolve, reject) => sftp.open('/b.txt', 'w', (e: any, h: Buffer) => {
      if (e) return reject(e);
      sftp.futimes(h, mtime, mtime, (e2: any) => sftp.close(h, () => (e2 ? reject(e2) : resolve())));
    }));
    expect(Math.floor(fs.statSync(path.join(dir, 'b.txt')).mtimeMs / 1000)).toBe(mtime);
    await client.end();
  });

  test('SETSTAT is refused without write permission', async () => {
    const user = db.getUser('u')!;
    db.replaceUserAccess(user.id!, [db.getAllListeners()[0].id!], [
      { virtualPath: '/', localPath: dir, canRead: true, canWrite: false, canAppend: false, canDelete: false, canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true },
    ]);
    await start();
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port, username: 'u', password: 'pw-123456' });
    const err = await new Promise<any>(resolve => client.sftp.setstat('/a.txt', { atime: 1, mtime: 1 }, resolve));
    expect(err).toBeTruthy();
    await client.end();
  });
});
