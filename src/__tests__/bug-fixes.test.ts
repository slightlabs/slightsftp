/**
 * bug-fixes.test.ts — regression tests for the 6 bugs fixed in
 * sftp-server.ts and ftp-server.ts (CustomFileSystem).
 */

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('ssh2', () => {
  const actual = jest.requireActual('ssh2');
  return { ...actual, Server: jest.fn() };
});

jest.spyOn(
  require('../sftp-server').SFTPServer.prototype as any,
  'generateHostKeys'
).mockImplementation(() => {});

jest.mock('ftp-srv', () => {
  class FileSystem {
    cwd: string; root: string;
    constructor(_conn: any, opts: any = {}) { this.cwd = opts.cwd || '/'; this.root = opts.root || '/tmp'; }
    get(_p: string) { return Promise.resolve({ size: 0, mtime: new Date(), isDirectory: () => false, isFile: () => true }); }
    list(_p: string) { return Promise.resolve([]); }
  }
  const FtpSrvMock = jest.fn().mockImplementation(() => {
    const em = new (require('events').EventEmitter)();
    em.listen = jest.fn().mockResolvedValue(undefined);
    em.close = jest.fn().mockResolvedValue(undefined);
    return em;
  });
  return { default: FtpSrvMock, FileSystem };
});

const DEFAULT_STAT = {
  mode: 33188, uid: 0, gid: 0, size: 0,
  isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date()
};

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    // mocked sync ops needed by SFTP handlers
    stat: jest.fn(), rmdir: jest.fn(), unlink: jest.fn(), mkdir: jest.fn(),
    rename: jest.fn(), chmod: jest.fn(),
    createWriteStream: jest.fn(), createReadStream: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    existsSync: jest.fn().mockReturnValue(true),
    statSync: jest.fn().mockReturnValue({ mode: 33188, uid: 0, gid: 0, size: 0, isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date() }),
    lstatSync: jest.fn().mockReturnValue({ mode: 33188, uid: 0, gid: 0, size: 0, isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date() }),
    writeSync: jest.fn().mockReturnValue(0),
    readSync: jest.fn().mockReturnValue(0),
    openSync: jest.fn().mockReturnValue(3),
    closeSync: jest.fn(),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    rmdirSync: jest.fn(),
    renameSync: jest.fn(),
    constants: real.constants,
    promises: { ...real.promises, stat: jest.fn(), readdir: jest.fn() },
  };
});

import { SFTPServer } from '../sftp-server';
import { CustomFileSystem } from '../ftp-server';
import { DatabaseManager } from '../database';
import { Listener, User, Permission, VirtualPath } from '../types';
import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

// ─── shared fixtures ───────────────────────────────────────────────────────

const TEST_LISTENER: Listener = {
  id: 1, name: 'Test', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 22222, enabled: true
};

const FULL_PERM: Permission = {
  userId: 1, listenerId: 1, canRead: true, canCreate: true, canEdit: true,
  canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true
};

const FULL_VP: VirtualPath = {
  id: 1, userId: 1, virtualPath: '/', localPath: '/tmp',
  canRead: true, canWrite: true, canAppend: true, canDelete: true,
  canList: true, canCreateDir: true, canRename: true, applyToSubdirs: true
};

const TEST_USER: User = {
  id: 1, username: 'alice',
  password: crypto.createHash('sha256').update('pass').digest('hex'),
  passwordEnabled: true, publicKey: '', guiEnabled: false, createdAt: ''
};

