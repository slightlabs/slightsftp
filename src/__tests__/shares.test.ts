/**
 * shares.test.ts — share links created from the portal and used anonymously.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { safeFileName } from '../shares';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('share links', () => {
  let dir: string;
  let home: string;
  let db: DatabaseManager;
  let web: WebServer;
  let base: string;
  let owner: ReturnType<typeof request.agent>;
  let ownerId: number;

  const create = (body: any) => owner.post('/portal/api/shares').send(body);
  const tokenOf = (url: string) => url.split('/s/')[1];

  beforeAll(async () => {
    dir = makeTempDir('shares');
    home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'album', 'raw'), { recursive: true });
    fs.mkdirSync(path.join(home, 'inbox'));
    fs.writeFileSync(path.join(home, 'contract.pdf'), 'PDF DATA');
    fs.writeFileSync(path.join(home, 'album', 'a.jpg'), 'AAA');
    fs.writeFileSync(path.join(home, 'album', 'raw', 'a.raw'), 'RAW');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');

    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    ownerId = db.createUser({ username: 'olga', password: 'Olga-Pass-1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: ownerId, virtualPath: '/', localPath: home, ...FULL_VPATH_PERMS });
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });

    const port = await getFreePort();
    web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    owner = request.agent(base);
    await owner.post('/portal/api/login').send({ username: 'olga', password: 'Olga-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    removeDir(dir);
  });

  describe('creating links', () => {
    test('a file link returns a URL with an unguessable token and never exposes a password hash', async () => {
      const res = await create({ path: '/contract.pdf', type: 'download', expiresInDays: 7, maxDownloads: 2, password: 'open sesame' }).expect(201);
      expect(res.body.url).toMatch(new RegExp(`^${base}/s/[A-Za-z0-9_-]{32}$`));
      expect(res.body).toMatchObject({ type: 'download', virtualPath: '/contract.pdf', maxDownloads: 2, hasPassword: true, status: 'active' });
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    });

    test.each([
      [{ path: '/nope.pdf', type: 'download' }, 404],
      [{ path: '/../secret.txt', type: 'download' }, 403],
      [{ path: '/contract.pdf', type: 'upload' }, 400],
      [{ path: '/contract.pdf', type: 'download', expiresInDays: 0 }, 400],
      [{ path: '/contract.pdf', type: 'download', maxDownloads: 1.5 }, 400],
      [{ path: '/contract.pdf', type: 'download', password: 'abc' }, 400],
    ])('rejects %j with %i', async (body, status) => {
      await create(body).expect(status);
    });

    test('only signed-in portal users can create links', async () => {
      await request(base).post('/portal/api/shares').send({ path: '/contract.pdf', type: 'download' }).expect(401);
    });

    test('the QR code encodes the link', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      const qr = await owner.get(`/portal/api/shares/${share.id}/qr.svg`).expect(200);
      expect(qr.headers['content-type']).toMatch(/image\/svg\+xml/);
      expect(qr.text ?? qr.body.toString()).toContain('<svg');
    });
  });

  describe('download links', () => {
    test('anyone with the link can see the file details and download it', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      const token = tokenOf(share.url);
      const page = await request(base).get(`/s/${token}`).expect(200);
      expect(page.text).toContain('Shared securely with SLightSFTP');

      const info = await request(base).get(`/s/${token}/info`).expect(200);
      expect(info.body).toMatchObject({ type: 'download', name: 'contract.pdf', isDirectory: false, size: 8, owner: 'olga', requiresPassword: false, locked: false });

      const file = await request(base).get(`/s/${token}/download`).expect(200);
      expect(file.headers['content-disposition']).toMatch(/attachment; filename="contract\.pdf"/);
      expect(file.text ?? file.body.toString()).toBe('PDF DATA');
      expect(db.getShare(share.id)!.downloadCount).toBe(1);
    });

    test('unknown tokens are 404', async () => {
      await request(base).get('/s/not-a-real-token/info').expect(404);
    });

    test('the download limit is enforced', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download', maxDownloads: 1 }).expect(201)).body;
      const token = tokenOf(share.url);
      expect((await request(base).get(`/s/${token}/info`)).body.remainingDownloads).toBe(1);
      await request(base).get(`/s/${token}/download`).expect(200);
      const gone = await request(base).get(`/s/${token}/download`).expect(410);
      expect(gone.body.error).toMatch(/download limit/);
    });

    test('expired links stop working', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download', expiresInDays: 1 }).expect(201)).body;
      (db as any).db.run('UPDATE shares SET expiresAt = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), share.id]);
      const res = await request(base).get(`/s/${tokenOf(share.url)}/info`).expect(410);
      expect(res.body.error).toMatch(/expired/);
    });

    test('password-protected links must be unlocked first, per browser', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download', password: 'open sesame' }).expect(201)).body;
      const token = tokenOf(share.url);
      const visitor = request.agent(base);
      expect((await visitor.get(`/s/${token}/info`).expect(200)).body).toMatchObject({ requiresPassword: true, locked: true });
      await visitor.get(`/s/${token}/download`).expect(401);
      await visitor.post(`/s/${token}/unlock`).send({ password: 'wrong' }).expect(401);
      const ok = await visitor.post(`/s/${token}/unlock`).send({ password: 'open sesame' }).expect(200);
      expect(String(ok.headers['set-cookie'])).toMatch(new RegExp(`Path=/s/${token}.*HttpOnly`, 'i'));
      expect((await visitor.get(`/s/${token}/info`)).body.locked).toBe(false);
      await visitor.get(`/s/${token}/download`).expect(200);
      await request(base).get(`/s/${token}/download`).expect(401); // a different browser is still locked out
    });

    test('folder links can be browsed and files inside downloaded, but nothing outside', async () => {
      const share = (await create({ path: '/album', type: 'download' }).expect(201)).body;
      const token = tokenOf(share.url);
      const top = await request(base).get(`/s/${token}/list`).query({ path: '/' }).expect(200);
      expect(top.body.files.map((f: any) => f.name)).toEqual(['raw', 'a.jpg']);
      const sub = await request(base).get(`/s/${token}/list`).query({ path: '/raw' }).expect(200);
      expect(sub.body.files.map((f: any) => f.name)).toEqual(['a.raw']);
      const raw = await request(base).get(`/s/${token}/download`).query({ path: '/raw/a.raw' }).buffer(true).expect(200);
      expect(Buffer.from(raw.body).toString()).toBe('RAW');

      await request(base).get(`/s/${token}/download`).query({ path: '/../contract.pdf' }).expect(403);
      await request(base).get(`/s/${token}/list`).query({ path: '/../..' }).expect(403);
      await request(base).get(`/s/${token}/download`).query({ path: '/raw' }).expect(400);
      await request(base).put(`/s/${token}/upload`).query({ name: 'x.txt' }).send('x').expect(400);
    });
  });

  describe('upload ("request files") links', () => {
    let token: string;

    beforeAll(async () => {
      token = tokenOf((await create({ path: '/inbox', type: 'upload', expiresInDays: 3 }).expect(201)).body.url);
    });

    test('visitors can upload but not list or download', async () => {
      const res = await request(base).put(`/s/${token}/upload`).query({ name: 'cv.pdf' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('MY CV')).expect(201);
      expect(res.body).toEqual({ success: true, name: 'cv.pdf', size: 5 });
      expect(fs.readFileSync(path.join(home, 'inbox', 'cv.pdf'), 'utf8')).toBe('MY CV');
      await request(base).get(`/s/${token}/list`).expect(400);
      await request(base).get(`/s/${token}/download`).query({ path: '/cv.pdf' }).expect(400);
      expect((await request(base).get(`/s/${token}/info`)).body).toMatchObject({ type: 'upload', name: 'inbox' });
    });

    test('never overwrites: duplicate names get a suffix', async () => {
      await request(base).put(`/s/${token}/upload`).query({ name: 'cv.pdf' }).set('Content-Type', 'application/octet-stream').send(Buffer.from('V2')).expect(201)
        .then(r => expect(r.body.name).toBe('cv (1).pdf'));
      expect(fs.readFileSync(path.join(home, 'inbox', 'cv.pdf'), 'utf8')).toBe('MY CV');
    });

    test('file names cannot escape the folder', async () => {
      const res = await request(base).put(`/s/${token}/upload`).query({ name: '../../escape.txt' }).set('Content-Type', 'application/octet-stream').send('x').expect(201);
      expect(res.body.name).toBe('escape.txt');
      expect(fs.existsSync(path.join(home, 'inbox', 'escape.txt'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false);
      await request(base).put(`/s/${token}/upload`).query({ name: '..' }).send('x').expect(400);
    });

    test.each([['report.pdf', 'report.pdf'], ['a/b\\c.txt', 'c.txt'], ['bad\u0000name.txt', 'badname.txt'], ['', null], ['.', null], ['..', null]])(
      'safeFileName(%p) → %p', (input, expected) => {
        expect(safeFileName(input)).toBe(expected);
      });
  });

  describe('managing links', () => {
    test('owners list and revoke their links; revoked links stop working', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      const mine = await owner.get('/portal/api/shares').expect(200);
      expect(mine.body.find((s: any) => s.id === share.id)).toMatchObject({ status: 'active', url: share.url });

      await owner.delete(`/portal/api/shares/${share.id}`).expect(200);
      await request(base).get(`/s/${tokenOf(share.url)}/download`).expect(404);
      expect((await owner.get('/portal/api/shares')).body.find((s: any) => s.id === share.id).status).toBe('revoked');
    });

    test("users cannot see or revoke someone else's links", async () => {
      const otherId = db.createUser({ username: 'mallory', password: 'Mallory-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
      db.addVirtualPath({ userId: otherId, virtualPath: '/', localPath: path.join(home, 'album'), ...FULL_VPATH_PERMS });
      const mallory = request.agent(base);
      await mallory.post('/portal/api/login').send({ username: 'mallory', password: 'Mallory-Pass1' }).expect(200);
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      expect((await mallory.get('/portal/api/shares').expect(200)).body).toEqual([]);
      await mallory.delete(`/portal/api/shares/${share.id}`).expect(404);
      await mallory.get(`/portal/api/shares/${share.id}/qr.svg`).expect(404);
    });

    test('admins see every link and can revoke any of them', async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      const admin = request.agent(base);
      await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
      const all = await admin.get('/api/shares').expect(200);
      expect(all.body.some((s: any) => s.id === share.id && s.owner === 'olga')).toBe(true);
      expect(all.body.every((s: any) => !('passwordHash' in s))).toBe(true);
      await admin.delete(`/api/shares/${share.id}`).expect(200);
      await request(base).get(`/s/${tokenOf(share.url)}/info`).expect(404);
    });

    test("removing the owner's access disables their links", async () => {
      const share = (await create({ path: '/contract.pdf', type: 'download' }).expect(201)).body;
      const token = tokenOf(share.url);
      await request(base).get(`/s/${token}/info`).expect(200);
      const vp = db.getVirtualPaths(ownerId)[0];
      (db as any).db.run('UPDATE virtual_paths SET canRead = 0 WHERE id = ?', [vp.id]);
      await request(base).get(`/s/${token}/download`).expect(404);
      (db as any).db.run('UPDATE virtual_paths SET canRead = 1 WHERE id = ?', [vp.id]);
    });

    test('share activity is logged under the owner', () => {
      const actions = db.getRecentActivities(undefined, 500).filter(a => a.username === 'olga').map(a => a.action);
      expect(actions).toEqual(expect.arrayContaining(['SHARE_CREATED', 'SHARE_CREATED_UPLOAD', 'SHARE_DOWNLOAD', 'SHARE_UPLOAD', 'SHARE_REVOKED', 'SHARE_UNLOCK_FAILED']));
    });
  });
});
