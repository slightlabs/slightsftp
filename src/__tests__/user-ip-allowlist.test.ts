/**
 * user-ip-allowlist.test.ts — per-user "allowed IP addresses".
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { cleanAllowedIps, userIpAllowed } from '../login-guard';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('userIpAllowed / cleanAllowedIps', () => {
  test('empty means anywhere; otherwise addresses and ranges', () => {
    expect(userIpAllowed({}, '1.2.3.4')).toBe(true);
    expect(userIpAllowed({ allowedIps: '  ' }, '1.2.3.4')).toBe(true);
    expect(userIpAllowed({ allowedIps: '10.0.0.0/8, 192.0.2.1' }, '10.9.9.9')).toBe(true);
    expect(userIpAllowed({ allowedIps: '10.0.0.0/8, 192.0.2.1' }, '::ffff:192.0.2.1')).toBe(true);
    expect(userIpAllowed({ allowedIps: '10.0.0.0/8, 192.0.2.1' }, '192.0.2.2')).toBe(false);
    expect(userIpAllowed({ allowedIps: '10.0.0.0/8' }, undefined)).toBe(false);
  });

  test('cleans and validates form input', () => {
    expect(cleanAllowedIps('')).toBeNull();
    expect(cleanAllowedIps(undefined)).toBeNull();
    expect(cleanAllowedIps(' 10.0.0.0/8 ;192.0.2.1 ')).toBe('10.0.0.0/8, 192.0.2.1');
    expect(() => cleanAllowedIps('10.0.0.0/8, office')).toThrow('Invalid address or range: office');
  });
});

describe('restricted users can only sign in from allowed addresses', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let ftpPort: number;

  const sftpLogin = async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'rita', password: 'Rita-Pass-1', readyTimeout: 4000, retries: 0 });
    await c.end();
  };
  const ftpLogin = async () => {
    const c = new ftp.Client(4000);
    try { await c.access({ host: '127.0.0.1', port: ftpPort, user: 'rita', password: 'Rita-Pass-1' }); } finally { c.close(); }
  };
  const webLogin = () => request(base).post('/api/login').send({ username: 'rita', password: 'Rita-Pass-1' });
  const portalLogin = () => request(base).post('/portal/api/login').send({ username: 'rita', password: 'Rita-Pass-1' });

  beforeAll(async () => {
    dir = makeTempDir('allowip');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const rita = db.createUser({ username: 'rita', password: 'Rita-Pass-1', passwordEnabled: true, guiEnabled: true, portalEnabled: true, allowedIps: '203.0.113.0/24' });
    db.addVirtualPath({ userId: rita, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(rita, db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(rita, db.createListener({ name: 'F', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    admin = request.agent(base);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  test('from a disallowed address every login is refused with the normal error', async () => {
    await expect(sftpLogin()).rejects.toThrow();
    await expect(ftpLogin()).rejects.toThrow();
    expect((await webLogin().expect(401)).body.error).toBe('Invalid credentials');
    expect((await portalLogin().expect(401)).body.error).toBe('Invalid username or password');

    const refused = db.getRecentActivities(undefined, 50).filter(a => a.username === 'rita' && a.action.startsWith('LOGIN_FAILED (IP not allowed)'));
    expect(new Set(refused.map(a => a.listenerId)).size).toBe(2); // logged by both SFTP and FTP
    expect(db.getRecentActivities(undefined, 50).some(a => a.action === 'WEB_LOGIN_FAILED' && a.path === 'IP not allowed')).toBe(true);
  });

  test('admins set the allow-list through the API; invalid lists are rejected', async () => {
    await admin.put('/api/users/rita').send({ allowedIps: '127.0.0.1, banana' }).expect(400);
    await admin.put('/api/users/rita').send({ allowedIps: '127.0.0.0/8 ::1' }).expect(200);
    expect((await admin.get('/api/users/rita')).body.allowedIps).toBe('127.0.0.0/8, ::1');

    await sftpLogin();
    await ftpLogin();
    await webLogin().expect(200);
    await portalLogin().expect(200);
  });

  test('clearing the list allows any address again', async () => {
    await admin.put('/api/users/rita').send({ allowedIps: '' }).expect(200);
    expect(db.getUser('rita')!.allowedIps).toBeNull();
    await sftpLogin();
  });

  test('creating a user validates the list', async () => {
    await admin.post('/api/users').send({ username: 'x', password: 'X-Pass-123', passwordEnabled: true, allowedIps: '300.1.1.1' }).expect(400);
    await admin.post('/api/users').send({ username: 'y', password: 'Y-Pass-123', passwordEnabled: true, allowedIps: '198.51.100.0/24' }).expect(200);
    expect(db.getUser('y')!.allowedIps).toBe('198.51.100.0/24');
  });
});