function makeSFTPMocks() {
  const mockSSHSrv = new EventEmitter() as any;
  mockSSHSrv.listen = jest.fn((_p: any, _h: any, cb?: any) => { cb?.(); return mockSSHSrv; });
  mockSSHSrv.close = jest.fn((cb?: any) => { cb?.(); });
  (ssh2.Server as unknown as jest.Mock).mockImplementation((_opts: any, handler: any) => {
    mockSSHSrv._clientHandler = handler;
    return mockSSHSrv;
  });
  const mockDb = {
    getUser: jest.fn().mockReturnValue(TEST_USER),
    getSetting: jest.fn(), // brute-force guard reads its settings (defaults apply)
    getVirtualPaths: jest.fn().mockReturnValue([FULL_VP]),
    getPermission: jest.fn().mockReturnValue({ ...FULL_PERM }),
    getUserListeners: jest.fn().mockReturnValue([1]),
    verifyPassword: jest.fn().mockReturnValue(true),
    logActivity: jest.fn(),
  } as any as jest.Mocked<DatabaseManager>;
  return { mockSSHSrv, mockDb };
}

/** Simulate: connect → password auth → ready → session → sftp */
function simulateFullSession(sshHandler: (client: any) => void, _db: jest.Mocked<DatabaseManager>) {
  const client = new EventEmitter() as any;
  client.end = jest.fn();
  (client as any)._sock = { remoteAddress: '127.0.0.1', remotePort: 54321 };

  const sftp = new EventEmitter() as any;
  sftp.handle = jest.fn();
  sftp.status = jest.fn();
  sftp.data = jest.fn();
  sftp.name = jest.fn();
  sftp.attrs = jest.fn();

  const session = new EventEmitter() as any;
  const sftpAccept = jest.fn().mockReturnValue(sftp);
  const sessionAccept = jest.fn().mockReturnValue(session);

  sshHandler(client);

  client.emit('authentication', {
    method: 'password', username: 'alice', password: 'pass',
    accept: jest.fn(), reject: jest.fn()
  });

  client.emit('ready');
  client.emit('session', sessionAccept);
  session.emit('sftp', sftpAccept);

  return { client, sftp };
}

