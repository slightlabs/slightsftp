import { SFTPServer } from '../sftp-server';
import { DatabaseManager } from '../database';
import { Listener } from '../types';
import * as ssh2 from 'ssh2';
import { EventEmitter } from 'events';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('ssh2', () => {
  const actual = jest.requireActual('ssh2');
  return { ...actual, Server: jest.fn() };
});

jest.spyOn(SFTPServer.prototype as any, 'generateHostKeys').mockImplementation(() => {});

const TEST_LISTENER: Listener = {
  id: 1, name: 'Test SFTP', protocol: 'SFTP',
  bindingIp: '127.0.0.1', port: 12222, enabled: true
};

function makeMockSSHServer() {
  const srv = new EventEmitter() as any;
  srv.listen = jest.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); return srv; });
  srv.close = jest.fn((cb?: () => void) => { cb?.(); });
  return srv;
}

describe('SFTPServer', () => {
  let sftpServer: SFTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSSHSrv: ReturnType<typeof makeMockSSHServer>;

  beforeEach(() => {
    mockDb = {
      getUser: jest.fn(), getVirtualPaths: jest.fn().mockReturnValue([]),
      getPermission: jest.fn().mockReturnValue(null),
      getUserListeners: jest.fn().mockReturnValue([1]), logActivity: jest.fn(),
    } as any;
    mockSSHSrv = makeMockSSHServer();
    (ssh2.Server as unknown as jest.Mock).mockImplementation(() => mockSSHSrv);
    sftpServer = new SFTPServer(TEST_LISTENER, mockDb);
  });

  afterEach(() => jest.clearAllMocks());

  describe('Server Lifecycle', () => {
    test('start() resolves and emits started', async () => {
      const started = jest.fn();
      sftpServer.on('started', started);
      await sftpServer.start();
      expect(mockSSHSrv.listen).toHaveBeenCalledWith(12222, '127.0.0.1', expect.any(Function));
      expect(started).toHaveBeenCalled();
    });

    test('stop() resolves and emits stopped', async () => {
      await sftpServer.start();
      const stopped = jest.fn();
      sftpServer.on('stopped', stopped);
      await sftpServer.stop();
      expect(mockSSHSrv.close).toHaveBeenCalled();
      expect(stopped).toHaveBeenCalled();
    });

    test('stop() resolves without error when not started', async () => {
      await expect(sftpServer.stop()).resolves.toBeUndefined();
    });

    test('start() rejects when listen throws', async () => {
      const err = new Error('port in use');
      const errSrv = makeMockSSHServer();
      errSrv.listen = jest.fn().mockImplementation(() => { throw err; });
      (ssh2.Server as unknown as jest.Mock).mockImplementation(() => errSrv);
      const srv2 = new SFTPServer({ ...TEST_LISTENER, port: 12223 }, mockDb);
      await expect(srv2.start()).rejects.toThrow('port in use');
    });
  });

  describe('Session Management', () => {
    test('getActiveSessions() returns [] initially', () => {
      expect(sftpServer.getActiveSessions()).toEqual([]);
    });

    test('disconnectSession() returns false for unknown id', () => {
      expect(sftpServer.disconnectSession('ghost')).toBe(false);
    });

    test('disconnectSession() ends client and removes session', () => {
      const fakeClient = { end: jest.fn() };
      (sftpServer as any).activeSessions.set('s1', {
        client: fakeClient, username: 'u', ipAddress: '127.0.0.1', connectedAt: new Date()
      });
      expect(sftpServer.disconnectSession('s1')).toBe(true);
      expect(fakeClient.end).toHaveBeenCalled();
      expect(sftpServer.getActiveSessions()).toHaveLength(0);
    });

    test('getActiveSessions() returns all tracked sessions', () => {
      (sftpServer as any).activeSessions.set('s1', {
        client: {}, username: 'alice', ipAddress: '10.0.0.1', connectedAt: new Date()
      });
      (sftpServer as any).activeSessions.set('s2', {
        client: {}, username: 'bob', ipAddress: '10.0.0.2', connectedAt: new Date()
      });
      const sessions = sftpServer.getActiveSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ sessionId: expect.any(String), username: expect.any(String) });
    });
  });

  describe('Private utility methods', () => {
    test('convertSFTPFlags READ maps to r', () => {
      expect((sftpServer as any).convertSFTPFlags(0x1)).toContain('r');
    });

    test('convertSFTPFlags WRITE|CREAT|TRUNC maps to w', () => {
      expect((sftpServer as any).convertSFTPFlags(0x2 | 0x8 | 0x10)).toContain('w');
    });

    test('convertSFTPFlags WRITE|CREAT|APPEND maps to a', () => {
      expect((sftpServer as any).convertSFTPFlags(0x2 | 0x8 | 0x4)).toContain('a');
    });

    test('formatMode returns 10-char string for regular file', () => {
      const r: string = (sftpServer as any).formatMode(0o100644);
      expect(r).toHaveLength(10);
      expect(r[0]).toBe('-');
    });

    test('formatMode marks directory with d', () => {
      expect((sftpServer as any).formatMode(0o040755)[0]).toBe('d');
    });

    test('formatLongname includes filename', () => {
      const stat = {
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        size: 512, mtime: new Date(0), mode: 0o100644, uid: 0, gid: 0,
        nlink: 1, atime: new Date(0), birthtime: new Date(0), blksize: 512, blocks: 8,
        dev: 0, ino: 0, rdev: 0
      };
      expect((sftpServer as any).formatLongname('test.txt', stat)).toContain('test.txt');
    });
  });

  describe('Idle timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('resetIdleTimeout fires client.end after idleTimeoutMs', () => {
      const client = { end: jest.fn() };
      (sftpServer as any).idleTimeoutMs = 1000;
      (sftpServer as any).resetIdleTimeout(client, 'u');
      jest.advanceTimersByTime(1001);
      expect(client.end).toHaveBeenCalled();
    });

    test('resetIdleTimeout resets on repeated calls', () => {
      const client = { end: jest.fn() };
      (sftpServer as any).idleTimeoutMs = 1000;
      (sftpServer as any).resetIdleTimeout(client, 'u');
      jest.advanceTimersByTime(500);
      (sftpServer as any).resetIdleTimeout(client, 'u');
      jest.advanceTimersByTime(600);
      expect(client.end).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(client.end).toHaveBeenCalledTimes(1);
    });

    test('clearIdleTimeout prevents firing', () => {
      const client = { end: jest.fn() };
      (sftpServer as any).idleTimeoutMs = 1000;
      (sftpServer as any).resetIdleTimeout(client, 'u');
      (sftpServer as any).clearIdleTimeout(client);
      jest.advanceTimersByTime(2000);
      expect(client.end).not.toHaveBeenCalled();
    });
  });

  describe('Events', () => {
    test('forwards error events from ssh2 server', async () => {
      await sftpServer.start();
      const errHandler = jest.fn();
      sftpServer.on('error', errHandler);
      mockSSHSrv.emit('error', new Error('boom'));
      expect(errHandler).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
