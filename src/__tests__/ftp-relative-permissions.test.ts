/**
 * ftp-relative-permissions.test.ts — FTP commands with names relative to the
 * current folder are checked against that folder's virtual path, not the root.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('FTP permissions for relative paths', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let port: number;

  beforeAll(async () => {
    dir = makeTempDir('ftp-relperm');
    fs.mkdirSync(path.join(dir, 'home'));
    fs.mkdirSync(path.join(dir, 'reports'));
    fs.writeFileSync(path.join(dir, 'reports', 'q1.txt'), 'q1');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const id = db.createUser({ username: 'rita', password: 'Rita-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: id, virtualPath: '/', localPath: path.join(dir, 'home'), ...FULL_VPATH_PERMS });
    db.addVirtualPath({
      userId: id, virtualPath: '/reports', localPath: path.join(dir, 'reports'),
      ...FULL_VPATH_PERMS, canWrite: false, canAppend: false, canDelete: false, canRename: false, canCreateDir: false,
    });
    port = await getFreePort();
    db.subscribeUserToListener(id, db.createListener({ name: 'F', protocol: 'FTP', bindingIp: '127.0.0.1', port, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  test('after cd into a read-only folder, relative uploads, deletes, renames and mkdir are refused', async () => {
    const c = new ftp.Client(5000);
    await c.access({ host: '127.0.0.1', port, user: 'rita', password: 'Rita-Pass-123' });
    try {
      await c.cd('/reports');
      await expect(c.uploadFrom(Readable.from([Buffer.from('x')]), 'sneaky.txt')).rejects.toThrow();
      await expect(c.remove('q1.txt')).rejects.toThrow();
      await expect(c.rename('q1.txt', 'q2.txt')).rejects.toThrow();
      await expect(c.send('MKD sub')).rejects.toThrow();
      // reading is still allowed
      expect((await c.list()).map(e => e.name)).toEqual(['q1.txt']);
      // and the writable root still accepts relative uploads
      await c.cd('/');
      await c.uploadFrom(Readable.from([Buffer.from('ok')]), 'fine.txt');
    } finally {
      c.close();
    }
    expect(fs.readdirSync(path.join(dir, 'reports')).sort()).toEqual(['q1.txt']);
    expect(fs.readFileSync(path.join(dir, 'home', 'fine.txt'), 'utf8')).toBe('ok');
  });
});
