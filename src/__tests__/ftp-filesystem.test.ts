jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// Provide a real-ish FileSystem base so CustomFileSystem can extend it properly
jest.mock('ftp-srv', () => {
  class FileSystem {
    cwd: string = '/';
    root: string = '/tmp';
    constructor(_conn: any, options: any = {}) {
      this.cwd = options.cwd || '/';
      this.root = options.root || '/tmp';
    }
    get(_p: string) { return Promise.resolve({ size: 0, mtime: new Date(), isDirectory: () => false, isFile: () => true }); }
    list(_p: string) { return Promise.resolve([]); }
  }
  const FtpSrvMock = jest.fn().mockImplementation(() => {
    const { EventEmitter } = require('events');
    const em = new EventEmitter();
    em.listen = jest.fn().mockResolvedValue(undefined);
    em.close = jest.fn().mockResolvedValue(undefined);
    return em;
  });
  return { default: FtpSrvMock, FileSystem };
});

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    stat: jest.fn(),
    rmdir: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn(),
    rename: jest.fn(),
    chmod: jest.fn(),
    createWriteStream: jest.fn(),
    createReadStream: jest.fn(),
    promises: { ...real.promises, stat: jest.fn(), readdir: jest.fn() },
  };
});

import { CustomFileSystem } from '../ftp-server';
import * as fs from 'fs';
import { DatabaseManager } from '../database';
import { Listener, User, Permission, VirtualPath } from '../types';

const PERM_FULL: Permission = {
  userId: 1, listenerId: 1, canRead: true, canCreate: true, canEdit: true,
  canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true
};

const PERM_NONE: Permission = {
  userId: 1, listenerId: 1, canRead: false, canCreate: false, canEdit: false,
  canAppend: false, canDelete: false, canList: false, canCreateDir: false, canRename: false
};

const VP_ROOT: VirtualPath = {
  id: 1, userId: 1, virtualPath: '/', localPath: '/srv/ftp',
  canRead: true, canWrite: true, canAppend: true, canDelete: true,
  canList: true, canCreateDir: true, canRename: true, applyToSubdirs: true
};

const VP_READONLY: VirtualPath = {
  id: 2, userId: 1, virtualPath: '/readonly', localPath: '/srv/readonly',
  canRead: true, canWrite: false, canAppend: false, canDelete: false,
  canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true
};

const LISTENER: Listener = { id: 1, name: 'FTP', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: true };
const USER: User = { id: 1, username: 'alice', password: 'hash', passwordEnabled: true, publicKey: '', guiEnabled: false, createdAt: '' };

function makeMockDb() {
  return { getVirtualPaths: jest.fn().mockReturnValue([VP_ROOT]) } as any;
}

function makeFs(virtualPaths = [VP_ROOT], perm = PERM_FULL) {
  const conn = { ip: '127.0.0.1', on: jest.fn(), close: jest.fn() };
  const opts = { root: '/srv/ftp', cwd: '/' };
  const logCb = jest.fn();
  return { cfs: new CustomFileSystem(conn, opts, makeMockDb(), USER, LISTENER, perm, virtualPaths, logCb), logCb };
}

