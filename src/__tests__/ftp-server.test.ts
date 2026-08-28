import { FTPServer } from '../ftp-server';
import { DatabaseManager } from '../database';
import { Listener } from '../types';
import FtpSrv from 'ftp-srv';
import { EventEmitter } from 'events';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('ftp-srv');

const TEST_LISTENER: Listener = {
  id: 1, name: 'Test FTP', protocol: 'FTP',
  bindingIp: '127.0.0.1', port: 12121, enabled: true
};

function makeMockFtpSrv() {
  const emitter = new EventEmitter() as any;
  emitter.listen = jest.fn().mockResolvedValue(undefined);
  emitter.close = jest.fn().mockResolvedValue(undefined);
  return emitter;
}

describe('FTPServer', () => {
  let ftpServer: FTPServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockFtpSrv: ReturnType<typeof makeMockFtpSrv>;

  beforeEach(() => {
    mockDb = {
      getUser: jest.fn(),
      getVirtualPaths: jest.fn().mockReturnValue([]),
      getPermission: jest.fn().mockReturnValue(null),
      getUserListeners: jest.fn().mockReturnValue([1]),
      verifyPassword: jest.fn().mockReturnValue(true),
      logActivity: jest.fn(),
    } as any;

    mockFtpSrv = makeMockFtpSrv();
    (FtpSrv as unknown as jest.Mock).mockImplementation(() => mockFtpSrv);

    ftpServer = new FTPServer(TEST_LISTENER, mockDb);
  });

  afterEach(() => jest.clearAllMocks());

  describe('Server Lifecycle', () => {
    test('start() calls listen and emits started', async () => {
      const started = jest.fn();
      ftpServer.on('started', started);
      await ftpServer.start();
      expect(mockFtpSrv.listen).toHaveBeenCalled();
      expect(started).toHaveBeenCalled();
    });

    test('stop() resolves and emits stopped', async () => {
      await ftpServer.start();
      const stopped = jest.fn();
      ftpServer.on('stopped', stopped);
      await ftpServer.stop();
      expect(stopped).toHaveBeenCalled();
    });

    test('stop() resolves without error when not started', async () => {
      await expect(ftpServer.stop()).resolves.toBeUndefined();
    });

    test('start() rejects when listen fails', async () => {
      ftpServer.on('error', () => {}); // prevent unhandled error event
      const err = new Error('port in use');
      mockFtpSrv.listen = jest.fn().mockRejectedValue(err);
      await expect(ftpServer.start()).rejects.toThrow('port in use');
    });
  });

  describe('Session Management', () => {
    test('getActiveSessions() returns [] initially', () => {
      expect(ftpServer.getActiveSessions()).toEqual([]);
    });

    test('disconnectSession() returns false for unknown id', () => {
      expect(ftpServer.disconnectSession('ghost')).toBe(false);
    });

    test('disconnectSession() closes connection and returns true', () => {
      const fakeConn = { close: jest.fn() };
      (ftpServer as any).activeSessions.set('s1', {
        connection: fakeConn, username: 'u', ipAddress: '127.0.0.1', connectedAt: new Date()
      });
      expect(ftpServer.disconnectSession('s1')).toBe(true);
      expect(fakeConn.close).toHaveBeenCalled();
      expect(ftpServer.getActiveSessions()).toHaveLength(0);
    });

    test('getActiveSessions() returns shape with required fields', () => {
      (ftpServer as any).activeSessions.set('s1', {
        connection: {}, username: 'alice', ipAddress: '10.0.0.1', connectedAt: new Date()
      });
      const [s] = ftpServer.getActiveSessions();
      expect(s).toMatchObject({ sessionId: 's1', username: 'alice', ipAddress: '10.0.0.1' });
    });
  });

  describe('Login event handler — authentication paths', () => {
    function emitLogin(username: string, password: string) {
      const connection = { ip: '127.0.0.1', socket: { remotePort: 9999 }, on: jest.fn(), close: jest.fn() };
      const resolve = jest.fn();
      const reject = jest.fn();
      // Emit directly on the EventEmitter mock; the FTPServer registers its handler via .on('login')
      mockFtpSrv.emit('login', { connection, username, password }, resolve, reject);
      return { connection, resolve, reject };
    }

    beforeEach(async () => {
      await ftpServer.start();
    });

    test('valid credentials with virtual path sets up session', () => {
      const user = {
        id: 1, username: 'u', password: 'hash', passwordEnabled: true,
        publicKey: '', guiEnabled: true, createdAt: ''
      };
      mockDb.getUser.mockReturnValue(user);
      mockDb.getVirtualPaths.mockReturnValue([{
        id: 1, userId: 1, virtualPath: '/', localPath: '/tmp',
        canRead: true, canWrite: true, canAppend: true, canDelete: false,
        canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true
      }]);
      mockDb.verifyPassword.mockReturnValue(true);
      const { resolve, reject } = emitLogin('u', 'pass');
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ fs: expect.any(Object) }));
      expect(reject).not.toHaveBeenCalled();
    });

    test('unknown user → reject', () => {
      mockDb.getUser.mockReturnValue(undefined);
      const { resolve, reject } = emitLogin('nobody', 'x');
      expect(reject).toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    });

    test('user not subscribed to listener → reject', () => {
      const user = { id: 1, username: 'u', passwordEnabled: true, publicKey: '', guiEnabled: true, createdAt: '' };
      mockDb.getUser.mockReturnValue(user);
      mockDb.getUserListeners.mockReturnValue([99]);
      const { reject } = emitLogin('u', 'pass');
      expect(reject).toHaveBeenCalled();
    });

    test('invalid password → reject', () => {
      const user = { id: 1, username: 'u', passwordEnabled: true, publicKey: '', guiEnabled: true, createdAt: '' };
      mockDb.getUser.mockReturnValue(user);
      mockDb.getUserListeners.mockReturnValue([1]);
      mockDb.verifyPassword.mockReturnValue(false);
      const { reject } = emitLogin('u', 'bad');
      expect(reject).toHaveBeenCalled();
    });
  });

  describe('Events', () => {
    test('emits error when listen rejects', async () => {
      const err = new Error('fail');
      mockFtpSrv.listen = jest.fn().mockRejectedValue(err);
      const errHandler = jest.fn();
      ftpServer.on('error', errHandler);
      await ftpServer.start().catch(() => {});
      expect(errHandler).toHaveBeenCalledWith(err);
    });
  });
});
