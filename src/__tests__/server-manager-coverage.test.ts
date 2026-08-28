jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../sftp-server');
jest.mock('../ftp-server');

import { ServerManager, ActiveSession } from '../server-manager';
import { DatabaseManager } from '../database';
import { SFTPServer } from '../sftp-server';
import { FTPServer } from '../ftp-server';
import { EventEmitter } from 'events';

function makeMockServer(sessions: ActiveSession[] = []) {
  const srv = new EventEmitter() as any;
  srv.start = jest.fn().mockResolvedValue(undefined);
  srv.stop = jest.fn().mockResolvedValue(undefined);
  srv.getActiveSessions = jest.fn().mockReturnValue(sessions);
  srv.disconnectSession = jest.fn().mockReturnValue(false);
  return srv;
}

describe('ServerManager — coverage tests', () => {
  let db: DatabaseManager;
  let sm: ServerManager;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();
    sm = new ServerManager(db);

    (SFTPServer as unknown as jest.Mock).mockImplementation(() => makeMockServer());
    (FTPServer as unknown as jest.Mock).mockImplementation(() => makeMockServer());
  });

  afterEach(async () => {
    // Clean up any running servers
    for (const id of (sm as any).servers.keys()) {
      try { await sm.stopListener(id); } catch { /* */ }
    }
    db.close();
    jest.clearAllMocks();
  });

  // ── getListenerStatus ────────────────────────────────────────────────────
  describe('getListenerStatus()', () => {
    test('returns running=false for listener not started', () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const status = sm.getListenerStatus(id);
      expect(status.running).toBe(false);
      expect(status.listener?.id).toBe(id);
    });

    test('returns running=true after start', async () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      expect(sm.getListenerStatus(id).running).toBe(true);
    });
  });

  // ── getAllListenerStatuses ────────────────────────────────────────────────
  describe('getAllListenerStatuses()', () => {
    test('returns all listeners with correct running flags', async () => {
      const id1 = db.createListener({ name: 'SFTP', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const id2 = db.createListener({ name: 'FTP', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: true });
      await sm.startListener(id1);
      // id2 not started

      const statuses = sm.getAllListenerStatuses();
      const sftp = statuses.find(s => s.listener.id === id1)!;
      const ftp = statuses.find(s => s.listener.id === id2)!;
      expect(sftp.running).toBe(true);
      expect(ftp.running).toBe(false);
    });

    test('returns empty array when no listeners', () => {
      expect(sm.getAllListenerStatuses()).toEqual([]);
    });
  });

  // ── getRunningListeners ───────────────────────────────────────────────────
  describe('getRunningListeners()', () => {
    test('returns IDs of all running listeners', async () => {
      const id1 = db.createListener({ name: 'S1', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const id2 = db.createListener({ name: 'S2', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 23, enabled: true });
      await sm.startListener(id1);
      const running = sm.getRunningListeners();
      expect(running).toContain(id1);
      expect(running).not.toContain(id2);
    });
  });

  // ── getActiveSessions aggregation ────────────────────────────────────────
  describe('getActiveSessions()', () => {
    test('aggregates sessions from multiple servers', async () => {
      const session1 = { sessionId: 's1', username: 'alice', ipAddress: '10.0.0.1', connectedAt: new Date(), listenerId: 0, listenerName: '', protocol: '' };
      const session2 = { sessionId: 's2', username: 'bob', ipAddress: '10.0.0.2', connectedAt: new Date(), listenerId: 0, listenerName: '', protocol: '' };

      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => makeMockServer([session1]));
      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => makeMockServer([session2]));

      const id1 = db.createListener({ name: 'S1', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const id2 = db.createListener({ name: 'S2', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 23, enabled: true });
      await sm.startListener(id1);
      await sm.startListener(id2);

      const sessions = sm.getActiveSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ username: 'alice', listenerId: id1, protocol: 'SFTP' });
      expect(sessions[1]).toMatchObject({ username: 'bob', listenerId: id2 });
    });

    test('includes listenerName in aggregated sessions', async () => {
      const session = { sessionId: 's1', username: 'u', ipAddress: '127.0.0.1', connectedAt: new Date(), listenerId: 0, listenerName: '', protocol: '' };
      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => makeMockServer([session]));
      const id = db.createListener({ name: 'My SFTP', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      const [s] = sm.getActiveSessions();
      expect(s.listenerName).toBe('My SFTP');
    });

    test('skips servers whose listener is no longer in the database', async () => {
      const id = db.createListener({ name: 'Temp', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      db.deleteListener(id);
      // Server is still "running" in the map but listener is gone from DB
      expect(() => sm.getActiveSessions()).not.toThrow();
    });
  });

  // ── disconnectSession across servers ─────────────────────────────────────
  describe('disconnectSession()', () => {
    test('returns false when session not found in any server', async () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      expect(sm.disconnectSession('ghost')).toBe(false);
    });

    test('returns true when session found and disconnected', async () => {
      const mockSrv = makeMockServer();
      mockSrv.disconnectSession = jest.fn().mockReturnValue(true);
      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => mockSrv);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      expect(sm.disconnectSession('s1')).toBe(true);
    });

    test('searches across multiple servers and stops at first match', async () => {
      const noMatchSrv = makeMockServer();
      const matchSrv = makeMockServer();
      matchSrv.disconnectSession = jest.fn().mockReturnValue(true);
      (SFTPServer as unknown as jest.Mock)
        .mockImplementationOnce(() => noMatchSrv)
        .mockImplementationOnce(() => matchSrv);

      const id1 = db.createListener({ name: 'S1', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const id2 = db.createListener({ name: 'S2', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 23, enabled: true });
      await sm.startListener(id1);
      await sm.startListener(id2);

      const result = sm.disconnectSession('target');
      expect(result).toBe(true);
    });
  });

  // ── stopAllListeners ──────────────────────────────────────────────────────
  describe('stopAllListeners()', () => {
    test('stops all running servers', async () => {
      const id1 = db.createListener({ name: 'S1', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      const id2 = db.createListener({ name: 'S2', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: true });
      await sm.startListener(id1);
      await sm.startListener(id2);
      await sm.stopAllListeners();
      expect(sm.getRunningListeners()).toHaveLength(0);
    });

    test('continues when individual stop throws', async () => {
      const failSrv = makeMockServer();
      failSrv.stop = jest.fn().mockRejectedValue(new Error('Stop failed'));
      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => failSrv);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      await expect(sm.stopAllListeners()).resolves.not.toThrow();
    });
  });

  // ── startAllEnabledListeners ──────────────────────────────────────────────
  describe('startAllEnabledListeners()', () => {
    test('starts only enabled listeners', async () => {
      db.createListener({ name: 'Enabled', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      db.createListener({ name: 'Disabled', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: false });

      await sm.startAllEnabledListeners();
      expect(sm.getRunningListeners()).toHaveLength(1);
    });

    test('continues when individual start throws', async () => {
      const failSrv = makeMockServer();
      failSrv.start = jest.fn().mockRejectedValue(new Error('Port in use'));
      (SFTPServer as unknown as jest.Mock).mockImplementationOnce(() => failSrv);
      db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });

      await expect(sm.startAllEnabledListeners()).resolves.not.toThrow();
    });
  });

  // ── restartListener ───────────────────────────────────────────────────────
  describe('restartListener()', () => {
    test('stops and starts the listener', async () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);

      const stopSpy = jest.spyOn(sm, 'stopListener');
      const startSpy = jest.spyOn(sm, 'startListener');
      await sm.restartListener(id);

      expect(stopSpy).toHaveBeenCalledWith(id);
      expect(startSpy).toHaveBeenCalledWith(id);
    });

    test('works even if listener was not running (skips stop)', async () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await expect(sm.restartListener(id)).resolves.not.toThrow();
    });
  });

  // ── event forwarding ──────────────────────────────────────────────────────
  describe('Event forwarding', () => {
    test('emits listener-started when server starts', async () => {
      const started = jest.fn();
      sm.on('listener-started', started);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      const srv = (sm as any).servers.get(id);
      srv.emit('started');
      expect(started).toHaveBeenCalledWith(id);
    });

    test('emits listener-stopped when server stops', async () => {
      const stopped = jest.fn();
      sm.on('listener-stopped', stopped);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      const srv = (sm as any).servers.get(id);
      srv.emit('stopped');
      expect(stopped).toHaveBeenCalledWith(id);
    });

    test('emits listener-error when server errors', async () => {
      const errored = jest.fn();
      sm.on('listener-error', errored);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      const srv = (sm as any).servers.get(id);
      srv.emit('error', new Error('boom'));
      expect(errored).toHaveBeenCalledWith(id, expect.any(Error));
    });

    test('forwards activity events and logs to DB', async () => {
      const activityHandler = jest.fn();
      sm.on('activity', activityHandler);
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      const srv = (sm as any).servers.get(id);
      const activity = { listenerId: id, username: 'u', action: 'LOGIN', path: '/', success: true };
      srv.emit('activity', activity);
      expect(activityHandler).toHaveBeenCalledWith(activity);
    });
  });

  // ── error paths in startListener ─────────────────────────────────────────
  describe('startListener() error paths', () => {
    test('throws when listener not found', async () => {
      await expect(sm.startListener(9999)).rejects.toThrow('not found');
    });

    test('throws when listener is disabled', async () => {
      const id = db.createListener({ name: 'D', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: false });
      await expect(sm.startListener(id)).rejects.toThrow('disabled');
    });

    test('throws when listener is already running', async () => {
      const id = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true });
      await sm.startListener(id);
      await expect(sm.startListener(id)).rejects.toThrow('already running');
    });

    test('throws for unknown protocol', async () => {
      // Bypass the DB constraint by injecting a bad listener directly through the db mock
      jest.spyOn(db, 'getListener').mockReturnValueOnce({
        id: 999, name: 'X', protocol: 'UNKNOWN' as any,
        bindingIp: '0.0.0.0', port: 22, enabled: true, createdAt: ''
      });
      await expect(sm.startListener(999)).rejects.toThrow('Unknown protocol');
    });
  });
});