describe('CustomFileSystem', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── path mapping ──────────────────────────────────────────────────────────
  describe('_resolvePath()', () => {
    test('maps virtual path to local path', () => {
      const { cfs } = makeFs();
      const r = cfs._resolvePath('/uploads');
      expect(r.clientPath).toBe('/uploads');
      expect(r.fsPath).toContain('/srv/ftp');
    });

    test('absolute path already in virtual path is returned as-is', () => {
      const { cfs } = makeFs();
      const r = cfs._resolvePath('/srv/ftp/file.txt');
      expect(r.fsPath).toBe('/srv/ftp/file.txt');
    });

    test('uses first virtual path as default', () => {
      const { cfs } = makeFs([VP_ROOT]);
      const r = cfs._resolvePath('/unknown/path');
      expect(r.fsPath).toContain('/srv/ftp');
    });
  });

  // ── permission checks ─────────────────────────────────────────────────────
  describe('Permission enforcement', () => {
    test('get() denies when canList is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.get('/file.txt')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('GET_DENIED', '/file.txt', false);
    });

    test('get() allows and maps path when canList is true', async () => {
      const { cfs } = makeFs([VP_ROOT], PERM_FULL);
      (fs as any).promises.stat.mockResolvedValue({ isDirectory: () => false, isFile: () => true, size: 10, mtime: new Date() });
      await cfs.get('/file.txt');
    });

    test('list() denies when canList is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.list('/')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('LIST_DENIED', '/', false);
    });

    test('list() allows when canList is true', async () => {
      const { cfs } = makeFs();
      await cfs.list('/');
    });

    test('write() denies when canCreate and canEdit both false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.write('/newfile.txt')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('WRITE_DENIED', '/newfile.txt', false);
    });

    test('write() allows when canCreate is true', async () => {
      const { cfs, logCb } = makeFs();
      const mockStream = { on: jest.fn().mockReturnThis(), write: jest.fn() };
      (fs.createWriteStream as jest.Mock).mockReturnValue(mockStream);
      const result = await cfs.write('/file.txt');
      expect(result).toHaveProperty('stream');
      expect(logCb).toHaveBeenCalledWith('WRITE', '/file.txt', true);
    });

    test('read() denies when canList is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.read('/file.txt')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('READ_DENIED', '/file.txt', false);
    });

    test('read() allows when canList is true', async () => {
      const { cfs, logCb } = makeFs();
      const mockStream = { on: jest.fn().mockReturnThis() };
      (fs.createReadStream as jest.Mock).mockReturnValue(mockStream);
      const result = await cfs.read('/file.txt');
      expect(result).toHaveProperty('stream');
      expect(logCb).toHaveBeenCalledWith('READ', '/file.txt', true);
    });

    test('delete() denies when canDelete is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.delete('/file.txt')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('DELETE_DENIED', '/file.txt', false);
    });

    test('mkdir() denies when canCreateDir is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.mkdir('/newdir')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('MKDIR_DENIED', '/newdir', false);
    });

    test('rename() denies when canRename is false', async () => {
      const { cfs, logCb } = makeFs([VP_ROOT], PERM_NONE);
      await expect(cfs.rename('/a', '/b')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('RENAME_DENIED', '/a -> /b', false);
    });

    test('virtual-path level read-only blocks write even with full listener permissions', async () => {
      const { cfs, logCb } = makeFs([VP_READONLY], PERM_FULL);
      await expect(cfs.write('/readonly/file.txt')).rejects.toThrow('Permission denied');
      expect(logCb).toHaveBeenCalledWith('WRITE_DENIED', '/readonly/file.txt', false);
    });
  });

  // ── file operation paths ──────────────────────────────────────────────────
  describe('File operations', () => {
    test('delete() unlinks a file', async () => {
      const { cfs, logCb } = makeFs();
      const statMock = jest.fn((_p: any, cb: any) => cb(null, { isDirectory: () => false }));
      const unlinkMock = jest.fn((_p: any, cb: any) => cb(null));
      (fs.stat as unknown as jest.Mock).mockImplementation(statMock);
      (fs.unlink as unknown as jest.Mock).mockImplementation(unlinkMock);
      await cfs.delete('/file.txt');
      expect(logCb).toHaveBeenCalledWith('DELETE', '/file.txt', true);
    });

    test('delete() rmdirs a directory', async () => {
      const { cfs } = makeFs();
      (fs.stat as unknown as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null, { isDirectory: () => true }));
      (fs.rmdir as unknown as jest.Mock).mockImplementation((_p: any, cb: any) => cb(null));
      await cfs.delete('/emptydir');
    });

    test('delete() propagates stat error', async () => {
      const { cfs, logCb } = makeFs();
      (fs.stat as unknown as jest.Mock).mockImplementation((_p: any, cb: any) => cb(new Error('ENOENT')));
      await expect(cfs.delete('/missing.txt')).rejects.toThrow('ENOENT');
      expect(logCb).toHaveBeenCalledWith('DELETE_FAILED', '/missing.txt', false);
    });

    test('mkdir() creates directory', async () => {
      const { cfs, logCb } = makeFs();
      (fs.mkdir as unknown as jest.Mock).mockImplementation((_p: any, _o: any, cb: any) => cb(null));
      await cfs.mkdir('/newdir');
      expect(logCb).toHaveBeenCalledWith('MKDIR', '/newdir', true);
    });

    test('mkdir() propagates error', async () => {
      const { cfs, logCb } = makeFs();
      (fs.mkdir as unknown as jest.Mock).mockImplementation((_p: any, _o: any, cb: any) => cb(new Error('EEXIST')));
      await expect(cfs.mkdir('/exists')).rejects.toThrow('EEXIST');
      expect(logCb).toHaveBeenCalledWith('MKDIR_FAILED', '/exists', false);
    });

    test('rename() renames file', async () => {
      const { cfs, logCb } = makeFs();
      (fs.rename as unknown as jest.Mock).mockImplementation((_a: any, _b: any, cb: any) => cb(null));
      await cfs.rename('/old.txt', '/new.txt');
      expect(logCb).toHaveBeenCalledWith('RENAME', '/old.txt -> /new.txt', true);
    });

    test('rename() propagates error', async () => {
      const { cfs, logCb } = makeFs();
      (fs.rename as unknown as jest.Mock).mockImplementation((_a: any, _b: any, cb: any) => cb(new Error('ENOENT')));
      await expect(cfs.rename('/missing.txt', '/new.txt')).rejects.toThrow('ENOENT');
      expect(logCb).toHaveBeenCalledWith('RENAME_FAILED', '/missing.txt -> /new.txt', false);
    });

    test('chmod() changes file permissions', async () => {
      const { cfs } = makeFs();
      (fs.chmod as unknown as jest.Mock).mockImplementation((_p: any, _m: any, cb: any) => cb(null));
      await cfs.chmod('/file.txt', '644');
    });

    test('chmod() propagates error', async () => {
      const { cfs } = makeFs();
      (fs.chmod as unknown as jest.Mock).mockImplementation((_p: any, _m: any, cb: any) => cb(new Error('EPERM')));
      await expect(cfs.chmod('/file.txt', '777')).rejects.toThrow('EPERM');
    });
  });
});
