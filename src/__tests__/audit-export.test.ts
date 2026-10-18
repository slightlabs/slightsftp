/**
 * audit-export.test.ts — syslog forwarding (UDP/TCP) and SHA-256 upload
 * checksums across SFTP, FTP, the portal and share links.
 */
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Readable } from 'stream';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { SyslogForwarder, formatSyslog, readSyslogSettings, saveSyslogSettings } from '../syslog';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

describe('RFC 5424 formatting', () => {
  test('priority, header and escaped structured data', () => {
    const msg = formatSyslog({ listenerId: 2, username: 'ann', action: 'UPLOAD', path: '/a "b"].txt', success: true, bytes: 10, checksum: 'abc', timestamp: '2026-10-19 08:30:00' }, 16, 'files01');
    expect(msg).toBe('<134>1 2026-10-19T08:30:00.000Z files01 SLightSFTP ' + process.pid +
      ' UPLOAD [slightsftp@32473 user="ann" action="UPLOAD" path="/a \\"b\\"\\].txt" success="true" listener="2" bytes="10" sha256="abc"] ann UPLOAD /a "b"].txt');
  });

  test('failures are warnings; msgid is the first word of the action', () => {
    const msg = formatSyslog({ listenerId: null, username: 'x', action: 'LOGIN_FAILED (Invalid password) [1.2.3.4:5]', path: '/', success: false }, 4);
    expect(msg.startsWith('<36>1 ')).toBe(true); // 4*8 + 4
    expect(msg.split(' ')[5]).toBe('LOGIN_FAILED');
    expect(msg).not.toContain('listener=');
  });
});

