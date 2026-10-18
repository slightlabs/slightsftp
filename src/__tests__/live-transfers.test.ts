/**
 * live-transfers.test.ts — the sessions API reports transfers in progress and
 * per-session totals for real SFTP and FTP clients.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { TransferTracker } from '../transfers';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('TransferTracker', () => {
  test('tracks bytes, speed and totals per session', () => {
    const t = new TransferTracker();
    const up = t.start('s1', '/a.bin', 'upload');
    up.add(1000);
    up.add(500);
    const down = t.start('s1', '/b.bin', 'download');
    down.add(200);

    const now = Date.now() + 1000;
    const stats = t.stats('s1', now);
    expect(stats.uploadedBytes).toBe(1500);
    expect(stats.downloadedBytes).toBe(200);
    expect(stats.transfers.map(x => [x.path, x.direction, x.bytes])).toEqual([['/a.bin', 'upload', 1500], ['/b.bin', 'download', 200]]);
    expect(stats.transfers[0].bytesPerSecond).toBeGreaterThan(1000);
    expect(stats.transfers[0].bytesPerSecond).toBeLessThanOrEqual(1500);

    up.end();
    up.add(999); // ignored after end
    expect(t.stats('s1').transfers.map(x => x.path)).toEqual(['/b.bin']);
    expect(t.stats('s1').uploadedBytes).toBe(1500);

    t.endSession('s1');
    expect(t.stats('s1')).toEqual({ uploadedBytes: 0, downloadedBytes: 0, transfers: [] });
    expect(t.stats('unknown').transfers).toEqual([]);
  });
});

describe('sessions report live transfers', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let sftpPort: number;
  let ftpPort: number;

  const sessionsOf = (protocol: string) => manager.getActiveSessions().filter(s => s.protocol === protocol);

  beforeAll(async () => {
    dir = makeTempDir('live');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'download.bin'), Buffer.alloc(64 * 1024, 3));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const userId = db.createUser({ username: 'mover', password: 'Mover-Pass-1', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId, virtualPath: '/', localPath: root, ...FULL_VPATH_PERMS });
    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(userId, db.createListener({ name: 'Live SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(userId, db.createListener({ name: 'Live FTP', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  test('SFTP: an open upload shows up with its bytes so far; totals remain after it finishes', async () => {
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: sftpPort, username: 'mover', password: 'Mover-Pass-1', readyTimeout: 5000 });
    const sftp = client.sftp;
    const call = (fn: string, ...args: any[]) => new Promise<any>((resolve, reject) => sftp[fn](...args, (err: any, v: any) => (err ? reject(err) : resolve(v))));
    try {
      const handle = await call('open', '/slow.bin', 'w');
      await call('write', handle, Buffer.alloc(4096, 1), 0, 4096, 0);

      const [during] = sessionsOf('SFTP');
      expect(during.transfers).toEqual([expect.objectContaining({ path: '/slow.bin', direction: 'upload', bytes: 4096 })]);
      expect(during.uploadedBytes).toBe(4096);

      await call('write', handle, Buffer.alloc(4096, 2), 0, 4096, 4096);
      expect(sessionsOf('SFTP')[0].transfers![0].bytes).toBe(8192);
      await call('close', handle);

      const [after] = sessionsOf('SFTP');
      expect(after.transfers).toEqual([]);
      expect(after.uploadedBytes).toBe(8192);

      await client.get('/download.bin');
      expect(sessionsOf('SFTP')[0].downloadedBytes).toBe(64 * 1024);
    } finally {
      await client.end();
    }
    await waitFor(() => sessionsOf('SFTP').length === 0);
  });

  test('FTP: a slow upload is visible while it is running', async () => {
    const client = new ftp.Client(5000);
    await client.access({ host: '127.0.0.1', port: ftpPort, user: 'mover', password: 'Mover-Pass-1' });
    try {
      async function* slowBody() {
        yield Buffer.alloc(16 * 1024, 7);
        await new Promise(r => setTimeout(r, 1500)); // keep the transfer open for a moment
        yield Buffer.alloc(16 * 1024, 8);
      }
      const upload = client.uploadFrom(Readable.from(slowBody()), 'ftp-slow.bin');

      const during = await waitFor(() => sessionsOf('FTP')[0]?.transfers?.find(t => t.path.endsWith('ftp-slow.bin') && t.bytes > 0));
      expect(during).toMatchObject({ direction: 'upload' });
      expect(during!.bytes).toBeGreaterThanOrEqual(16 * 1024);

      await upload;
      await waitFor(() => sessionsOf('FTP')[0].transfers!.length === 0);
      expect(sessionsOf('FTP')[0].uploadedBytes).toBe(32 * 1024);
      expect(fs.statSync(path.join(root, 'ftp-slow.bin')).size).toBe(32 * 1024);

      const sink: Buffer[] = [];
      await client.downloadTo(new (require('stream').Writable)({ write(c: Buffer, _e: any, cb: () => void) { sink.push(c); cb(); } }), 'download.bin');
      expect(Buffer.concat(sink).length).toBe(64 * 1024);
      await waitFor(() => sessionsOf('FTP')[0].downloadedBytes === 64 * 1024);
    } finally {
      client.close();
    }
  });
});
