/**
 * recycle-bin.test.ts — deleted files go to a restorable recycle bin.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { deleteFile, purgeExpired, purgeItem, recycleSettings, restoreItem, saveRecycleSettings } from '../recycle-bin';
import { getQuotaManager } from '../quota';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('recycle bin', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;

  beforeAll(async () => {
    dir = makeTempDir('trash');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.setSetting('recycleBinDir', path.join(dir, 'bin'));
  });

  afterAll(() => { db.close(); removeDir(dir); });

  test('is on by default with 30 days retention; settings are validated', () => {
    expect(recycleSettings(db)).toEqual({ enabled: true, retentionDays: 30 });
    expect(() => saveRecycleSettings(db, { retentionDays: 0 })).toThrow();
  });

  test('deleting moves the file to the bin; restoring puts it back', () => {
    const file = path.join(root, 'report.pdf');
    fs.writeFileSync(file, 'v1');
    expect(deleteFile(db, 'ann', '/report.pdf', file)).toBe('trashed');
    expect(fs.existsSync(file)).toBe(false);
    const [item] = db.listTrashItems('ann');
    expect(item).toMatchObject({ username: 'ann', virtualPath: '/report.pdf', size: 2, originalPath: file });
    expect(item.trashPath.startsWith(path.join(dir, 'bin'))).toBe(true);

    expect(restoreItem(db, item)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
    expect(db.listTrashItems()).toEqual([]);
  });

  test('restoring next to a newer file of the same name does not overwrite it', () => {
    const file = path.join(root, 'notes.txt');
    fs.writeFileSync(file, 'old');
    deleteFile(db, 'ann', '/notes.txt', file);
    fs.writeFileSync(file, 'new');
    const restored = restoreItem(db, db.listTrashItems()[0]);
    expect(restored).toBe(path.join(root, 'notes (restored).txt'));
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readFileSync(restored, 'utf8')).toBe('old');
  });

  test('restoring into a folder that was removed recreates it', () => {
    fs.mkdirSync(path.join(root, 'sub'));
    const file = path.join(root, 'sub', 'a.txt');
    fs.writeFileSync(file, 'a');
    deleteFile(db, 'ann', '/sub/a.txt', file);
    fs.rmdirSync(path.join(root, 'sub'));
    restoreItem(db, db.listTrashItems()[0]);
    expect(fs.readFileSync(file, 'utf8')).toBe('a');
  });

  test('purge and expiry', () => {
    for (const n of ['x', 'y']) {
      fs.writeFileSync(path.join(root, n), n);
      deleteFile(db, 'ann', `/${n}`, path.join(root, n));
    }
    const [y, x] = db.listTrashItems();
    purgeItem(db, y);
    expect(fs.existsSync(y.trashPath)).toBe(false);
    expect(purgeExpired(db, Date.now() + 29 * 86_400_000)).toBe(0);
    expect(purgeExpired(db, Date.now() + 31 * 86_400_000)).toBe(1);
    expect(fs.existsSync(x.trashPath)).toBe(false);
    expect(db.listTrashItems()).toEqual([]);
  });

  test('when disabled, files are deleted permanently', () => {
    saveRecycleSettings(db, { enabled: false });
    const file = path.join(root, 'gone.txt');
    fs.writeFileSync(file, 'g');
    expect(deleteFile(db, 'ann', '/gone.txt', file)).toBe('deleted');
    expect(fs.existsSync(file)).toBe(false);
    expect(db.listTrashItems()).toEqual([]);
    saveRecycleSettings(db, { enabled: true });
  });

  test('a missing file is still an error', () => {
    expect(() => deleteFile(db, 'ann', '/nope', path.join(root, 'nope'))).toThrow();
  });
});

describe('deletes over every protocol land in the recycle bin', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let portal: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let ftpPort: number;

  beforeAll(async () => {
    dir = makeTempDir('trash-e2e');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.setSetting('recycleBinDir', path.join(dir, 'bin'));
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const id = db.createUser({ username: 'del', password: 'Delete-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true, quotaBytes: 50_000 });
    db.addVirtualPath({ userId: id, virtualPath: '/', localPath: root, ...FULL_VPATH_PERMS });
    const other = db.createUser({ username: 'other', password: 'Other-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: other, virtualPath: '/', localPath: path.join(dir, 'other-root'), ...FULL_VPATH_PERMS });
    fs.mkdirSync(path.join(dir, 'other-root'));
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
    portal = request.agent(base);
    await portal.post('/portal/api/login').send({ username: 'del', password: 'Delete-Pass1' }).expect(200);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  test('SFTP, FTP and portal deletes are restorable', async () => {
    for (const n of ['s.txt', 'f.txt', 'p.txt']) fs.writeFileSync(path.join(root, n), n);

    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'del', password: 'Delete-Pass1', readyTimeout: 5000 });
    await c.delete('/s.txt');
    await c.end();

    const f = new ftp.Client(5000);
    await f.access({ host: '127.0.0.1', port: ftpPort, user: 'del', password: 'Delete-Pass1' });
    await f.remove('f.txt');
    f.close();

    await portal.delete('/portal/api/file').query({ path: '/p.txt' }).expect(200);

    expect(fs.readdirSync(root)).toEqual([]);
    const mine = (await portal.get('/portal/api/trash').expect(200)).body;
    expect(mine.map((i: any) => i.virtualPath).sort()).toEqual(['/f.txt', '/p.txt', '/s.txt']);
    expect(mine[0]).not.toHaveProperty('trashPath');
    expect(db.getRecentActivities(undefined, 50).some(a => a.action === 'REMOVE (to recycle bin)')).toBe(true);

    const s = mine.find((i: any) => i.virtualPath === '/s.txt');
    await portal.post(`/portal/api/trash/${s.id}/restore`).expect(200);
    expect(fs.readFileSync(path.join(root, 's.txt'), 'utf8')).toBe('s.txt');
  });

  test('users cannot see or restore someone else\'s deleted files', async () => {
    const otherAgent = request.agent(base);
    await otherAgent.post('/portal/api/login').send({ username: 'other', password: 'Other-Pass1' }).expect(200);
    expect((await otherAgent.get('/portal/api/trash')).body).toEqual([]);
    const [item] = db.listTrashItems('del');
    await otherAgent.post(`/portal/api/trash/${item.id}/restore`).expect(404);
    await otherAgent.delete(`/portal/api/trash/${item.id}`).expect(404);
  });

  test('deleted files no longer count against the quota', async () => {
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(40_000));
    getQuotaManager(db).invalidate();
    await portal.put('/portal/api/upload').query({ path: '/more.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(20_000)).expect(413);
    await portal.delete('/portal/api/file').query({ path: '/big.bin' }).expect(200);
    await portal.put('/portal/api/upload').query({ path: '/more.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(20_000)).expect(201);
  });

  test('admin API: list, restore, purge, empty, settings', async () => {
    const list = await admin.get('/api/trash').expect(200);
    expect(list.body.settings).toEqual({ enabled: true, retentionDays: 30 });
    expect(list.body.items.length).toBeGreaterThanOrEqual(3);
    expect(list.body.items[0]).not.toHaveProperty('trashPath');

    const f = list.body.items.find((i: any) => i.virtualPath === '/f.txt');
    await admin.post(`/api/trash/${f.id}/restore`).expect(200);
    expect(fs.existsSync(path.join(root, 'f.txt'))).toBe(true);
    await admin.post(`/api/trash/${f.id}/restore`).expect(404);

    const p = (await admin.get('/api/trash')).body.items.find((i: any) => i.virtualPath === '/p.txt');
    await admin.delete(`/api/trash/${p.id}`).expect(200);

    await admin.put('/api/trash/settings').send({ retentionDays: 9999 }).expect(400);
    expect((await admin.put('/api/trash/settings').send({ retentionDays: 7 }).expect(200)).body.retentionDays).toBe(7);

    const emptied = await admin.delete('/api/trash').expect(200);
    expect(emptied.body.count).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await admin.get('/api/trash')).body.items.length === 0);
    expect(fs.readdirSync(path.join(dir, 'bin'))).toEqual([]);
  });
});
