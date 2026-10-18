/**
 * cloud-web.test.ts — cloud storage through the web server: the admin REST
 * API for connections, the /files portal, share links and the admin file
 * browser, all working in an S3 bucket (in-memory fake).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import request from 'supertest';
import { Readable } from 'stream';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { cloudPath, getBackend, readAll } from '../cloud-storage';
import { FakeS3, fakeS3Config, startFakeS3 } from './helpers/fake-s3';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('cloud storage in the web server', () => {
  let dir: string;
  let s3: FakeS3;
  let db: DatabaseManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let portal: ReturnType<typeof request.agent>;
  let connId: number;
  let activity: any[] = [];

  const object = (key: string) => s3.objects.get(key)?.body.toString();

  beforeAll(async () => {
    dir = makeTempDir('cloud-web');
    s3 = await startFakeS3();
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    db.createUser({ username: 'pia', password: 'Pia-Pass-1234', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    const manager = new ServerManager(db);
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    const original = db.logActivity.bind(db);
    jest.spyOn(db, 'logActivity').mockImplementation((a: any) => { activity.push(a); return original(a); });
    await web.start();
    base = `http://127.0.0.1:${port}`;
    admin = request.agent(base);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    await s3.close();
    removeDir(dir);
  });

  describe('admin API', () => {
    test('requires an admin session', async () => {
      await request(base).get('/api/storage').expect(401);
      await request(base).post('/api/storage').send({}).expect(401);
    });

    test('create: validated, stored, secrets never returned', async () => {
      await admin.post('/api/storage').send({ name: 'x', type: 's3', config: { bucket: 'bbb' } }).expect(400);
      const res = await admin.post('/api/storage').send({ name: 'Team bucket', type: 's3', config: fakeS3Config(s3) }).expect(201);
      connId = res.body.id;
      expect(res.body).toMatchObject({ name: 'Team bucket', type: 's3', url: `cloud://${connId}`, config: { bucket: s3.bucket, hasSecretAccessKey: true } });
      expect(JSON.stringify(res.body)).not.toContain('test-secret');
      const list = await admin.get('/api/storage').expect(200);
      expect(list.body).toEqual([expect.objectContaining({ id: connId, usedBy: [] })]);
      expect(JSON.stringify(list.body)).not.toContain('test-secret');
    });

    test('test connection: saved connection, unsaved form values, bad credentials', async () => {
      expect((await admin.post('/api/storage/test').send({ id: connId }).expect(200)).body.ok).toBe(true);
      // the form leaves the secret empty: the saved one is used
      const form = { name: 'Team bucket', type: 's3', config: { ...fakeS3Config(s3), secretAccessKey: '' } };
      expect((await admin.post('/api/storage/test').send({ id: connId, ...form })).body.ok).toBe(true);
      const wrong = await admin.post('/api/storage/test').send({ name: 'x', type: 's3', config: { ...fakeS3Config(s3), bucket: 'nope-bucket' } });
      expect(wrong.body.ok).toBe(false);
      const invalid = await admin.post('/api/storage/test').send({ name: 'x', type: 's3', config: {} });
      expect(invalid.body).toEqual({ ok: false, message: expect.stringMatching(/bucket/) });
    });

    test('update keeps the secret when it is left empty', async () => {
      await admin.put(`/api/storage/${connId}`).send({ name: 'Renamed', config: { secretAccessKey: '' } }).expect(200);
      expect(db.getStorageConnection(connId)).toMatchObject({ name: 'Renamed', config: { secretAccessKey: 'test-secret', bucket: s3.bucket } });
      await admin.put('/api/storage/9999').send({ name: 'x' }).expect(404);
    });

    test('virtual paths must point at an existing connection; in-use connections cannot be deleted', async () => {
      await admin.post('/api/users/pia/virtual-paths').send({ virtualPath: '/bad', localPath: 'cloud://9999/x', ...FULL_VPATH_PERMS }).expect(400);
      await admin.post('/api/users/pia/virtual-paths').send({ virtualPath: '/bad', localPath: `cloud://${connId}/../x`, ...FULL_VPATH_PERMS }).expect(400);
      await admin.post('/api/users/pia/virtual-paths').send({ virtualPath: '/', localPath: cloudPath(connId, 'home/pia'), ...FULL_VPATH_PERMS }).expect(200);
      await admin.post('/api/users/pia/virtual-paths').send({ virtualPath: '/inbox', localPath: cloudPath(connId, 'inbox'), ...FULL_VPATH_PERMS, canDelete: false }).expect(200);
      const del = await admin.delete(`/api/storage/${connId}`).expect(409);
      expect(del.body.error).toMatch(/pia → \//);
      expect((await admin.get('/api/storage')).body[0].usedBy).toEqual(['pia → /', 'pia → /inbox']);
    });

    test('a connection nobody uses can be deleted', async () => {
      const extra = (await admin.post('/api/storage').send({ name: 'Spare', type: 'azure', config: { container: 'spare', accountName: 'acct', accountKey: 'a2V5' } }).expect(201)).body;
      await admin.delete(`/api/storage/${extra.id}`).expect(200);
      await admin.delete(`/api/storage/${extra.id}`).expect(404);
    });
  });

  describe('portal', () => {
    beforeAll(async () => {
      portal = request.agent(base);
      await portal.post('/portal/api/login').send({ username: 'pia', password: 'Pia-Pass-1234' }).expect(200);
    });

    test('an empty bucket folder lists as empty', async () => {
      const res = await portal.get('/portal/api/list').query({ path: '/' }).expect(200);
      expect(res.body.files).toEqual([{ name: 'inbox', type: 'directory', size: 0, modified: null }].filter(() => false));
    });

    test('upload, list, download, overwrite', async () => {
      await portal.put('/portal/api/upload').query({ path: '/report.txt' }).send(Buffer.from('quarterly numbers')).expect(201);
      expect(object('home/pia/report.txt')).toBe('quarterly numbers');
      const list = await portal.get('/portal/api/list').query({ path: '/' }).expect(200);
      expect(list.body.files).toEqual([expect.objectContaining({ name: 'report.txt', type: 'file', size: 17 })]);
      const dl = await portal.get('/portal/api/download').query({ path: '/report.txt' }).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(dl.body.toString()).toBe('quarterly numbers');
      expect(dl.headers['content-disposition']).toMatch(/report\.txt/);
      await portal.put('/portal/api/upload').query({ path: '/report.txt' }).send(Buffer.from('v2')).expect(201);
      expect(object('home/pia/report.txt')).toBe('v2');
      const sum = crypto.createHash('sha256').update('v2').digest('hex');
      expect(activity.some(a => a.action === 'PORTAL_UPLOAD' && a.checksum === sum && a.bytes === 2)).toBe(true);
    });

    test('folders: mkdir, upload inside, rename, delete rules', async () => {
      await portal.post('/portal/api/mkdir').send({ path: '/projects' }).expect(201);
      await portal.post('/portal/api/mkdir').send({ path: '/projects' }).expect(409);
      await portal.post('/portal/api/mkdir').send({ path: '/missing/sub' }).expect(404);
      await portal.put('/portal/api/upload').query({ path: '/projects/plan.md' }).send(Buffer.from('# plan')).expect(201);
      await portal.put('/portal/api/upload').query({ path: '/nowhere/plan.md' }).send(Buffer.from('x')).expect(404);
      await portal.put('/portal/api/upload').query({ path: '/projects' }).send(Buffer.from('x')).expect(409);
      await portal.post('/portal/api/rename').send({ from: '/projects', to: '/archive' }).expect(200);
      expect(object('home/pia/archive/plan.md')).toBe('# plan');
      await portal.post('/portal/api/rename').send({ from: '/archive/plan.md', to: '/report.txt' }).expect(409);
      await portal.delete('/portal/api/file').query({ path: '/archive' }).expect(409); // not empty
      await portal.delete('/portal/api/file').query({ path: '/archive/plan.md' }).expect(200);
      await portal.delete('/portal/api/file').query({ path: '/archive' }).expect(200);
      await portal.delete('/portal/api/file').query({ path: '/archive' }).expect(404);
      await portal.get('/portal/api/list').query({ path: '/report.txt' }).expect(400);
      await portal.get('/portal/api/download').query({ path: '/nope.txt' }).expect(404);
    });

    test('permissions and root protection still apply', async () => {
      await portal.put('/portal/api/upload').query({ path: '/inbox/a.txt' }).send(Buffer.from('a')).expect(201);
      await portal.delete('/portal/api/file').query({ path: '/inbox/a.txt' }).expect(403);
      await portal.delete('/portal/api/file').query({ path: '/inbox' }).expect(403);
      expect(object('inbox/a.txt')).toBe('a');
    });

    test('quota: an upload that would exceed it is refused and nothing is stored', async () => {
      db.updateUser('pia', { quotaBytes: 1024 } as any);
      const { getQuotaManager } = await import('../quota');
      getQuotaManager(db).invalidate('pia');
      try {
        await portal.put('/portal/api/upload').query({ path: '/huge.bin' }).send(crypto.randomBytes(4096)).expect(413);
      } finally {
        db.updateUser('pia', { quotaBytes: null } as any);
        getQuotaManager(db).invalidate('pia');
      }
      expect(s3.objects.has('home/pia/huge.bin')).toBe(false);
    });

    test('moving between the bucket and another storage location is refused', async () => {
      const local = path.join(dir, 'local');
      fs.mkdirSync(local);
      await admin.post('/api/users/pia/virtual-paths').send({ virtualPath: '/local', localPath: local, ...FULL_VPATH_PERMS }).expect(200);
      const res = await portal.post('/portal/api/rename').send({ from: '/report.txt', to: '/local/report.txt' }).expect(400);
      expect(res.body.error).toMatch(/different storage/);
    });
  });

  describe('share links', () => {
    test('a download link to a cloud folder lists and downloads', async () => {
      await getBackend(db, connId).write('home/pia/shared/one.txt', Readable.from([Buffer.from('one')]));
      const share = (await portal.post('/portal/api/shares').send({ path: '/shared', type: 'download' }).expect(201)).body;
      const token = share.url.split('/s/')[1];
      const info = await request(base).get(`/s/${token}/info`).expect(200);
      expect(info.body).toMatchObject({ isDirectory: true, name: 'shared' });
      const list = await request(base).get(`/s/${token}/list`).expect(200);
      expect(list.body.files).toEqual([expect.objectContaining({ name: 'one.txt', size: 3 })]);
      const dl = await request(base).get(`/s/${token}/download`).query({ path: '/one.txt' }).expect(200);
      expect(dl.text).toBe('one');
      await request(base).get(`/s/${token}/download`).query({ path: '/../report.txt' }).expect(403);
    });

    test('a link to a single cloud file', async () => {
      const share = (await portal.post('/portal/api/shares').send({ path: '/report.txt', type: 'download' }).expect(201)).body;
      const token = share.url.split('/s/')[1];
      expect((await request(base).get(`/s/${token}/info`)).body).toMatchObject({ isDirectory: false, size: 2, name: 'report.txt' });
      expect((await request(base).get(`/s/${token}/download`).expect(200)).text).toBe('v2');
      await portal.post('/portal/api/shares').send({ path: '/missing.txt', type: 'download' }).expect(404);
    });

    test('a drop-box link uploads into the bucket without overwriting', async () => {
      const share = (await portal.post('/portal/api/shares').send({ path: '/inbox', type: 'upload' }).expect(201)).body;
      const token = share.url.split('/s/')[1];
      await request(base).put(`/s/${token}/upload`).query({ name: 'scan.pdf' }).send(Buffer.from('pdf 1')).expect(201);
      const second = await request(base).put(`/s/${token}/upload`).query({ name: 'scan.pdf' }).send(Buffer.from('pdf 2')).expect(201);
      expect(second.body.name).toBe('scan (1).pdf');
      expect(object('inbox/scan.pdf')).toBe('pdf 1');
      expect(object('inbox/scan (1).pdf')).toBe('pdf 2');
    });
  });

  describe('admin file browser', () => {
    test('browses and downloads a user\'s cloud files', async () => {
      const res = await admin.get('/api/files/browse').query({ username: 'pia', path: '/' }).expect(200);
      expect(res.body.files.map((f: any) => f.name).sort()).toEqual(['report.txt', 'shared']);
      await admin.get('/api/files/browse').query({ username: 'pia', path: '/nope' }).expect(404);
      const dl = await admin.get('/api/files/download').query({ username: 'pia', path: '/report.txt' }).expect(200);
      expect(dl.text).toBe('v2');
      await admin.get('/api/files/download').query({ username: 'pia', path: '/shared' }).expect(400);
    });
  });

  test('a cloud file can be read back exactly as uploaded through the portal (binary)', async () => {
    const data = crypto.randomBytes(256 * 1024);
    await portal.put('/portal/api/upload').query({ path: '/bin.dat' }).send(data).expect(201);
    expect((await readAll(await getBackend(db, connId).read('home/pia/bin.dat'))).equals(data)).toBe(true);
  });
});
