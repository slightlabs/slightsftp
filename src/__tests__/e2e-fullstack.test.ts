/**
 * e2e-fullstack.test.ts — true end-to-end tests with nothing mocked.
 *
 * An administrator configures the system exclusively through the web GUI's
 * REST API (exactly what the browser GUI does), then real SFTP / FTP clients
 * connect to the listeners that were created, and the results are verified
 * back through the API (sessions, activity log, file browser, WebSocket feed).
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import WebSocket from 'ws';
import * as ftp from 'basic-ftp';
import { Writable, Readable } from 'stream';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');

jest.setTimeout(30000);

describe('Full-stack E2E: web admin API → live SFTP/FTP listeners → real clients', () => {
  let testDir: string;
  let ftpRoot: string;
  let readonlyRoot: string;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let webServer: WebServer;
  let webPort: number;
  let sftpPort: number;
  let ftpPort: number;
  let sftpListenerId: number;
  let ftpListenerId: number;
  let admin: ReturnType<typeof request.agent>;
  let baseUrl: string;

  const sftpConnect = async (username: string, password: string) => {
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: sftpPort, username, password, readyTimeout: 5000, retries: 0 });
    return client;
  };

  const ftpConnect = async (user: string, password: string) => {
    const client = new ftp.Client(5000);
    await client.access({ host: '127.0.0.1', port: ftpPort, user, password, secure: false });
    return client;
  };

  beforeAll(async () => {
    testDir = makeTempDir('fullstack');
    ftpRoot = path.join(testDir, 'root');
    readonlyRoot = path.join(testDir, 'readonly');
    fs.mkdirSync(ftpRoot, { recursive: true });
    fs.mkdirSync(readonlyRoot, { recursive: true });
    fs.writeFileSync(path.join(ftpRoot, 'welcome.txt'), 'hello from server');
    fs.writeFileSync(path.join(readonlyRoot, 'report.txt'), 'read only data');
    fs.writeFileSync(path.join(testDir, 'secret.txt'), 'outside of any root');

    db = new DatabaseManager(path.join(testDir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin#2026', passwordEnabled: true, guiEnabled: true });

    [webPort, sftpPort, ftpPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
    serverManager = new ServerManager(db);
    webServer = new WebServer(db, serverManager, webPort);
    await webServer.start();
    baseUrl = `http://127.0.0.1:${webPort}`;
    admin = request.agent(baseUrl);
  });

  afterAll(async () => {
    await serverManager?.stopAllListeners().catch(() => undefined);
    await webServer?.stop().catch(() => undefined);
    db?.close();
    removeDir(testDir);
  });

  describe('web authentication', () => {
    test('unauthenticated API access is rejected and GUI redirects to login', async () => {
      await request(baseUrl).get('/api/users').expect(401);
      const res = await request(baseUrl).get('/').expect(302);
      expect(res.headers.location).toBe('/login');
    });

    test('login page and renderer bundle are served without Electron requires', async () => {
      const login = await request(baseUrl).get('/login').expect(200);
      expect(login.text).toContain('loginForm');
      expect(login.text).not.toMatch(/require\('electron'\)/);
      expect(login.text).toContain('window.ipcRenderer');

      const renderer = await request(baseUrl).get('/renderer.js').expect(200);
      expect(renderer.headers['content-type']).toMatch(/javascript/);
      expect(renderer.text).not.toMatch(/const\s*{\s*ipcRenderer\s*}\s*=\s*require\('electron'\)/);
    });

    test('admin can log in and receives an httpOnly session cookie', async () => {
      const res = await admin.post('/api/login').send({ username: 'admin', password: 'Admin#2026' }).expect(200);
      expect(res.body).toEqual({ success: true, username: 'admin' });
      expect(String(res.headers['set-cookie'])).toMatch(/sessionId=.*HttpOnly/i);

      const me = await admin.get('/api/user').expect(200);
      expect(me.body.username).toBe('admin');

      const page = await admin.get('/').expect(200);
      expect(page.text).toContain('<script src="/renderer.js"></script>');
    });

    test('wrong password is rejected and logged as a failed login', async () => {
      await request(baseUrl).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
      const activity = await admin.get('/api/activity?limit=50').expect(200);
      expect(activity.body.some((a: any) => a.action === 'WEB_LOGIN_FAILED' && a.username === 'admin')).toBe(true);
    });
  });

  describe('provisioning through the API', () => {
    test('creates and auto-starts SFTP and FTP listeners', async () => {
      const sftp = await admin.post('/api/listeners')
        .send({ name: 'E2E SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true })
        .expect(200);
      sftpListenerId = sftp.body.id;

      const ftpRes = await admin.post('/api/listeners')
        .send({ name: 'E2E FTP', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true })
        .expect(200);
      ftpListenerId = ftpRes.body.id;

      const statuses = await admin.get('/api/listener-statuses').expect(200);
      const byId = new Map(statuses.body.map((s: any) => [s.listener.id, s.running]));
      expect(byId.get(sftpListenerId)).toBe(true);
      expect(byId.get(ftpListenerId)).toBe(true);
      expect(byId.get(-1)).toBe(true); // Web GUI pseudo-listener
    });

    test('creates a user with a password, subscriptions and a virtual path', async () => {
      await admin.post('/api/users')
        .send({ username: 'alice', password: 'alice-pass', passwordEnabled: true, guiEnabled: true })
        .expect(200);
      await admin.post('/api/users/alice/subscriptions').send({ listenerId: sftpListenerId }).expect(200);
      await admin.post('/api/users/alice/subscriptions').send({ listenerId: ftpListenerId }).expect(200);
      await admin.post('/api/users/alice/virtual-paths')
        .send({ virtualPath: '/', localPath: ftpRoot, ...FULL_VPATH_PERMS })
        .expect(200);

      const subs = await admin.get('/api/users/alice/subscriptions').expect(200);
      expect(subs.body.sort()).toEqual([sftpListenerId, ftpListenerId].sort());
      const vps = await admin.get('/api/users/alice/virtual-paths').expect(200);
      expect(vps.body).toHaveLength(1);
      expect(vps.body[0].localPath).toBe(ftpRoot);
    });

    test('a user created via the API never exposes or double-hashes the password', async () => {
      const res = await admin.get('/api/users/alice').expect(200);
      expect(res.body.password).not.toBe('alice-pass');
      expect(db.verifyPassword('alice', 'alice-pass')).toBe(true);
    });

    test('a user created via the API can log into the web GUI', async () => {
      const alice = request.agent(baseUrl);
      await alice.post('/api/login').send({ username: 'alice', password: 'alice-pass' }).expect(200);
      await alice.get('/api/user').expect(200);
    });
  });

  describe('SFTP client against the API-provisioned listener', () => {
    let client: any;

    beforeAll(async () => {
      client = await sftpConnect('alice', 'alice-pass');
    });

    afterAll(async () => {
      await client?.end().catch(() => undefined);
    });

    test('lists, downloads, uploads, renames, makes dirs and deletes', async () => {
      const listing = await client.list('/');
      expect(listing.map((f: any) => f.name)).toContain('welcome.txt');

      const downloaded = await client.get('/welcome.txt');
      expect(downloaded.toString()).toBe('hello from server');

      await client.put(Buffer.from('uploaded via sftp'), '/upload.txt');
      expect(fs.readFileSync(path.join(ftpRoot, 'upload.txt'), 'utf8')).toBe('uploaded via sftp');

      await client.mkdir('/incoming');
      expect(fs.statSync(path.join(ftpRoot, 'incoming')).isDirectory()).toBe(true);

      await client.rename('/upload.txt', '/incoming/moved.txt');
      expect(fs.existsSync(path.join(ftpRoot, 'incoming', 'moved.txt'))).toBe(true);
      expect(fs.existsSync(path.join(ftpRoot, 'upload.txt'))).toBe(false);

      await client.delete('/incoming/moved.txt');
      await client.rmdir('/incoming');
      expect(fs.existsSync(path.join(ftpRoot, 'incoming'))).toBe(false);
    });

    test('cannot escape the virtual root with ..', async () => {
      const listing = await client.list('/../').catch(() => []);
      expect(listing.map((f: any) => f.name)).not.toContain('secret.txt');
      await expect(client.get('/../secret.txt')).rejects.toThrow();
    });

    test('the live session is visible via /api/sessions', async () => {
      const sessions = await waitFor(async () => {
        const res = await admin.get('/api/sessions').expect(200);
        return res.body.filter((s: any) => s.username === 'alice' && s.protocol === 'SFTP').length ? res.body : null;
      });
      const s = sessions.find((x: any) => x.username === 'alice');
      expect(s).toMatchObject({ listenerId: sftpListenerId, listenerName: 'E2E SFTP', protocol: 'SFTP' });
      expect(s.ipAddress).toMatch(/127\.0\.0\.1/);
    });

    test('transfers are recorded in the activity log', async () => {
      const res = await admin.get('/api/activity?limit=500').expect(200);
      const mine = res.body.filter((a: any) => a.username === 'alice' && a.listenerId === sftpListenerId);
      expect(mine.some((a: any) => /^LOGIN/.test(a.action))).toBe(true);
      expect(mine.length).toBeGreaterThan(3);
      // completed transfers are single entries with the transferred size
      expect(mine).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'UPLOAD', path: '/upload.txt', bytes: 'uploaded via sftp'.length, success: true }),
        expect.objectContaining({ action: 'DOWNLOAD', path: '/welcome.txt', bytes: 'hello from server'.length, success: true }),
      ]));
    });
  });

  describe('session control from the GUI API', () => {
    test('DELETE /api/sessions/:id forcibly disconnects the SFTP client', async () => {
      const client = await sftpConnect('alice', 'alice-pass');
      const closed = new Promise<void>(resolve => client.client.once('close', () => resolve()));

      const sessions = await waitFor(async () => {
        const res = await admin.get('/api/sessions');
        return res.body.find((s: any) => s.username === 'alice' && s.protocol === 'SFTP');
      });
      await admin.delete(`/api/sessions/${encodeURIComponent(sessions.sessionId)}`).expect(200);
      await closed;

      const after = await admin.get('/api/sessions');
      expect(after.body.find((s: any) => s.sessionId === sessions.sessionId)).toBeUndefined();
      await client.end().catch(() => undefined);
    });

    test('disconnecting an unknown session returns 404', async () => {
      await admin.delete('/api/sessions/does-not-exist').expect(404);
    });
  });

  describe('FTP client against the API-provisioned listener', () => {
    test('uploads, lists and downloads', async () => {
      const client = await ftpConnect('alice', 'alice-pass');
      try {
        await client.uploadFrom(Readable.from([Buffer.from('ftp upload body')]), 'ftp-upload.txt');
        expect(fs.readFileSync(path.join(ftpRoot, 'ftp-upload.txt'), 'utf8')).toBe('ftp upload body');

        const names = (await client.list('/')).map(f => f.name);
        expect(names).toEqual(expect.arrayContaining(['welcome.txt', 'ftp-upload.txt']));

        const chunks: Buffer[] = [];
        const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
        await client.downloadTo(sink, 'welcome.txt');
        expect(Buffer.concat(chunks).toString()).toBe('hello from server');

        await client.remove('ftp-upload.txt');
        expect(fs.existsSync(path.join(ftpRoot, 'ftp-upload.txt'))).toBe(false);

        const entries = (await admin.get('/api/activity?limit=500')).body.filter((a: any) => a.listenerId === ftpListenerId);
        expect(entries).toEqual(expect.arrayContaining([
          expect.objectContaining({ action: 'UPLOAD', path: '/ftp-upload.txt', bytes: 'ftp upload body'.length }),
          expect.objectContaining({ action: 'DOWNLOAD', path: '/welcome.txt', bytes: 'hello from server'.length }),
        ]));
      } finally {
        client.close();
      }
    });

    test('rejects a bad password', async () => {
      await expect(ftpConnect('alice', 'wrong')).rejects.toThrow();
    });

    // Each probe uses a fresh control connection: after a refused transfer the
    // FTP control channel can carry a late reply that would desync the next command.
    const withFtp = async <T>(fn: (c: ftp.Client) => Promise<T>): Promise<T> => {
      const client = await ftpConnect('alice', 'alice-pass');
      try { return await fn(client); } finally { client.close(); }
    };

    test('cannot escape the virtual root with ..', async () => {
      const listed = await withFtp(c => c.list('/..').then(l => l.map(f => f.name)).catch(() => [] as string[]));
      expect(listed).not.toContain('secret.txt');

      const afterCd = await withFtp(async c => {
        await c.cd('..').catch(() => undefined);
        return c.list().then(l => l.map(f => f.name)).catch(() => [] as string[]);
      });
      expect(afterCd).not.toContain('secret.txt');

      const chunks: Buffer[] = [];
      const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
      await withFtp(c => c.downloadTo(sink, '../secret.txt')).catch(() => undefined);
      expect(Buffer.concat(chunks).toString()).not.toContain('outside of any root');

      await withFtp(c => c.uploadFrom(Readable.from([Buffer.from('x')]), '../escaped.txt')).catch(() => undefined);
      expect(fs.existsSync(path.join(testDir, 'escaped.txt'))).toBe(false);
    });
  });

  describe('permissions provisioned via the API are enforced', () => {
    beforeAll(async () => {
      await admin.post('/api/users').send({ username: 'reader', password: 'reader-pass', passwordEnabled: true, guiEnabled: false }).expect(200);
      await admin.post('/api/users/reader/subscriptions').send({ listenerId: sftpListenerId }).expect(200);
      await admin.post('/api/users/reader/virtual-paths').send({
        virtualPath: '/', localPath: readonlyRoot,
        canRead: true, canList: true, canWrite: false, canAppend: false,
        canDelete: false, canCreateDir: false, canRename: false, applyToSubdirs: true,
      }).expect(200);
    });

    test('read-only user can read but not write, delete, rename or mkdir', async () => {
      const client = await sftpConnect('reader', 'reader-pass');
      try {
        expect((await client.get('/report.txt')).toString()).toBe('read only data');
        await expect(client.put(Buffer.from('x'), '/new.txt')).rejects.toThrow();
        await expect(client.delete('/report.txt')).rejects.toThrow();
        await expect(client.rename('/report.txt', '/renamed.txt')).rejects.toThrow();
        await expect(client.mkdir('/dir')).rejects.toThrow();
        expect(fs.readdirSync(readonlyRoot)).toEqual(['report.txt']);
      } finally {
        await client.end().catch(() => undefined);
      }
    });

    test('user without GUI access cannot log into the web GUI', async () => {
      await request(baseUrl).post('/api/login').send({ username: 'reader', password: 'reader-pass' }).expect(403);
    });

    test('user is refused on a listener they are not subscribed to', async () => {
      await expect(ftpConnect('reader', 'reader-pass')).rejects.toThrow();
    });

    test('unsubscribing via the API revokes SFTP access', async () => {
      await admin.delete(`/api/users/reader/subscriptions/${sftpListenerId}`).expect(200);
      await expect(sftpConnect('reader', 'reader-pass')).rejects.toThrow();
    });
  });

  describe('file browser API', () => {
    test('lists the files a user can see', async () => {
      const res = await admin.get('/api/files/browse').query({ username: 'alice', path: '/' }).expect(200);
      expect(res.body.files.map((f: any) => f.name)).toContain('welcome.txt');
      const welcome = res.body.files.find((f: any) => f.name === 'welcome.txt');
      expect(welcome).toMatchObject({ type: 'file', size: 'hello from server'.length });
    });

    test('rejects path traversal outside the virtual root', async () => {
      const res = await admin.get('/api/files/browse').query({ username: 'alice', path: '/../' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('secret.txt');
    });

    test('downloads a file through the API', async () => {
      const res = await admin.get('/api/files/download').query({ username: 'alice', path: '/welcome.txt' }).expect(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="?welcome\.txt"?/);
      expect(res.text ?? res.body.toString()).toBe('hello from server');
    });

    test('download rejects traversal and directories', async () => {
      await admin.get('/api/files/download').query({ username: 'alice', path: '/../secret.txt' }).expect(403);
      fs.mkdirSync(path.join(ftpRoot, 'adir'), { recursive: true });
      await admin.get('/api/files/download').query({ username: 'alice', path: '/adir' }).expect(400);
    });
  });

  describe('real-time WebSocket feed', () => {
    test('server activity (an SFTP login) is pushed to connected GUI clients', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${webPort}`);
      const messages: any[] = [];
      ws.on('message', data => messages.push(JSON.parse(data.toString())));
      await new Promise(resolve => ws.once('open', resolve));

      const client = await sftpConnect('alice', 'alice-pass');
      try {
        const msg = await waitFor(() => messages.find(m => m.type === 'activity' && m.data?.username === 'alice' && /^LOGIN/.test(m.data.action)));
        expect(msg.data.listenerId).toBe(sftpListenerId);
      } finally {
        await client.end().catch(() => undefined);
        ws.close();
      }
    });
  });

  describe('user lifecycle through the API', () => {
    test('changing a password via PUT takes effect for SFTP and web login', async () => {
      await admin.put('/api/users/alice')
        .send({ password: 'alice-new', passwordEnabled: true, guiEnabled: true })
        .expect(200);

      await expect(sftpConnect('alice', 'alice-pass')).rejects.toThrow();
      const client = await sftpConnect('alice', 'alice-new');
      await client.end();

      await request(baseUrl).post('/api/login').send({ username: 'alice', password: 'alice-new' }).expect(200);
    });

    test('PUT can update subscriptions, permissions and virtual paths in one call (GUI edit-user flow)', async () => {
      await admin.put('/api/users/alice').send({
        passwordEnabled: true,
        guiEnabled: true,
        listeners: [sftpListenerId],
        virtualPaths: [{ virtualPath: '/', localPath: readonlyRoot, canRead: true, canList: true, canWrite: false }],
        permissions: [{ listenerId: sftpListenerId, canRead: true, canList: true, canCreate: false, canEdit: false, canAppend: false, canDelete: false, canCreateDir: false, canRename: false }],
      }).expect(200);

      const subs = await admin.get('/api/users/alice/subscriptions');
      expect(subs.body).toEqual([sftpListenerId]);
      const vps = await admin.get('/api/users/alice/virtual-paths');
      expect(vps.body.map((v: any) => v.localPath)).toEqual([readonlyRoot]);

      const user = db.getUser('alice')!;
      expect(db.getPermission(user.id!, sftpListenerId)).toMatchObject({ canCreate: false, canList: true });
      await expect(ftpConnect('alice', 'alice-new')).rejects.toThrow();
    });

    test('deleting the user revokes all access', async () => {
      await admin.delete('/api/users/alice').expect(200);
      await admin.get('/api/users/alice').expect(404);
      await expect(sftpConnect('alice', 'alice-new')).rejects.toThrow();
    });
  });

  describe('listener lifecycle through the API', () => {
    test('stop → connection refused, start → accepting again', async () => {
      await admin.post(`/api/listeners/${sftpListenerId}/stop`).expect(200);
      await expect(sftpConnect('admin', 'Admin#2026')).rejects.toThrow();

      await admin.post(`/api/listeners/${sftpListenerId}/start`).expect(200);
      const statuses = await admin.get('/api/listener-statuses');
      expect(statuses.body.find((s: any) => s.listener.id === sftpListenerId).running).toBe(true);
    });

    test('starting an already-running listener is reported as an error', async () => {
      const res = await admin.post(`/api/listeners/${sftpListenerId}/start`).expect(400);
      expect(res.body.error).toMatch(/already running/);
    });

    test('updating the port restarts the listener on the new port', async () => {
      const newPort = await getFreePort();
      await admin.put(`/api/listeners/${ftpListenerId}`)
        .send({ name: 'E2E FTP moved', bindingIp: '127.0.0.1', port: newPort, enabled: true })
        .expect(200);
      const listener = await admin.get(`/api/listeners/${ftpListenerId}`).expect(200);
      expect(listener.body).toMatchObject({ name: 'E2E FTP moved', port: newPort });
      expect(serverManager.isListenerRunning(ftpListenerId)).toBe(true);
      ftpPort = newPort;
    });

    test('deleting a running listener stops it', async () => {
      await admin.delete(`/api/listeners/${ftpListenerId}`).expect(200);
      expect(serverManager.isListenerRunning(ftpListenerId)).toBe(false);
      await admin.get(`/api/listeners/${ftpListenerId}`).expect(404);
    });
  });

  describe('activity maintenance', () => {
    test('clearing activity by date and entirely', async () => {
      const before = (await admin.get('/api/activity/count').expect(200)).body.count;
      expect(before).toBeGreaterThan(0);

      const future = new Date(Date.now() + 60_000).toISOString();
      const res = await admin.delete('/api/activity').send({ beforeDate: future }).expect(200);
      expect(res.body.count).toBeGreaterThanOrEqual(before);

      const all = await admin.delete('/api/activity').send({}).expect(200);
      expect(all.body.success).toBe(true);
    });

    test('settings round-trip through the API', async () => {
      await admin.put('/api/settings/logRetentionDays').send({ value: '45' }).expect(200);
      const settings = await admin.get('/api/settings').expect(200);
      expect(settings.body.logRetentionDays).toBe('45');
      const stats = await admin.get('/api/activity/old-stats').query({ retentionDays: 45 }).expect(200);
      expect(stats.body).toHaveProperty('count');
    });
  });

  describe('forced password change (web)', () => {
    let fresh: ReturnType<typeof request.agent>;

    beforeAll(async () => {
      await admin.post('/api/users')
        .send({ username: 'fresh', password: 'Temp-Pass1', passwordEnabled: true, guiEnabled: true, mustChangePassword: true })
        .expect(200);
      fresh = request.agent(baseUrl);
    });

    test('user listings never include password hashes', async () => {
      const all = await admin.get('/api/users').expect(200);
      expect(all.body.every((u: any) => !('password' in u))).toBe(true);
      const one = await admin.get('/api/users/fresh').expect(200);
      expect(one.body).not.toHaveProperty('password');
      expect(one.body.mustChangePassword).toBe(true);
    });

    test('a flagged user is told to change password and locked out of the API and dashboard', async () => {
      const res = await fresh.post('/api/login').send({ username: 'fresh', password: 'Temp-Pass1' }).expect(200);
      expect(res.body).toEqual({ success: true, username: 'fresh', requirePasswordChange: true });

      const blocked = await fresh.get('/api/users').expect(403);
      expect(blocked.body.requirePasswordChange).toBe(true);
      const page = await fresh.get('/').expect(302);
      expect(page.headers.location).toBe('/login');
      await fresh.get('/api/user').expect(200);
    });

    test('weak or default new passwords are refused', async () => {
      expect((await fresh.post('/api/change-password').send({ newPassword: 'short' }).expect(400)).body.error).toMatch(/at least 8/);
      expect((await fresh.post('/api/change-password').send({ newPassword: 'admin123' }).expect(400)).body.error).toMatch(/default/);
      expect((await fresh.post('/api/change-password').send({ newPassword: 'Temp-Pass1' }).expect(400)).body.error).toMatch(/different/);
    });

    test('a valid change unlocks the session and clears the flag', async () => {
      await fresh.post('/api/change-password').send({ newPassword: 'Fresh-Pass-2026' }).expect(200);
      await fresh.get('/api/users').expect(200);
      await fresh.get('/').expect(200);
      expect(db.getUser('fresh')!.mustChangePassword).toBe(false);

      const again = await request(baseUrl).post('/api/login').send({ username: 'fresh', password: 'Fresh-Pass-2026' }).expect(200);
      expect(again.body.requirePasswordChange).toBeUndefined();
      await request(baseUrl).post('/api/login').send({ username: 'fresh', password: 'Temp-Pass1' }).expect(401);
    });

    test('a voluntary change requires the current password', async () => {
      await fresh.post('/api/change-password').send({ currentPassword: 'wrong', newPassword: 'Another-Pass-1' }).expect(401);
      await fresh.post('/api/change-password').send({ currentPassword: 'Fresh-Pass-2026', newPassword: 'Another-Pass-1' }).expect(200);
      expect(db.checkPassword('fresh', 'Another-Pass-1')).toBe(true);
    });

    test('signing in with the published default password always forces a change', async () => {
      await admin.post('/api/users').send({ username: 'lazy', password: 'admin123', passwordEnabled: true, guiEnabled: true }).expect(200);
      const res = await request(baseUrl).post('/api/login').send({ username: 'lazy', password: 'admin123' }).expect(200);
      expect(res.body.requirePasswordChange).toBe(true);
    });
  });

  describe('logout', () => {
    test('logout invalidates the session', async () => {
      await admin.post('/api/logout').expect(200);
      await admin.get('/api/users').expect(401);
    });
  });
});
