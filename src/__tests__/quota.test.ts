/**
 * quota.test.ts — per-user storage quotas across SFTP, FTP, the portal and
 * share links.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { QuotaManager, getQuotaManager, quotaFromMegabytes } from '../quota';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);
const KB = 1024;

describe('usage measurement', () => {
  let dir: string;
  let db: DatabaseManager;

  beforeAll(async () => {
    dir = makeTempDir('quota-unit');
    fs.mkdirSync(path.join(dir, 'a', 'nested', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a', 'one.bin'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dir, 'a', 'nested', 'deep', 'two.bin'), Buffer.alloc(2000));
    fs.writeFileSync(path.join(dir, 'b', 'three.bin'), Buffer.alloc(300));
    fs.writeFileSync(path.join(dir, 'outside.bin'), Buffer.alloc(99999));
    if (process.platform !== 'win32') fs.symlinkSync(path.join(dir, 'outside.bin'), path.join(dir, 'a', 'link.bin'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
  });

  afterAll(() => { db.close(); removeDir(dir); });

  test('sums every folder once (nested mappings are not double counted) and ignores symlinks', async () => {
    const id = db.createUser({ username: 'u', passwordEnabled: true, guiEnabled: false, quotaBytes: 10_000 });
    db.addVirtualPath({ userId: id, virtualPath: '/', localPath: path.join(dir, 'a') });
    db.addVirtualPath({ userId: id, virtualPath: '/deep', localPath: path.join(dir, 'a', 'nested', 'deep') });
    db.addVirtualPath({ userId: id, virtualPath: '/b', localPath: path.join(dir, 'b') });
    const usage = await new QuotaManager(db).usage(db.getUser('u')!);
    expect(usage).toEqual({ usedBytes: 3300, quotaBytes: 10_000 });
  });

  test('adjust / invalidate / wouldExceed', async () => {
    const m = new QuotaManager(db);
    const u = db.getUser('u')!;
    await m.usage(u);
    expect(m.wouldExceed(u, 6700)).toBe(false);
    expect(m.wouldExceed(u, 6701)).toBe(true);
    m.adjust('u', 5000);
    expect(m.wouldExceed(u, 1701)).toBe(true);
    m.invalidate('u');
    expect((await m.usage(u)).usedBytes).toBe(3300);
    await expect(m.assertRoom(u, 6700)).resolves.toBeUndefined();
    await expect(m.assertRoom(u, 6701)).rejects.toThrow(/quota exceeded/);
  });

  test.each([['', null], [undefined, null], ['1', 1048576], [0.5, 524288]])('quotaFromMegabytes(%p) → %p', (input, bytes) => {
    expect(quotaFromMegabytes(input)).toBe(bytes);
  });

  test('rejects nonsense quotas', () => {
    expect(() => quotaFromMegabytes('-1')).toThrow();
    expect(() => quotaFromMegabytes('lots')).toThrow();
  });
});

describe('quotas are enforced on every upload path', () => {
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

  const sftp = async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'quinn', password: 'Quinn-Pass1', readyTimeout: 5000 });
    return c;
  };
  const reset = () => {
    for (const f of fs.readdirSync(root)) fs.rmSync(path.join(root, f), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'inbox'));
    getQuotaManager(db).invalidate();
  };

  beforeAll(async () => {
    dir = makeTempDir('quota');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const id = db.createUser({ username: 'quinn', password: 'Quinn-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true, quotaBytes: 100 * KB });
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
    portal = request.agent(base);
    await portal.post('/portal/api/login').send({ username: 'quinn', password: 'Quinn-Pass1' }).expect(200);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  beforeEach(reset);

  test('SFTP: writes beyond the quota fail with a clear status; overwrites and deletes free space', async () => {
    const c = await sftp();
    // raw SFTP calls: ssh2-sftp-client's put() does not surface WRITE failures
    const call = (fn: string, ...args: any[]) => new Promise<any>((resolve, reject) => c.sftp[fn](...args, (err: any, v: any) => (err ? reject(err) : resolve(v))));
    const writeFile = async (name: string, size: number) => {
      const h = await call('open', name, 'w');
      try {
        for (let off = 0; off < size; off += 16 * KB) {
          await call('write', h, Buffer.alloc(16 * KB, 7), 0, Math.min(16 * KB, size - off), off);
        }
      } finally {
        await call('close', h);
      }
    };
    try {
      await writeFile('/a.bin', 64 * KB);
      await expect(writeFile('/b.bin', 64 * KB)).rejects.toThrow('Storage quota exceeded');
      expect(fs.statSync(path.join(root, 'b.bin')).size).toBeLessThanOrEqual(36 * KB);

      await c.delete('/b.bin');
      await writeFile('/a.bin', 64 * KB); // overwriting reuses the same space
      await c.delete('/a.bin');
      await writeFile('/c.bin', 96 * KB);
    } finally {
      await c.end();
    }
    expect(db.getRecentActivities(undefined, 100).some(a => a.action === 'WRITE_DENIED (quota exceeded)')).toBe(true);
  });

  test('FTP: an upload that would exceed the quota is aborted', async () => {
    const c = new ftp.Client(5000);
    await c.access({ host: '127.0.0.1', port: ftpPort, user: 'quinn', password: 'Quinn-Pass1' });
    try {
      await c.uploadFrom(Readable.from([Buffer.alloc(60 * KB)]), 'one.bin');
      await expect(c.uploadFrom(Readable.from([Buffer.alloc(60 * KB)]), 'two.bin')).rejects.toThrow(/quota/i);
    } finally {
      c.close();
    }
  });

  test('portal: too-large uploads are refused with 413 and leave nothing behind; usage is reported', async () => {
    await portal.put('/portal/api/upload').query({ path: '/ok.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(70 * KB)).expect(201);
    const res = await portal.put('/portal/api/upload').query({ path: '/big.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(40 * KB)).expect(413);
    expect(res.body.error).toMatch(/Storage quota exceeded \(limit 100 KB\)/);
    expect(fs.readdirSync(root).sort()).toEqual(['inbox', 'ok.bin']);

    const me = await portal.get('/portal/api/me').expect(200);
    expect(me.body).toMatchObject({ usedBytes: 70 * KB, quotaBytes: 100 * KB });

    // replacing a file only needs room for the difference
    await portal.put('/portal/api/upload').query({ path: '/ok.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(95 * KB)).expect(201);
  });

  test('share links: uploads count against the owner and are refused when full', async () => {
    const token = (await portal.post('/portal/api/shares').send({ path: '/inbox', type: 'upload' }).expect(201)).body.token;
    await request(base).put(`/s/${token}/upload`).query({ name: 'a.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(80 * KB)).expect(201);
    const full = await request(base).put(`/s/${token}/upload`).query({ name: 'b.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(30 * KB)).expect(413);
    expect(full.body.error).toBe('This folder is full');
    expect(fs.readdirSync(path.join(root, 'inbox'))).toEqual(['a.bin']);
  });

  test('admins set quotas in MB and see usage', async () => {
    await admin.put('/api/users/quinn').send({ quotaMb: 'lots' }).expect(400);
    await admin.put('/api/users/quinn').send({ quotaMb: '0.25' }).expect(200);
    expect(db.getUser('quinn')!.quotaBytes).toBe(256 * KB);
    fs.writeFileSync(path.join(root, 'x.bin'), Buffer.alloc(10 * KB));
    const usage = await admin.get('/api/users/quinn/usage').expect(200);
    expect(usage.body).toEqual({ usedBytes: 10 * KB, quotaBytes: 256 * KB });
    await admin.put('/api/users/quinn').send({ quotaMb: '' }).expect(200);
    expect(db.getUser('quinn')!.quotaBytes).toBeNull();
    await portal.put('/portal/api/upload').query({ path: '/huge.bin' }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(300 * KB)).expect(201);
    await admin.put('/api/users/quinn').send({ quotaMb: 100 / 1024 }).expect(200);
  });
});
