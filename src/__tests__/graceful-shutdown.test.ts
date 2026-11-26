/**
 * Graceful shutdown: listeners let transfers in progress finish, then
 * disconnect everyone; the process shuts down in order on SIGTERM.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { Client as FtpClient } from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { createShutdown, installProcessHandlers, shutdownGraceMs } from '../lifecycle';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

const quietLog = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** 10 chunks of 1 KiB, one every 100 ms: an upload that takes about a second. */
const slowUpload = () => {
  let sent = 0;
  return new Readable({
    read() {
      if (sent === 10) return this.push(null);
      sent++;
      setTimeout(() => this.push(Buffer.alloc(1024, 'x')), 100);
    },
  });
};

describe('createShutdown', () => {
  test('runs the steps in order with the grace period, then exits with the code', async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdown([
      ['a', g => { order.push(`a:${g}`); }],
      ['b', async () => { order.push('b'); }],
    ], { graceMs: 1234, log: quietLog(), exit });
    await shutdown('SIGTERM');
    expect(order).toEqual(['a:1234', 'b']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('a failing step is logged and the rest still run', async () => {
    const log = quietLog();
    const exit = jest.fn();
    const last = jest.fn();
    await createShutdown([['broken', () => { throw new Error('boom'); }], ['database', last]], { graceMs: 0, log, exit })('SIGTERM', 1);
    expect(last).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Shutdown step "broken" failed:', expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('a second request exits at once, and a hanging step is cut off by the hard timeout', async () => {
    const exit = jest.fn();
    const shutdown = createShutdown([['hangs', () => new Promise(() => {})]], { graceMs: 0, hardTimeoutMs: 200, log: quietLog(), exit });
    shutdown('SIGTERM');
    shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    await new Promise(r => setTimeout(r, 300));
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('SHUTDOWN_GRACE_MS overrides the default grace period', () => {
    expect(shutdownGraceMs({})).toBe(5000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '20000' })).toBe(20000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '0' })).toBe(0);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: 'soon' })).toBe(5000);
  });

  test('signals shut down gracefully; uncaught exceptions with code 1; rejections are only logged', () => {
    const proc = new EventEmitter();
    const shutdown = jest.fn();
    const log = quietLog();
    installProcessHandlers(shutdown, log, proc as any);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
    proc.emit('unhandledRejection', new Error('stray'));
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('Unhandled promise rejection:', expect.any(Error));
    proc.emit('uncaughtException', new Error('bug'));
    expect(shutdown).toHaveBeenLastCalledWith('uncaught exception', 1);
  });
});

describe('stopping listeners', () => {
  let dir: string;
  let root: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let sftpId: number;
  let ftpId: number;
  let sftpPort: number;
  let ftpPort: number;

  beforeAll(async () => {
    dir = makeTempDir('shutdown');
    root = path.join(dir, 'root');
    fs.mkdirSync(root);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const uid = db.createUser({ username: 'sam', password: 'Sam-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: uid, virtualPath: '/', localPath: root, ...FULL_VPATH_PERMS });
    sftpPort = await getFreePort();
    ftpPort = await getFreePort();
    sftpId = db.createListener({ name: 'sftp', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true });
    ftpId = db.createListener({ name: 'ftp', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true });
    db.subscribeUserToListener(uid, sftpId);
    db.subscribeUserToListener(uid, ftpId);
    manager = new ServerManager(db);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    db.close();
    removeDir(dir);
  });

  const sftpConnect = async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'sam', password: 'Sam-Pass-123', readyTimeout: 5000 });
    return c;
  };

  test('SFTP: a connected, idle client does not hold up a stop, and is disconnected', async () => {
    await manager.startListener(sftpId);
    const client = await sftpConnect();
    const ended = new Promise(resolve => client.on('end', resolve));
    const started = Date.now();
    await manager.stopListener(sftpId);
    expect(Date.now() - started).toBeLessThan(3000);
    await ended;
    await expect(sftpConnect()).rejects.toThrow();
  });

  test('SFTP: an upload in progress finishes within the grace period, then the client is disconnected', async () => {
    await manager.startListener(sftpId);
    const client = await sftpConnect();
    const upload = client.put(slowUpload(), '/slow-sftp.bin');
    await new Promise(r => setTimeout(r, 300)); // the transfer is under way
    const stopping = manager.stopListener(sftpId, 5000);
    await upload;
    await stopping;
    expect(fs.statSync(path.join(root, 'slow-sftp.bin')).size).toBe(10 * 1024);
    await client.end().catch(() => undefined);
  });

  test('FTP: an upload in progress finishes within the grace period before connections close', async () => {
    await manager.startListener(ftpId);
    const client = new FtpClient(10000);
    await client.access({ host: '127.0.0.1', port: ftpPort, user: 'sam', password: 'Sam-Pass-123' });
    const upload = client.uploadFrom(slowUpload(), '/slow-ftp.bin');
    await new Promise(r => setTimeout(r, 300));
    const stopping = manager.stopListener(ftpId, 5000);
    await upload;
    await stopping;
    expect(fs.statSync(path.join(root, 'slow-ftp.bin')).size).toBe(10 * 1024);
    client.close();
  });

  test('without a grace period, stopping cuts transfers off promptly', async () => {
    await manager.startListener(sftpId);
    const client = await sftpConnect();
    client.on('error', () => undefined);
    const upload = client.put(slowUpload(), '/cut-off.bin').catch((err: Error) => err);
    await new Promise(r => setTimeout(r, 300));
    const started = Date.now();
    await manager.stopListener(sftpId, 0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await upload).toBeInstanceOf(Error);
  });
});
