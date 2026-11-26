/**
 * Concurrency regression: many simultaneous SFTP and FTP clients transfer
 * files without errors or corruption, sessions are cleaned up afterwards,
 * and a large file streams through intact. (Heavier runs: tools/load-test.ts.)
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { Client as FtpClient } from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(120000);

const payload = (seed: number, size: number) => {
  const out = Buffer.alloc(size);
  const block = crypto.createHash('sha512').update(String(seed)).digest();
  for (let i = 0; i < size; i += block.length) block.copy(out, i);
  return out;
};
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('concurrent clients', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let sftpPort: number;
  let ftpPort: number;

  beforeAll(async () => {
    dir = makeTempDir('concurrency');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const uid = db.createUser({ username: 'many', password: 'Many-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: uid, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    sftpPort = await getFreePort();
    ftpPort = await getFreePort();
    for (const [protocol, port] of [['SFTP', sftpPort], ['FTP', ftpPort]] as const) {
      db.subscribeUserToListener(uid, db.createListener({ name: protocol, protocol, bindingIp: '127.0.0.1', port, enabled: true }));
    }
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  test('20 SFTP and 10 FTP clients at once: every file arrives intact and every session ends', async () => {
    const size = 256 * 1024;
    const sftpJob = async (i: number) => {
      const c = new SftpClient();
      await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'many', password: 'Many-Pass-123', readyTimeout: 20000 });
      try {
        for (let f = 0; f < 2; f++) {
          const data = payload(i * 10 + f, size);
          await c.put(data, `/s${i}-${f}.bin`);
          const back: Buffer = await c.get(`/s${i}-${f}.bin`);
          expect(sha(back)).toBe(sha(data));
        }
      } finally {
        await c.end();
      }
    };
    const ftpJob = async (i: number) => {
      const c = new FtpClient(30000);
      await c.access({ host: '127.0.0.1', port: ftpPort, user: 'many', password: 'Many-Pass-123' });
      try {
        for (let f = 0; f < 2; f++) {
          const data = payload(1000 + i * 10 + f, size);
          const source = new PassThrough();
          source.end(data);
          await c.uploadFrom(source, `/f${i}-${f}.bin`);
          const chunks: Buffer[] = [];
          const sink = new PassThrough();
          sink.on('data', (d: Buffer) => chunks.push(d));
          await c.downloadTo(sink, `/f${i}-${f}.bin`);
          expect(sha(Buffer.concat(chunks))).toBe(sha(data));
        }
      } finally {
        c.close();
      }
    };

    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => sftpJob(i)),
      ...Array.from({ length: 10 }, (_, i) => ftpJob(i)),
    ]);
    expect(fs.readdirSync(path.join(dir, 'root'))).toHaveLength(60);

    // all sessions are gone shortly after the clients leave
    const deadline = Date.now() + 5000;
    while (manager.getActiveSessions().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    expect(manager.getActiveSessions()).toEqual([]);
  });

  test('an FTP client that leaves ends its session and is logged out (ftp-srv emits no close event)', async () => {
    const c = new FtpClient(10000);
    await c.access({ host: '127.0.0.1', port: ftpPort, user: 'many', password: 'Many-Pass-123' });
    expect(manager.getActiveSessions().filter(s => s.protocol === 'FTP')).toHaveLength(1);
    c.close();
    const deadline = Date.now() + 5000;
    while (manager.getActiveSessions().length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(manager.getActiveSessions()).toEqual([]);
    expect(db.getRecentActivities(undefined, 5).some(a => a.action === 'LOGOUT' && a.username === 'many')).toBe(true);
  });

  test('a 64 MB file streams through SFTP intact', async () => {
    const size = 64 * 1024 * 1024;
    const data = payload(42, size);
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'many', password: 'Many-Pass-123', readyTimeout: 20000 });
    try {
      await c.put(data, '/big.bin');
      expect(fs.statSync(path.join(dir, 'root', 'big.bin')).size).toBe(size);
      const sink = new PassThrough();
      const hash = crypto.createHash('sha256');
      sink.on('data', (d: Buffer) => hash.update(d));
      await c.get('/big.bin', sink);
      expect(hash.digest('hex')).toBe(sha(data));
    } finally {
      await c.end();
    }
  });
});