// ══════════════════════════════════════════════════════════════════════════
// Fix 1: dirHandles isolated per connection
// ══════════════════════════════════════════════════════════════════════════
describe('Fix 1: dirHandles are isolated per connection', () => {
  let server: SFTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSSHSrv: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = makeSFTPMocks();
    mockDb = m.mockDb; mockSSHSrv = m.mockSSHSrv;
    server = new SFTPServer(TEST_LISTENER, mockDb);
    await server.start();
  });

  afterEach(async () => { await server.stop(); });

  test('disconnecting client A does not clear client B directory handles', () => {
    const handler = mockSSHSrv._clientHandler;
    const { client: clientA, sftp: sftpA } = simulateFullSession(handler, mockDb);
    const { client: clientB, sftp: sftpB } = simulateFullSession(handler, mockDb);

    // Client B opens a directory
    (fs.readdirSync as jest.Mock).mockReturnValue(['file.txt']);
    sftpB.emit('OPENDIR', 42, '/');

    const handleB: Buffer | undefined = (sftpB.handle as jest.Mock).mock.calls[0]?.[1];
    expect(handleB).toBeDefined();

    // Client A disconnects — before the fix this cleared ALL dirHandles
    clientA.emit('end');

    // Client B should still be able to READDIR using its handle
    if (handleB) {
      sftpB.emit('READDIR', 99, handleB);
      // FAILURE code is 4; EOF is 1; OK is 0 — not seeing code 4 means success
      const failureCalls = (sftpB.status as jest.Mock).mock.calls
        .filter(([_id, code]: any[]) => code === 4);
      expect(failureCalls).toHaveLength(0);
    }
  });

  test('two simultaneous OPENDIR sessions get independent handles', () => {
    const handler = mockSSHSrv._clientHandler;
    const { sftp: sftpA } = simulateFullSession(handler, mockDb);
    const { sftp: sftpB } = simulateFullSession(handler, mockDb);

    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    sftpA.emit('OPENDIR', 1, '/');
    sftpB.emit('OPENDIR', 2, '/');

    // Both should have received handles
    expect((sftpA.handle as jest.Mock).mock.calls[0]?.[1]).toBeDefined();
    expect((sftpB.handle as jest.Mock).mock.calls[0]?.[1]).toBeDefined();
    // Handles should be different buffers
    const hA = (sftpA.handle as jest.Mock).mock.calls[0][1].toString();
    const hB = (sftpB.handle as jest.Mock).mock.calls[0][1].toString();
    expect(hA).not.toBe(hB);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Fix 2: WRITE permission checks canCreate
// ══════════════════════════════════════════════════════════════════════════
describe('Fix 2: WRITE handler honours the write access granted at OPEN (canCreate/canEdit/canAppend)', () => {
  let server: SFTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSSHSrv: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = makeSFTPMocks();
    mockDb = m.mockDb; mockSSHSrv = m.mockSSHSrv;
    server = new SFTPServer(TEST_LISTENER, mockDb);
    await server.start();
  });

  afterEach(async () => { await server.stop(); });

  // SFTP open flags: WRITE=0x02, APPEND=0x04, CREAT=0x08
  function emitWrite(sftp: any, openFlags = 0x02 | 0x08) {
    // WRITE is only accepted on a handle that OPEN granted write access to
    sftp.emit('OPEN', 0, '/file.txt', openFlags, {});
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(3, 0); // fd 3 (openSync returns 3)
    sftp.emit('WRITE', 1, handle, 0, Buffer.from('data'));
  }

  const writeStatuses = (sftp: any) =>
    (sftp.status as jest.Mock).mock.calls.filter(([reqId]: any[]) => reqId === 1).map(([, code]: any[]) => code);

  test('WRITE allowed when canCreate=true, canEdit=false, canAppend=false', () => {
    mockDb.getPermission.mockReturnValue({ ...FULL_PERM, canCreate: true, canEdit: false, canAppend: false });
    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    emitWrite(sftp);
    expect(writeStatuses(sftp)).not.toContain(3);
    expect(fs.writeSync).toHaveBeenCalled();
  });

  test('WRITE allowed when canEdit=true, canCreate=false', () => {
    mockDb.getPermission.mockReturnValue({ ...FULL_PERM, canCreate: false, canEdit: true, canAppend: false });
    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    emitWrite(sftp);
    expect(writeStatuses(sftp)).not.toContain(3);
  });

  test('WRITE allowed when canAppend=true, canCreate=false, canEdit=false', () => {
    mockDb.getPermission.mockReturnValue({ ...FULL_PERM, canCreate: false, canEdit: false, canAppend: true });
    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    emitWrite(sftp, 0x02 | 0x04); // WRITE | APPEND
    expect(writeStatuses(sftp)).not.toContain(3);
  });

  test('WRITE denied when canCreate=false, canEdit=false, canAppend=false', () => {
    mockDb.getPermission.mockReturnValue({ ...FULL_PERM, canCreate: false, canEdit: false, canAppend: false });
    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    emitWrite(sftp);
    expect(writeStatuses(sftp)).toEqual([3]);
    expect(fs.writeSync).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Fix 3: resetIdleTimeout in REMOVE / RMDIR / MKDIR / RENAME / REALPATH
// ══════════════════════════════════════════════════════════════════════════
describe('Fix 3: file mutation handlers reset the idle timer', () => {
  let server: SFTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSSHSrv: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const m = makeSFTPMocks();
    mockDb = m.mockDb; mockSSHSrv = m.mockSSHSrv;
    server = new SFTPServer(TEST_LISTENER, mockDb, 1000); // 1 s idle timeout
    await server.start();   // async setup with REAL timers
    jest.useFakeTimers();   // switch to fake timers AFTER async setup
  });

  afterEach(async () => {
    jest.useRealTimers();
    await server.stop();
  });

  function sessionAndAdvance(emit: (sftp: any) => void) {
    const { client, sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    // 'ready' sets a 1 s timer; now invoke the handler to reset it
    emit(sftp);
    // 500 ms after the reset → not yet disconnected
    jest.advanceTimersByTime(500);
    const notCalled = !(client.end as jest.Mock).mock.calls.length;
    // 600 ms more (1100 ms total since reset) → should disconnect
    jest.advanceTimersByTime(600);
    const called = !!(client.end as jest.Mock).mock.calls.length;
    return { notCalled, called };
  }

  test('REMOVE resets idle timeout', () => {
    const { notCalled, called } = sessionAndAdvance(sftp =>
      sftp.emit('REMOVE', 1, '/file.txt'));
    expect(notCalled).toBe(true);
    expect(called).toBe(true);
  });

  test('RMDIR resets idle timeout', () => {
    const { notCalled, called } = sessionAndAdvance(sftp =>
      sftp.emit('RMDIR', 1, '/dir'));
    expect(notCalled).toBe(true);
    expect(called).toBe(true);
  });

  test('MKDIR resets idle timeout', () => {
    const { notCalled, called } = sessionAndAdvance(sftp =>
      sftp.emit('MKDIR', 1, '/newdir', {}));
    expect(notCalled).toBe(true);
    expect(called).toBe(true);
  });

  test('RENAME resets idle timeout', () => {
    const { notCalled, called } = sessionAndAdvance(sftp =>
      sftp.emit('RENAME', 1, '/old.txt', '/new.txt'));
    expect(notCalled).toBe(true);
    expect(called).toBe(true);
  });

  test('REALPATH resets idle timeout', () => {
    const { notCalled, called } = sessionAndAdvance(sftp =>
      sftp.emit('REALPATH', 1, '/'));
    expect(notCalled).toBe(true);
    expect(called).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Fix 4: STAT / LSTAT emit success:false on error
// ══════════════════════════════════════════════════════════════════════════
describe('Fix 4: STAT and LSTAT log success:false on failure', () => {
  let server: SFTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSSHSrv: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Restore statSync / lstatSync default behaviour
    (fs.statSync as jest.Mock).mockReturnValue({
      mode: 33188, uid: 0, gid: 0, size: 0,
      isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date()
    });
    (fs.lstatSync as jest.Mock).mockReturnValue({
      mode: 33188, uid: 0, gid: 0, size: 0,
      isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date()
    });
    const m = makeSFTPMocks();
    mockDb = m.mockDb; mockSSHSrv = m.mockSSHSrv;
    server = new SFTPServer(TEST_LISTENER, mockDb);
    await server.start();
  });

  afterEach(async () => { await server.stop(); });

  test('STAT emits activity success:false when file not found', () => {
    const actHandler = jest.fn();
    server.on('activity', actHandler);

    // statSync throws for paths with 'missing'; existsSync returns false
    // so pathMapper skips its own statSync call (short-circuit &&)
    (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
      !p.includes('missing'));
    (fs.statSync as jest.Mock).mockImplementation((p: string) => {
      if (p.includes('missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: 33188, uid: 0, gid: 0, size: 0, isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date() };
    });

    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    sftp.emit('STAT', 1, '/missing.txt');

    const failed = actHandler.mock.calls.find(([a]: any[]) => a.action === 'STAT_FAILED');
    expect(failed).toBeDefined();
    expect(failed[0].success).toBe(false);
  });

  test('LSTAT emits activity success:false when file not found', () => {
    const actHandler = jest.fn();
    server.on('activity', actHandler);

    (fs.lstatSync as jest.Mock).mockImplementation((p: string) => {
      if (p.includes('missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: 33188, uid: 0, gid: 0, size: 0, isDirectory: () => false, atimeMs: 0, mtimeMs: 0, mtime: new Date() };
    });

    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    sftp.emit('LSTAT', 1, '/missing.txt');

    const failed = actHandler.mock.calls.find(([a]: any[]) => a.action === 'LSTAT_FAILED');
    expect(failed).toBeDefined();
    expect(failed[0].success).toBe(false);
  });

  test('STAT emits activity success:true on success', () => {
    const actHandler = jest.fn();
    server.on('activity', actHandler);
    const { sftp } = simulateFullSession(mockSSHSrv._clientHandler, mockDb);
    sftp.emit('STAT', 1, '/exists.txt');
    const success = actHandler.mock.calls.find(([a]: any[]) => a.action === 'STAT');
    expect(success).toBeDefined();
    expect(success[0].success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Fixes 5 & 6: FTP CustomFileSystem canRead vs canList
// ══════════════════════════════════════════════════════════════════════════
describe('Fixes 5 & 6: FTP read() and get() use canRead, list() uses canList', () => {
  const FTP_LISTENER: Listener = { id: 1, name: 'FTP', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: true };
  const FTP_USER: User = { id: 1, username: 'u', password: 'h', passwordEnabled: true, publicKey: '', guiEnabled: false, createdAt: '' };

  function makeFs(perm: Permission, vps: VirtualPath[]) {
    const conn = { ip: '127.0.0.1', on: jest.fn(), close: jest.fn() };
    const logCb = jest.fn();
    return {
      cfs: new CustomFileSystem(conn, { root: '/tmp', cwd: '/' },
        { getVirtualPaths: jest.fn().mockReturnValue(vps) } as any,
        FTP_USER, FTP_LISTENER, perm, vps, logCb),
      logCb
    };
  }

  beforeEach(() => jest.clearAllMocks());

  // read() —— formerly checked canList (wrong), now checks canRead (fix)
  test('read() allowed when canRead=true, canList=false', async () => {
    const perm = { ...FULL_PERM, canRead: true, canList: false };
    const vp = { ...FULL_VP, canRead: true, canList: false };
    const { cfs, logCb } = makeFs(perm, [vp]);
    (fs.createReadStream as jest.Mock).mockReturnValue({ on: jest.fn().mockReturnThis() });
    await expect(cfs.read('/file.txt')).resolves.toHaveProperty('stream');
    expect(logCb).toHaveBeenCalledWith('READ', '/file.txt', true);
  });

  test('read() denied when canRead=false even if canList=true', async () => {
    const perm = { ...FULL_PERM, canRead: false, canList: true };
    const vp = { ...FULL_VP, canRead: false, canList: true };
    const { cfs, logCb } = makeFs(perm, [vp]);
    await expect(cfs.read('/file.txt')).rejects.toThrow('Permission denied');
    expect(logCb).toHaveBeenCalledWith('READ_DENIED', '/file.txt', false);
  });

  // get() —— formerly checked canList (wrong), now checks canRead (fix)
  test('get() allowed when canRead=true, canList=false', async () => {
    const perm = { ...FULL_PERM, canRead: true, canList: false };
    const vp = { ...FULL_VP, canRead: true, canList: false };
    const { cfs, logCb } = makeFs(perm, [vp]);
    await expect(cfs.get('/file.txt')).resolves.toBeDefined();
    expect(logCb).toHaveBeenCalledWith('GET', '/file.txt', true);
  });

  test('get() denied when canRead=false even if canList=true', async () => {
    const perm = { ...FULL_PERM, canRead: false, canList: true };
    const vp = { ...FULL_VP, canRead: false, canList: true };
    const { cfs, logCb } = makeFs(perm, [vp]);
    await expect(cfs.get('/file.txt')).rejects.toThrow('Permission denied');
    expect(logCb).toHaveBeenCalledWith('GET_DENIED', '/file.txt', false);
  });

  // list() —— unchanged, still correctly checks canList
  test('list() allowed when canList=true, canRead=false', async () => {
    const perm = { ...FULL_PERM, canRead: false, canList: true };
    const vp = { ...FULL_VP, canRead: false, canList: true };
    const { cfs, logCb } = makeFs(perm, [vp]);
    await expect(cfs.list('/')).resolves.toBeDefined();
    expect(logCb).toHaveBeenCalledWith('LIST', '/', true);
  });

  test('list() denied when canList=false even if canRead=true', async () => {
    const perm = { ...FULL_PERM, canRead: true, canList: false };
    const vp = { ...FULL_VP, canRead: true, canList: false };
    const { cfs } = makeFs(perm, [vp]);
    await expect(cfs.list('/')).rejects.toThrow('Permission denied');
  });
});
