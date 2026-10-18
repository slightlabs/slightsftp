/**
 * portal.test.ts — the end-user browser file portal (/files, /portal/api/*)
 * against a real WebServer and real files.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('browser file portal', () => {
  let dir: string;
  let home: string;
  let reports: string;
  let db: DatabaseManager;
  let web: WebServer;
  let base: string;
  let pat: ReturnType<typeof request.agent>;

  const login = async (username: string, password: string) => {
    const agent = request.agent(base);
    const res = await agent.post('/portal/api/login').send({ username, password });
    return { agent, res };
  };

  beforeAll(async () => {
    dir = makeTempDir('portal');
    home = path.join(dir, 'home');
    reports = path.join(dir, 'reports');
    fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
    fs.mkdirSync(reports);
    fs.writeFileSync(path.join(home, 'readme.txt'), 'hello portal');
    fs.writeFileSync(path.join(reports, 'q3.csv'), 'a,b');
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret');

    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const patId = db.createUser({ username: 'pat', password: 'Portal-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: patId, virtualPath: '/', localPath: home, ...FULL_VPATH_PERMS });
    db.addVirtualPath({ userId: patId, virtualPath: '/reports', localPath: reports, canRead: true, canList: true, canWrite: false, canDelete: false, canCreateDir: false, canRename: false });

    const viewerId = db.createUser({ username: 'viewer', password: 'Viewer-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: viewerId, virtualPath: '/inbox', localPath: home, canRead: true, canList: true, canWrite: false });
    db.addVirtualPath({ userId: viewerId, virtualPath: '/archive/2026', localPath: reports, canRead: true, canList: true, canWrite: false });

    db.createUser({ username: 'sftponly', password: 'Sftp-Only-1', passwordEnabled: true, guiEnabled: true, portalEnabled: false });
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });

    const port = await getFreePort();
    web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    ({ agent: pat } = await login('pat', 'Portal-Pass1'));
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    removeDir(dir);
  });

  describe('sign-in', () => {
    test('/files serves the portal page', async () => {
      const res = await request(base).get('/files').expect(200);
      expect(res.text).toContain('SLightSFTP Files');
      expect(res.headers['content-type']).toMatch(/html/);
    });

    test('portal access must be enabled per user', async () => {
      expect((await login('sftponly', 'Sftp-Only-1')).res.status).toBe(401);
      expect((await login('pat', 'wrong')).res.status).toBe(401);
      const ok = (await login('pat', 'Portal-Pass1')).res;
      expect(ok.status).toBe(200);
      expect(String(ok.headers['set-cookie'])).toMatch(/portalSession=.*HttpOnly.*SameSite=Lax/i);
    });

    test('portal and admin sessions are completely separate', async () => {
      await pat.get('/api/users').expect(401);
      const adminAgent = request.agent(base);
      await adminAgent.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
      await adminAgent.get('/portal/api/me').expect(401);
    });

    test('me lists the user and their mapped roots', async () => {
      const me = await pat.get('/portal/api/me').expect(200);
      expect(me.body).toEqual({ username: 'pat', requirePasswordChange: false, totpEnabled: false, roots: ['/', '/reports'] });
    });

    test('everything requires a session', async () => {
      await request(base).get('/portal/api/list').expect(401);
      await request(base).put('/portal/api/upload?path=/x.txt').send('x').expect(401);
    });
  });

  describe('browsing and downloading', () => {
    test('lists folders first, with sizes and the permissions of the folder', async () => {
      const res = await pat.get('/portal/api/list').query({ path: '/' }).expect(200);
      expect(res.body.files.map((f: any) => [f.name, f.type])).toEqual([['docs', 'directory'], ['readme.txt', 'file']]);
      expect(res.body.files[1].size).toBe('hello portal'.length);
      expect(res.body.permissions).toEqual({ canRead: true, canWrite: true, canDelete: true, canList: true, canCreateDir: true, canRename: true });
    });

    test('a nested mapping has its own (read-only) permissions', async () => {
      const res = await pat.get('/portal/api/list').query({ path: '/reports' }).expect(200);
      expect(res.body.files.map((f: any) => f.name)).toEqual(['q3.csv']);
      expect(res.body.permissions).toMatchObject({ canRead: true, canWrite: false, canDelete: false });
    });

    test('users without a "/" mapping see their mapped folders at the top', async () => {
      const { agent } = await login('viewer', 'Viewer-Pass1');
      const top = await agent.get('/portal/api/list').query({ path: '/' }).expect(200);
      expect(top.body.files.map((f: any) => f.name).sort()).toEqual(['archive', 'inbox']);
      expect(top.body.permissions.canWrite).toBe(false);
      const archive = await agent.get('/portal/api/list').query({ path: '/archive/2026' }).expect(200);
      expect(archive.body.files.map((f: any) => f.name)).toEqual(['q3.csv']);
    });

    test('downloads files as attachments', async () => {
      const res = await pat.get('/portal/api/download').query({ path: '/readme.txt' }).expect(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="readme\.txt"/);
      expect(res.text).toBe('hello portal');
      await pat.get('/portal/api/download').query({ path: '/docs' }).expect(400);
      await pat.get('/portal/api/download').query({ path: '/nope.txt' }).expect(404);
    });

    test.each(['/../outside.txt', '/docs/../../outside.txt', '..\\outside.txt'])('refuses traversal: %s', async p => {
      const res = await pat.get('/portal/api/download').query({ path: p });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('secret');
    });
  });

  describe('changing files', () => {
    test('uploads a file (streamed, atomically) and overwrites on re-upload', async () => {
      const big = Buffer.alloc(3 * 1024 * 1024, 7);
      const res = await pat.put('/portal/api/upload').query({ path: '/docs/big.bin' }).set('Content-Type', 'application/octet-stream').send(big).expect(201);
      expect(res.body).toEqual({ success: true, path: '/docs/big.bin', size: big.length });
      expect(fs.readFileSync(path.join(home, 'docs', 'big.bin')).equals(big)).toBe(true);

      await pat.put('/portal/api/upload').query({ path: '/docs/big.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('small')).expect(201);
      expect(fs.readFileSync(path.join(home, 'docs', 'big.bin'), 'utf8')).toBe('small');
      expect(fs.readdirSync(path.join(home, 'docs')).filter(n => n.endsWith('.part'))).toEqual([]);
    });

    test('refuses uploads without write permission, outside the root, or into missing folders', async () => {
      await pat.put('/portal/api/upload').query({ path: '/reports/new.csv' }).set('Content-Type', 'application/octet-stream').send('x').expect(403);
      await pat.put('/portal/api/upload').query({ path: '/../escape.txt' }).set('Content-Type', 'application/octet-stream').send('x').expect(403);
      await pat.put('/portal/api/upload').query({ path: '/missing/a.txt' }).set('Content-Type', 'application/octet-stream').send('x').expect(404);
      await pat.put('/portal/api/upload').query({ path: '/docs' }).set('Content-Type', 'application/octet-stream').send('x').expect(409);
      expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false);
      expect(fs.readdirSync(reports)).toEqual(['q3.csv']);
    });

    test('creates folders, renames and deletes', async () => {
      await pat.post('/portal/api/mkdir').send({ path: '/projects' }).expect(201);
      await pat.post('/portal/api/mkdir').send({ path: '/projects' }).expect(409);
      expect(fs.statSync(path.join(home, 'projects')).isDirectory()).toBe(true);

      await pat.post('/portal/api/rename').send({ from: '/docs/big.bin', to: '/projects/small.bin' }).expect(200);
      expect(fs.existsSync(path.join(home, 'projects', 'small.bin'))).toBe(true);
      await pat.post('/portal/api/rename').send({ from: '/readme.txt', to: '/projects/small.bin' }).expect(409);

      await pat.delete('/portal/api/file').query({ path: '/projects' }).expect(409); // not empty
      await pat.delete('/portal/api/file').query({ path: '/projects/small.bin' }).expect(200);
      await pat.delete('/portal/api/file').query({ path: '/projects' }).expect(200);
      expect(fs.existsSync(path.join(home, 'projects'))).toBe(false);
    });

    test('read-only mappings refuse mkdir, rename and delete; mapped roots cannot be deleted', async () => {
      await pat.post('/portal/api/mkdir').send({ path: '/reports/sub' }).expect(403);
      await pat.post('/portal/api/rename').send({ from: '/reports/q3.csv', to: '/reports/q4.csv' }).expect(403);
      await pat.delete('/portal/api/file').query({ path: '/reports/q3.csv' }).expect(403);
      await pat.delete('/portal/api/file').query({ path: '/' }).expect(403);
      expect(fs.existsSync(path.join(reports, 'q3.csv'))).toBe(true);
    });

    test('portal actions appear in the activity log', () => {
      const actions = db.getRecentActivities(undefined, 200).filter(a => a.username === 'pat').map(a => a.action);
      expect(actions).toEqual(expect.arrayContaining(['PORTAL_LOGIN', 'PORTAL_UPLOAD', 'PORTAL_DOWNLOAD', 'PORTAL_MKDIR', 'PORTAL_RENAME', 'PORTAL_DELETE']));
    });
  });

  describe('account changes', () => {
    test('forced password change is enforced in the portal too', async () => {
      const id = db.createUser({ username: 'newbie', password: 'Temp-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true, mustChangePassword: true });
      db.addVirtualPath({ userId: id, virtualPath: '/', localPath: home, ...FULL_VPATH_PERMS });
      const { agent, res } = await login('newbie', 'Temp-Pass1');
      expect(res.body.requirePasswordChange).toBe(true);
      await agent.get('/portal/api/list').expect(403);
      await agent.post('/portal/api/change-password').send({ newPassword: 'short' }).expect(400);
      await agent.post('/portal/api/change-password').send({ newPassword: 'Newbie-Pass-2' }).expect(200);
      await agent.get('/portal/api/list').expect(200);
      expect(db.getUser('newbie')!.mustChangePassword).toBe(false);
    });

    test('disabling the portal for a user ends their open session', async () => {
      const { agent } = await login('viewer', 'Viewer-Pass1');
      await agent.get('/portal/api/me').expect(200);
      db.updateUser('viewer', { portalEnabled: false });
      await agent.get('/portal/api/me').expect(401);
    });

    test('sign out ends the session', async () => {
      await pat.post('/portal/api/logout').expect(200);
      await pat.get('/portal/api/me').expect(401);
    });
  });
});
