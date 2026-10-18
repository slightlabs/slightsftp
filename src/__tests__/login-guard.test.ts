/**
 * login-guard.test.ts — brute-force protection: CIDR handling, ban policy, and
 * real bans across SFTP, FTP, the web GUI, the portal and share links.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { LoginGuard, getLoginGuard, ipInList, normalizeIp, parseCidrList, saveGuardSettings } from '../login-guard';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('address lists', () => {
  test('normalises IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp(undefined)).toBe('');
  });

  test('parses single addresses and CIDR ranges, reporting invalid entries', () => {
    const { blockList, entries, invalid } = parseCidrList('10.0.0.0/8, 192.168.1.5; 2001:db8::/32 bogus 1.2.3.4/33');
    expect(entries).toEqual(['10.0.0.0/8', '192.168.1.5', '2001:db8::/32']);
    expect(invalid).toEqual(['bogus', '1.2.3.4/33']);
    expect(ipInList('10.200.3.4', blockList)).toBe(true);
    expect(ipInList('::ffff:10.0.0.1', blockList)).toBe(true);
    expect(ipInList('192.168.1.5', blockList)).toBe(true);
    expect(ipInList('192.168.1.6', blockList)).toBe(false);
    expect(ipInList('2001:db8:abcd::1', blockList)).toBe(true);
    expect(ipInList('2001:db9::1', blockList)).toBe(false);
    expect(ipInList('not-an-ip', blockList)).toBe(false);
  });
});

describe('LoginGuard policy', () => {
  let dir: string;
  let db: DatabaseManager;
  let guard: LoginGuard;

  beforeEach(async () => {
    dir = makeTempDir('guard');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    saveGuardSettings(db, { maxFailures: 3, windowMinutes: 10, banMinutes: 15, allowlist: '' });
    guard = new LoginGuard(db);
  });

  afterEach(() => {
    jest.useRealTimers();
    db.close();
    removeDir(dir);
  });

  test('bans after the configured number of failures and logs it', () => {
    expect(guard.recordFailure('203.0.113.9', 'SFTP', 'root')).toBe(false);
    expect(guard.recordFailure('203.0.113.9', 'SFTP', 'root')).toBe(false);
    expect(guard.isBanned('203.0.113.9')).toBe(false);
    expect(guard.recordFailure('::ffff:203.0.113.9', 'FTP', 'admin')).toBe(true);
    expect(guard.isBanned('203.0.113.9')).toBe(true);
    expect(guard.isBanned('203.0.113.10')).toBe(false);

    const [ban] = guard.listBans();
    expect(ban).toMatchObject({ ip: '203.0.113.9', reason: '3 failed logins in 10 min (last: FTP as admin)' });
    expect(Date.parse(ban.expiresAt) - Date.parse(ban.bannedAt)).toBe(15 * 60_000);
    expect(db.getRecentActivities(undefined, 5)[0]).toMatchObject({ action: 'IP_BANNED', username: 'admin', success: false });
  });

  test('failures outside the window do not add up', () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T10:00:00Z') });
    guard.recordFailure('198.51.100.1', 'SFTP');
    guard.recordFailure('198.51.100.1', 'SFTP');
    jest.setSystemTime(new Date('2026-06-01T10:11:00Z'));
    expect(guard.recordFailure('198.51.100.1', 'SFTP')).toBe(false);
    expect(guard.isBanned('198.51.100.1')).toBe(false);
  });

  test('bans expire, survive restarts, and can be lifted', () => {
    jest.useFakeTimers({ now: new Date('2026-06-01T10:00:00Z') });
    for (let i = 0; i < 3; i++) guard.recordFailure('198.51.100.2', 'web');
    expect(new LoginGuard(db).isBanned('198.51.100.2')).toBe(true); // persisted, not in memory only

    jest.setSystemTime(new Date('2026-06-01T10:16:00Z'));
    expect(guard.isBanned('198.51.100.2')).toBe(false);
    expect(guard.listBans()).toEqual([]);

    for (let i = 0; i < 3; i++) guard.recordFailure('198.51.100.2', 'web');
    guard.unban('198.51.100.2');
    expect(guard.isBanned('198.51.100.2')).toBe(false);
  });

  test('a successful login resets the count', () => {
    guard.recordFailure('198.51.100.3', 'SFTP');
    guard.recordFailure('198.51.100.3', 'SFTP');
    guard.recordSuccess('198.51.100.3');
    expect(guard.recordFailure('198.51.100.3', 'SFTP')).toBe(false);
    expect(guard.recordFailure('198.51.100.3', 'SFTP')).toBe(false);
    expect(guard.isBanned('198.51.100.3')).toBe(false);
  });

  test('allow-listed addresses and a disabled guard never ban', () => {
    saveGuardSettings(db, { allowlist: '192.0.2.0/24' });
    for (let i = 0; i < 10; i++) guard.recordFailure('192.0.2.77', 'SFTP');
    expect(guard.isBanned('192.0.2.77')).toBe(false);

    saveGuardSettings(db, { enabled: false });
    for (let i = 0; i < 10; i++) guard.recordFailure('203.0.113.50', 'SFTP');
    expect(guard.isBanned('203.0.113.50')).toBe(false);
  });

  test('loopback is exempt by default', () => {
    const fresh = makeTempDir('guard-default');
    const db2 = new DatabaseManager(path.join(fresh, 'config.db'));
    return db2.init().then(() => {
      const g = new LoginGuard(db2);
      for (let i = 0; i < 20; i++) g.recordFailure('127.0.0.1', 'SFTP');
      for (let i = 0; i < 20; i++) g.recordFailure('::1', 'SFTP');
      expect(g.isBanned('127.0.0.1')).toBe(false);
      expect(g.isBanned('::1')).toBe(false);
      expect(g.settings()).toEqual({ enabled: true, maxFailures: 5, windowMinutes: 10, banMinutes: 15, allowlist: '127.0.0.0/8, ::1' });
      db2.close();
      removeDir(fresh);
    });
  });

  test.each([
    [{ maxFailures: 0 }, /Failed attempts/],
    [{ windowMinutes: 1.5 }, /Window/],
    [{ banMinutes: -1 }, /Ban duration/],
    [{ allowlist: '10.0.0.0/8, nope' }, /Invalid address or range: nope/],
  ])('rejects invalid settings %j', (input, message) => {
    expect(() => saveGuardSettings(db, input as any)).toThrow(message);
  });
});

describe('bans are enforced on every login surface', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let ftpPort: number;
  let shareToken: string;

  const sftpLogin = async (password: string) => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'vic', password, readyTimeout: 4000, retries: 0 });
    await c.end();
  };
  const ftpLogin = async (password: string) => {
    const c = new ftp.Client(4000);
    try { await c.access({ host: '127.0.0.1', port: ftpPort, user: 'vic', password }); } finally { c.close(); }
  };
  const ban = () => { for (let i = 0; i < 3; i++) getLoginGuard(db).recordFailure('127.0.0.1', 'test'); };

  beforeAll(async () => {
    dir = makeTempDir('guard-e2e');
    fs.mkdirSync(path.join(dir, 'root'));
    fs.writeFileSync(path.join(dir, 'root', 'f.txt'), 'f');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    saveGuardSettings(db, { maxFailures: 3, allowlist: '' });
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const vic = db.createUser({ username: 'vic', password: 'Vic-Pass-123', passwordEnabled: true, guiEnabled: true, portalEnabled: true });
    db.addVirtualPath({ userId: vic, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(vic, db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(vic, db.createListener({ name: 'F', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    admin = request.agent(base);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);

    const portal = request.agent(base);
    await portal.post('/portal/api/login').send({ username: 'vic', password: 'Vic-Pass-123' }).expect(200);
    shareToken = (await portal.post('/portal/api/shares').send({ path: '/f.txt', type: 'download', password: 'link-pass' }).expect(201)).body.token;
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  afterEach(() => getLoginGuard(db).unban('127.0.0.1'));

  test('repeated SFTP password failures ban the address; even the right password is then refused', async () => {
    for (let i = 0; i < 3; i++) await expect(sftpLogin('wrong')).rejects.toThrow();
    await expect(sftpLogin('Vic-Pass-123')).rejects.toThrow();
    expect(db.getRecentActivities(undefined, 50).some(a => a.action === 'IP_BANNED' && a.path.startsWith('127.0.0.1'))).toBe(true);

    const bans = await admin.get('/api/security/bans').expect(200);
    expect(bans.body).toEqual([expect.objectContaining({ ip: '127.0.0.1', reason: expect.stringContaining('SFTP as vic') })]);
    await admin.delete('/api/security/bans/127.0.0.1').expect(200);
    await sftpLogin('Vic-Pass-123');
  });

  test('FTP failures count and a banned address is refused', async () => {
    for (let i = 0; i < 3; i++) await expect(ftpLogin('wrong')).rejects.toThrow();
    await expect(ftpLogin('Vic-Pass-123')).rejects.toThrow(/Too many failed attempts/);
  });

  test('web GUI logins: failures ban, banned answers 429, existing sessions keep working', async () => {
    for (let i = 0; i < 3; i++) await request(base).post('/api/login').send({ username: 'vic', password: 'wrong' }).expect(401);
    const res = await request(base).post('/api/login').send({ username: 'vic', password: 'Vic-Pass-123' }).expect(429);
    expect(res.body.error).toBe('Too many failed attempts. Try again later.');
    await admin.get('/api/security/bans').expect(200); // signed-in admin can still lift the ban
  });

  test('portal logins and share-link passwords are protected too', async () => {
    for (let i = 0; i < 3; i++) await request(base).post('/portal/api/login').send({ username: 'vic', password: 'wrong' }).expect(401);
    await request(base).post('/portal/api/login').send({ username: 'vic', password: 'Vic-Pass-123' }).expect(429);
    getLoginGuard(db).unban('127.0.0.1');

    for (let i = 0; i < 3; i++) await request(base).post(`/s/${shareToken}/unlock`).send({ password: 'nope' }).expect(401);
    await request(base).post(`/s/${shareToken}/unlock`).send({ password: 'link-pass' }).expect(429);
  });

  test('settings API validates and stores the policy', async () => {
    await admin.put('/api/security/settings').send({ maxFailures: 0 }).expect(400);
    const saved = await admin.put('/api/security/settings').send({ maxFailures: 4, banMinutes: 60, allowlist: '10.0.0.0/8' }).expect(200);
    expect(saved.body).toMatchObject({ enabled: true, maxFailures: 4, banMinutes: 60, allowlist: '10.0.0.0/8' });
    saveGuardSettings(db, { maxFailures: 3, allowlist: '' });
  });

  test('a ban created any other way also blocks SFTP immediately', async () => {
    ban();
    await expect(sftpLogin('Vic-Pass-123')).rejects.toThrow();
  });
});