describe('syslog forwarding', () => {
  let dir: string;
  let db: DatabaseManager;
  let forwarder: SyslogForwarder;

  beforeEach(async () => {
    dir = makeTempDir('syslog');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    forwarder = new SyslogForwarder(db);
  });

  afterEach(() => {
    forwarder.stop();
    db.close();
    removeDir(dir);
  });

  test('settings are validated and nothing is sent while disabled', async () => {
    expect(readSyslogSettings(db)).toEqual({ enabled: false, host: '', port: 514, protocol: 'udp', facility: 16 });
    expect(() => saveSyslogSettings(db, { enabled: true })).toThrow(/host is required/);
    expect(() => saveSyslogSettings(db, { port: 70000 })).toThrow(/Port/);
    expect(() => saveSyslogSettings(db, { facility: 30 })).toThrow(/Facility/);
    expect(() => saveSyslogSettings(db, { protocol: 'http' as any })).toThrow(/udp or tcp/);
    db.logActivity({ listenerId: null, username: 'a', action: 'X', path: '/', success: true });
    await forwarder.idle();
  });

  test('UDP: every activity entry is sent as one datagram', async () => {
    const received: string[] = [];
    const server = dgram.createSocket('udp4');
    await new Promise<void>(r => server.bind(0, '127.0.0.1', () => r()));
    server.on('message', m => received.push(m.toString()));
    saveSyslogSettings(db, { host: '127.0.0.1', port: (server.address() as any).port, protocol: 'udp', facility: 20, enabled: true });

    db.logActivity({ listenerId: 1, username: 'udpuser', action: 'UPLOAD', path: '/f.bin', success: true, bytes: 3, checksum: 'deadbeef' });
    db.logActivity({ listenerId: 1, username: 'udpuser', action: 'LOGIN_FAILED (Invalid password)', path: '/', success: false });
    await waitFor(() => received.length === 2);
    expect(received[0]).toMatch(/^<166>1 /); // local4.info
    expect(received[0]).toContain('user="udpuser" action="UPLOAD" path="/f.bin" success="true" listener="1" bytes="3" sha256="deadbeef"');
    expect(received[1]).toMatch(/^<164>1 /); // local4.warning
    server.close();
  });

  test('TCP: messages use octet-counting framing on one connection', async () => {
    let buffer = '';
    let connections = 0;
    const server = net.createServer(sock => { connections++; sock.on('data', d => { buffer += d.toString(); }); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    saveSyslogSettings(db, { host: '127.0.0.1', port: (server.address() as any).port, protocol: 'tcp', enabled: true });

    db.logActivity({ listenerId: null, username: 'tcpuser', action: 'GUI_LOGIN', path: '/', success: true });
    db.logActivity({ listenerId: null, username: 'tcpuser', action: 'GUI_LOGOUT', path: '/', success: true });
    await forwarder.idle();
    await waitFor(() => (buffer.match(/SLightSFTP/g) || []).length === 2);

    const frames: string[] = [];
    let rest = buffer;
    while (rest.length) {
      const sp = rest.indexOf(' ');
      const len = Number(rest.slice(0, sp));
      frames.push(rest.slice(sp + 1, sp + 1 + len));
      rest = rest.slice(sp + 1 + len);
    }
    expect(frames.map(f => f.split(' ')[5])).toEqual(['GUI_LOGIN', 'GUI_LOGOUT']);
    expect(connections).toBe(1);
    forwarder.stop();
    await new Promise(r => server.close(r));
  });

  test('an unreachable TCP server never blocks logging', async () => {
    saveSyslogSettings(db, { host: '127.0.0.1', port: await getFreePort(), protocol: 'tcp', enabled: true });
    const started = Date.now();
    db.logActivity({ listenerId: null, username: 'x', action: 'Y', path: '/', success: true });
    expect(Date.now() - started).toBeLessThan(100);
    await forwarder.idle();
  });
});

describe('upload checksums and the audit API', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let ftpPort: number;

  const uploads = () => db.getRecentActivities(undefined, 500).filter(a => /UPLOAD$/.test(a.action));

  beforeAll(async () => {
    dir = makeTempDir('checksums');
    root = path.join(dir, 'root');
    fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const id = db.createUser({ username: 'up', password: 'Upload-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: id, virtualPath: '/', localPath: root, ...FULL_VPATH_PERMS });
    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(id, db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(id, db.createListener({ name: 'F', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
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

  test('SFTP, FTP, portal and share-link uploads all record the SHA-256 of the stored file', async () => {
    const sftpBody = crypto.randomBytes(200_000);
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'up', password: 'Upload-Pass1', readyTimeout: 5000 });
    await c.put(sftpBody, '/sftp.bin');
    await c.end();

    const f = new ftp.Client(5000);
    await f.access({ host: '127.0.0.1', port: ftpPort, user: 'up', password: 'Upload-Pass1' });
    await f.uploadFrom(Readable.from([Buffer.from('ftp body')]), 'ftp.txt');
    f.close();

    const portal = request.agent(base);
    await portal.post('/portal/api/login').send({ username: 'up', password: 'Upload-Pass1' }).expect(200);
    await portal.put('/portal/api/upload').query({ path: '/portal.txt' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('portal body')).expect(201);
    const token = (await portal.post('/portal/api/shares').send({ path: '/inbox', type: 'upload' }).expect(201)).body.token;
    await request(base).put(`/s/${token}/upload`).query({ name: 'dropped.txt' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('dropped body')).expect(201);

    const entries = await waitFor(() => (uploads().length >= 4 ? uploads() : null));
    const byPath = Object.fromEntries(entries!.map(a => [a.path, a]));
    expect(byPath['/sftp.bin']).toMatchObject({ action: 'UPLOAD', bytes: 200_000, checksum: sha256(sftpBody) });
    expect(byPath['/ftp.txt']).toMatchObject({ action: 'UPLOAD', bytes: 8, checksum: sha256('ftp body') });
    expect(byPath['/portal.txt']).toMatchObject({ action: 'PORTAL_UPLOAD', bytes: 11, checksum: sha256('portal body') });
    expect(byPath['/inbox/dropped.txt']).toMatchObject({ action: 'SHARE_UPLOAD', bytes: 12, checksum: sha256('dropped body') });
  });

  test('the activity API exposes checksums', async () => {
    const res = await admin.get('/api/activity?limit=50').expect(200);
    expect(res.body.find((a: any) => a.path === '/ftp.txt').checksum).toBe(sha256('ftp body'));
  });

  test('checksums can be turned off', async () => {
    await admin.put('/api/audit/settings').send({ checksumUploads: false }).expect(200);
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'up', password: 'Upload-Pass1', readyTimeout: 5000 });
    await c.put(Buffer.from('x'), '/nosum.bin');
    await c.end();
    const entry = await waitFor(() => uploads().find(a => a.path === '/nosum.bin'));
    expect(entry!.checksum).toBeNull();
    await admin.put('/api/audit/settings').send({ checksumUploads: true }).expect(200);
  });

  test('audit settings API and "send test message"', async () => {
    const received: string[] = [];
    const server = dgram.createSocket('udp4');
    await new Promise<void>(r => server.bind(0, '127.0.0.1', () => r()));
    server.on('message', m => received.push(m.toString()));
    const port = (server.address() as any).port;

    await admin.put('/api/audit/settings').send({ syslog: { enabled: true } }).expect(400);
    const saved = await admin.put('/api/audit/settings').send({ syslog: { enabled: true, host: '127.0.0.1', port, protocol: 'udp', facility: 16 } }).expect(200);
    expect(saved.body).toEqual({ syslog: { enabled: true, host: '127.0.0.1', port, protocol: 'udp', facility: 16 }, checksumUploads: true });

    expect((await admin.post('/api/audit/test-syslog').expect(200)).body).toEqual({ ok: true });
    await waitFor(() => received.some(m => m.includes('SYSLOG_TEST')));
    await admin.put('/api/audit/settings').send({ syslog: { enabled: false } }).expect(200);
    server.close();
  });
});
