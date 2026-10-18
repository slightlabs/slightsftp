/**
 * cloud-protocols.test.ts — cloud virtual paths end to end: real SFTP and
 * FTP clients working in an S3 bucket (in-memory fake) and an Azure Blob
 * container (Azurite), next to a normal local folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable, Writable } from 'stream';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { cloudPath, getBackend, readAll, stagingDir } from '../cloud-storage';
import { FakeS3, fakeS3Config, startFakeS3 } from './helpers/fake-s3';
import { Azurite, createAzureContainer, startAzurite } from './helpers/cloud-servers';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(60000);

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('cloud virtual paths over SFTP and FTP', () => {
  let dir: string;
  let s3: FakeS3;
  let azurite: Azurite;
  let db: DatabaseManager;
  let manager: ServerManager;
  let sftpPort: number;
  let ftpPort: number;
  let s3Id: number;
  let azId: number;
  let activity: any[] = [];

  const sftp = async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'cara', password: 'Cara-Pass-123', readyTimeout: 5000 });
    return c;
  };
  const ftpClient = async () => {
    const c = new ftp.Client(10000);
    await c.access({ host: '127.0.0.1', port: ftpPort, user: 'cara', password: 'Cara-Pass-123' });
    return c;
  };
  const cloudText = async (id: number, key: string) => (await readAll(await getBackend(db, id).read(key))).toString();

  beforeAll(async () => {
    dir = makeTempDir('cloud-proto');
    fs.mkdirSync(path.join(dir, 'local'));
    s3 = await startFakeS3({ pageSize: 4 });
    azurite = await startAzurite();
    await createAzureContainer(azurite.connectionString, 'files');

    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    s3Id = db.createStorageConnection({ name: 'Fake S3', type: 's3', config: fakeS3Config(s3) });
    azId = db.createStorageConnection({ name: 'Azurite', type: 'azure', config: { container: 'files', connectionString: azurite.connectionString } });
    const cara = db.createUser({ username: 'cara', password: 'Cara-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: cara, virtualPath: '/', localPath: path.join(dir, 'local'), ...FULL_VPATH_PERMS });
    db.addVirtualPath({ userId: cara, virtualPath: '/s3', localPath: cloudPath(s3Id, 'users/cara'), ...FULL_VPATH_PERMS });
    db.addVirtualPath({ userId: cara, virtualPath: '/azure', localPath: cloudPath(azId), ...FULL_VPATH_PERMS });
    db.addVirtualPath({ userId: cara, virtualPath: '/readonly', localPath: cloudPath(s3Id, 'public'), ...FULL_VPATH_PERMS, canWrite: false, canDelete: false, canRename: false, canCreateDir: false });
    await getBackend(db, s3Id).write('public/notice.txt', Readable.from([Buffer.from('read me')]));

    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(cara, db.createListener({ name: 'SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(cara, db.createListener({ name: 'FTP', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
    manager = new ServerManager(db);
    manager.on('activity', (a: any) => activity.push(a));
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    await s3.close();
    await azurite.stop();
    removeDir(dir);
  });

  beforeEach(() => { activity = []; });

  describe.each([
    ['S3', '/s3', () => s3Id, 'users/cara/'],
    ['Azure Blob', '/azure', () => azId, ''],
  ])('SFTP in %s', (_label, root, id, keyPrefix) => {
    test('upload, list, stat, download, overwrite', async () => {
      const c = await sftp();
      try {
        await c.put(Buffer.from('hello from sftp'), `${root}/hello.txt`);
        expect(await cloudText(id(), `${keyPrefix}hello.txt`)).toBe('hello from sftp');
        const list = await c.list(root);
        expect(list.map((e: any) => e.name)).toContain('hello.txt');
        expect(list.find((e: any) => e.name === 'hello.txt')).toMatchObject({ type: '-', size: 15 });
        expect(await c.stat(`${root}/hello.txt`)).toMatchObject({ isFile: true, size: 15 });
        expect(await c.stat(root)).toMatchObject({ isDirectory: true });
        expect((await c.get(`${root}/hello.txt`)).toString()).toBe('hello from sftp');
        await c.put(Buffer.from('v2'), `${root}/hello.txt`);
        expect((await c.get(`${root}/hello.txt`)).toString()).toBe('v2');
        expect(await c.exists(`${root}/nope.txt`)).toBe(false);
      } finally {
        await c.end();
      }
      await waitFor(() => activity.some(a => a.action === 'UPLOAD' && a.path === `${root}/hello.txt` && a.checksum === sha(Buffer.from('v2'))));
      expect(activity.some(a => a.action === 'DOWNLOAD' && a.bytes === 2)).toBe(true);
    });

    test('a 3 MB file round-trips byte for byte (pipelined reads while it downloads)', async () => {
      const big = crypto.randomBytes(3 * 1024 * 1024 + 123);
      const c = await sftp();
      try {
        await c.put(big, `${root}/big.bin`);
        expect((await c.stat(`${root}/big.bin`)).size).toBe(big.length);
        const back: Buffer = await c.get(`${root}/big.bin`);
        expect(sha(back)).toBe(sha(big));
        // fastGet issues many concurrent reads at different offsets
        const local = path.join(dir, `fast-${id()}.bin`);
        await c.fastGet(`${root}/big.bin`, local, { concurrency: 8, chunkSize: 32768 });
        expect(sha(fs.readFileSync(local))).toBe(sha(big));
        await c.delete(`${root}/big.bin`);
      } finally {
        await c.end();
      }
    });

    test('appending keeps the existing content', async () => {
      const c = await sftp();
      try {
        await c.put(Buffer.from('line 1\n'), `${root}/log.txt`);
        await c.append(Buffer.from('line 2\n'), `${root}/log.txt`);
        expect(await cloudText(id(), `${keyPrefix}log.txt`)).toBe('line 1\nline 2\n');
      } finally {
        await c.end();
      }
    });

    test('folders: mkdir, nested upload, rename, rmdir', async () => {
      const c = await sftp();
      try {
        await c.mkdir(`${root}/projects`);
        expect((await c.list(root)).find((e: any) => e.name === 'projects')).toMatchObject({ type: 'd' });
        await c.put(Buffer.from('plan'), `${root}/projects/plan.md`);
        await c.rename(`${root}/projects/plan.md`, `${root}/projects/plan-v2.md`);
        expect((await c.list(`${root}/projects`)).map((e: any) => e.name)).toEqual(['plan-v2.md']);
        await c.rename(`${root}/projects`, `${root}/archive`);
        expect((await c.get(`${root}/archive/plan-v2.md`)).toString()).toBe('plan');
        await expect(c.rmdir(`${root}/archive`)).rejects.toThrow(); // not empty
        await c.delete(`${root}/archive/plan-v2.md`);
        await c.rmdir(`${root}/archive`);
        expect(await c.exists(`${root}/archive`)).toBe(false);
      } finally {
        await c.end();
      }
    });

    test('errors: missing files, deleting a folder as a file, moving to local disk', async () => {
      const c = await sftp();
      try {
        await expect(c.get(`${root}/missing.txt`)).rejects.toThrow(/No such file|not exist/i);
        await expect(c.delete(`${root}/missing.txt`)).rejects.toThrow();
        await c.mkdir(`${root}/keep`);
        await expect(c.delete(`${root}/keep`)).rejects.toThrow();
        await c.put(Buffer.from('x'), `${root}/move-me.txt`);
        await expect(c.rename(`${root}/move-me.txt`, '/local-copy.txt')).rejects.toThrow();
        expect(fs.existsSync(path.join(dir, 'local', 'local-copy.txt'))).toBe(false);
      } finally {
        await c.end();
      }
    });
  });

  test('SFTP: permissions on a read-only cloud folder are enforced', async () => {
    const c = await sftp();
    try {
      expect((await c.get('/readonly/notice.txt')).toString()).toBe('read me');
      await expect(c.put(Buffer.from('x'), '/readonly/new.txt')).rejects.toThrow();
      await expect(c.delete('/readonly/notice.txt')).rejects.toThrow();
      await expect(c.mkdir('/readonly/dir')).rejects.toThrow();
    } finally {
      await c.end();
    }
    expect(s3.objects.has('public/new.txt')).toBe(false);
    expect(s3.objects.has('public/notice.txt')).toBe(true);
  });

  test('SFTP: the local folder still works and no "cloud:" folder appears on disk', async () => {
    const c = await sftp();
    try {
      await c.put(Buffer.from('local'), '/local.txt');
      expect(fs.readFileSync(path.join(dir, 'local', 'local.txt'), 'utf8')).toBe('local');
      const names = (await c.list('/')).map((e: any) => e.name);
      expect(names).toContain('local.txt');
    } finally {
      await c.end();
    }
    expect(fs.existsSync(path.join(process.cwd(), 'cloud:'))).toBe(false);
  });

  test('SFTP: an upload abandoned mid-way is not stored, and staging files are cleaned up', async () => {
    const before = fs.readdirSync(stagingDir()).length;
    const c = await sftp();
    const handle: Buffer = await new Promise((resolve, reject) =>
      c.sftp.open('/s3/half.bin', 'w', (err: any, h: Buffer) => (err ? reject(err) : resolve(h))));
    await new Promise<void>((resolve, reject) => c.sftp.write(handle, Buffer.alloc(1000, 1), 0, 1000, 0, (err: any) => (err ? reject(err) : resolve())));
    await c.end(); // no CLOSE
    await waitFor(() => fs.readdirSync(stagingDir()).length <= before);
    expect(s3.objects.has('users/cara/half.bin')).toBe(false);
  });

  test('SFTP: storage quotas count what is already in the bucket', async () => {
    await getBackend(db, s3Id).write('users/cara/existing.bin', Readable.from([crypto.randomBytes(50 * 1024)]));
    db.updateUser('cara', { quotaBytes: 64 * 1024 } as any);
    const quotaUser = (await import('../quota')).getQuotaManager(db);
    quotaUser.invalidate('cara');
    const c = await sftp();
    try {
      // raw writes: ssh2-sftp-client's put() does not report WRITE failures
      const handle: Buffer = await new Promise((resolve, reject) =>
        c.sftp.open('/s3/over.bin', 'w', (err: any, h: Buffer) => (err ? reject(err) : resolve(h))));
      const write = (data: Buffer, offset: number) => new Promise<void>((resolve, reject) =>
        c.sftp.write(handle, data, 0, data.length, offset, (err: any) => (err ? reject(err) : resolve())));
      await write(Buffer.alloc(8 * 1024), 0); // 50 KB + 8 KB fits
      await expect(write(Buffer.alloc(16 * 1024), 8 * 1024)).rejects.toThrow(/quota/i);
      await new Promise<void>(resolve => c.sftp.close(handle, () => resolve()));
    } finally {
      await c.end();
      db.updateUser('cara', { quotaBytes: null } as any);
      quotaUser.invalidate('cara');
    }
    await waitFor(() => s3.objects.has('users/cara/over.bin'));
    expect(s3.objects.get('users/cara/over.bin')!.body.length).toBe(8 * 1024);
    await getBackend(db, s3Id).remove('users/cara/existing.bin');
  });

  describe.each([
    ['S3', '/s3', () => s3Id, 'users/cara/'],
    ['Azure Blob', '/azure', () => azId, ''],
  ])('FTP in %s', (_label, root, id, keyPrefix) => {
    test('upload, list, size, download, rename, delete, folders', async () => {
      const c = await ftpClient();
      try {
        await c.uploadFrom(Readable.from([Buffer.from('hello from ftp')]), `${root}/ftp.txt`);
        expect(await cloudText(id(), `${keyPrefix}ftp.txt`)).toBe('hello from ftp');
        const list = await c.list(root);
        expect(list.find(e => e.name === 'ftp.txt')).toMatchObject({ size: 14, isFile: true });
        expect(await c.size(`${root}/ftp.txt`)).toBe(14);

        const chunks: Buffer[] = [];
        await c.downloadTo(new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } }), `${root}/ftp.txt`);
        expect(Buffer.concat(chunks).toString()).toBe('hello from ftp');

        await c.ensureDir(`${root}/ftpdir`);
        expect(await c.pwd()).toBe(`${root}/ftpdir`);
        await c.uploadFrom(Readable.from([Buffer.from('nested')]), 'nested.txt');
        expect((await c.list()).map(e => e.name)).toEqual(['nested.txt']);
        await c.cd('/');
        await c.rename(`${root}/ftpdir/nested.txt`, `${root}/ftpdir/renamed.txt`);
        await c.remove(`${root}/ftpdir/renamed.txt`);
        await c.removeEmptyDir(`${root}/ftpdir`);
        expect((await c.list(root)).map(e => e.name)).not.toContain('ftpdir');
        await c.remove(`${root}/ftp.txt`);
        await expect(c.size(`${root}/ftp.txt`)).rejects.toThrow();
      } finally {
        c.close();
      }
      await waitFor(() => activity.some(a => a.action === 'UPLOAD' && a.path === `${root}/ftp.txt` && a.bytes === 14 && a.checksum));
    });

    test('APPE appends to the existing object', async () => {
      const c = await ftpClient();
      try {
        await c.uploadFrom(Readable.from([Buffer.from('first,')]), `${root}/appe.txt`);
        await c.appendFrom(Readable.from([Buffer.from('second')]), `${root}/appe.txt`);
        expect(await cloudText(id(), `${keyPrefix}appe.txt`)).toBe('first,second');
        await c.appendFrom(Readable.from([Buffer.from('new')]), `${root}/appe-new.txt`);
        expect(await cloudText(id(), `${keyPrefix}appe-new.txt`)).toBe('new');
      } finally {
        c.close();
      }
    });

    test('a 2 MB upload and download match', async () => {
      const big = crypto.randomBytes(2 * 1024 * 1024 + 7);
      const c = await ftpClient();
      try {
        await c.uploadFrom(Readable.from([big]), `${root}/big-ftp.bin`);
        const chunks: Buffer[] = [];
        await c.downloadTo(new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb(); } }), `${root}/big-ftp.bin`);
        expect(sha(Buffer.concat(chunks))).toBe(sha(big));
        await c.remove(`${root}/big-ftp.bin`);
      } finally {
        c.close();
      }
    });
  });

  test('FTP: read-only cloud folder refuses writes', async () => {
    const c = await ftpClient();
    try {
      await expect(c.uploadFrom(Readable.from([Buffer.from('x')]), '/readonly/nope.txt')).rejects.toThrow();
      expect((await c.list('/readonly')).map(e => e.name)).toEqual(['notice.txt']);
    } finally {
      c.close();
    }
    expect(s3.objects.has('public/nope.txt')).toBe(false);
  });
});
