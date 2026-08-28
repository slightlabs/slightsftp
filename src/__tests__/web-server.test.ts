import request from 'supertest';
import * as crypto from 'crypto';
import { WebServer } from '../web-server';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import express from 'express';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// Prevent real file-system reads for HTML files
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    readFileSync: jest.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && (p.endsWith('.html') || p.endsWith('.js'))) {
        return '<html><body><script src="renderer.js"></script></body></html>';
      }
      return real.readFileSync(p, enc);
    }),
    existsSync: jest.fn(() => true),
    readdirSync: jest.fn(() => ['file.txt']),
    statSync: jest.fn((p: string) => {
      // Treat paths without extension as directories; files have extensions
      const isDir = !p.includes('.');
      return { isDirectory: () => isDir, isFile: () => !isDir, size: 100, mtime: new Date() };
    }),
  };
});

const PASSWORD = 'Secret123!';
const PASSWORD_HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');

const ADMIN_USER = {
  id: 1, username: 'admin', password: PASSWORD_HASH,
  passwordEnabled: true, publicKey: '', guiEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const SAMPLE_LISTENER = {
  id: 1, name: 'SFTP Main', protocol: 'SFTP',
  bindingIp: '0.0.0.0', port: 22, enabled: true, createdAt: ''
};

describe('WebServer REST API', () => {
  let webServer: WebServer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSM: jest.Mocked<ServerManager>;
  let app: express.Application;

  beforeEach(() => {
    mockDb = {
      getUser: jest.fn().mockReturnValue(ADMIN_USER),
      getAllUsers: jest.fn().mockReturnValue([ADMIN_USER]),
      createUser: jest.fn().mockReturnValue(2),
      updateUser: jest.fn(),
      deleteUser: jest.fn(),
      verifyPassword: jest.fn().mockReturnValue(true),
      getAllListeners: jest.fn().mockReturnValue([SAMPLE_LISTENER]),
      getListener: jest.fn().mockReturnValue(SAMPLE_LISTENER),
      createListener: jest.fn().mockReturnValue(2),
      updateListener: jest.fn(),
      deleteListener: jest.fn(),
      getUserListeners: jest.fn().mockReturnValue([1]),
      subscribeUserToListener: jest.fn(),
      unsubscribeUserFromListener: jest.fn(),
      getVirtualPaths: jest.fn().mockReturnValue([]),
      addVirtualPath: jest.fn(),
      deleteVirtualPath: jest.fn(),
      getPermission: jest.fn().mockReturnValue(null),
      setPermission: jest.fn(),
      getUserPermissions: jest.fn().mockReturnValue([]),
      getRecentActivities: jest.fn().mockReturnValue([]),
      getActivityCount: jest.fn().mockReturnValue(0),
      clearActivitiesByDate: jest.fn(),
      clearAllActivities: jest.fn(),
      logActivity: jest.fn(),
    } as any;

    mockSM = {
      getActiveSessions: jest.fn().mockReturnValue([]),
      disconnectSession: jest.fn().mockReturnValue(false),
      isListenerRunning: jest.fn().mockReturnValue(false),
      startListener: jest.fn().mockResolvedValue(undefined),
      stopListener: jest.fn().mockResolvedValue(undefined),
      restartListener: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(), off: jest.fn(), emit: jest.fn(),
    } as any;

    webServer = new WebServer(mockDb, mockSM, 0);
    app = webServer.getApp();
  });

  afterEach(() => jest.clearAllMocks());

  // ── helper to obtain an auth cookie ───────────────────────────────────────
  async function getAuthCookie(): Promise<string> {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: PASSWORD });
    const raw = res.headers['set-cookie'];
    return Array.isArray(raw) ? raw[0] : raw ?? '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Authentication', () => {
    test('POST /api/login — success sets sessionId cookie', async () => {
      const res = await request(app).post('/api/login')
        .send({ username: 'admin', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    test('POST /api/login — wrong password → 401', async () => {
      mockDb.getUser.mockReturnValueOnce({ ...ADMIN_USER, password: 'different' });
      const res = await request(app).post('/api/login')
        .send({ username: 'admin', password: 'wrong' });
      expect(res.status).toBe(401);
    });

    test('POST /api/login — unknown user → 401', async () => {
      mockDb.getUser.mockReturnValue(undefined as any);
      const res = await request(app).post('/api/login')
        .send({ username: 'ghost', password: 'x' });
      expect(res.status).toBe(401);
    });

    test('POST /api/login — GUI disabled → 403', async () => {
      mockDb.getUser.mockReturnValueOnce({ ...ADMIN_USER, guiEnabled: false });
      const res = await request(app).post('/api/login')
        .send({ username: 'admin', password: PASSWORD });
      expect(res.status).toBe(403);
    });

    test('POST /api/login — missing password → 401', async () => {
      mockDb.getUser.mockReturnValueOnce({ ...ADMIN_USER, password: '' });
      const res = await request(app).post('/api/login')
        .send({ username: 'admin', password: '' });
      expect(res.status).toBe(401);
    });

    test('POST /api/logout — clears session', async () => {
      const cookie = await getAuthCookie();
      const res = await request(app).post('/api/logout').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('GET /api/user — returns username when authenticated', async () => {
      const cookie = await getAuthCookie();
      const res = await request(app).get('/api/user').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('admin');
    });

    test('GET /api/* without auth → 401', async () => {
      const res = await request(app).get('/api/listeners');
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Listeners API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/listeners — returns array', async () => {
      const res = await request(app).get('/api/listeners').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/listeners/:id — returns listener', async () => {
      const res = await request(app).get('/api/listeners/1').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(1);
    });

    test('GET /api/listeners/:id — 404 for missing', async () => {
      mockDb.getListener.mockReturnValue(undefined);
      const res = await request(app).get('/api/listeners/999').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('POST /api/listeners — creates listener', async () => {
      const res = await request(app).post('/api/listeners').set('Cookie', cookie)
        .send({ name: 'FTP', protocol: 'FTP', bindingIp: '0.0.0.0', port: 21, enabled: false });
      expect(res.status).toBe(200);
      expect(mockDb.createListener).toHaveBeenCalled();
    });

    test('PUT /api/listeners/:id — updates listener', async () => {
      const res = await request(app).put('/api/listeners/1').set('Cookie', cookie)
        .send({ name: 'Updated', bindingIp: '0.0.0.0', port: 22, enabled: true });
      expect(res.status).toBe(200);
      expect(mockDb.updateListener).toHaveBeenCalled();
    });

    test('PUT /api/listeners/:id — 404 for missing', async () => {
      mockDb.getListener.mockReturnValue(undefined);
      const res = await request(app).put('/api/listeners/999').set('Cookie', cookie)
        .send({ name: 'X' });
      expect(res.status).toBe(404);
    });

    test('DELETE /api/listeners/:id — deletes listener', async () => {
      const res = await request(app).delete('/api/listeners/1').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockDb.deleteListener).toHaveBeenCalled();
    });

    test('POST /api/listeners/:id/start — starts listener', async () => {
      const res = await request(app).post('/api/listeners/1/start').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockSM.startListener).toHaveBeenCalledWith(1);
    });

    test('POST /api/listeners/:id/stop — stops listener', async () => {
      const res = await request(app).post('/api/listeners/1/stop').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockSM.stopListener).toHaveBeenCalledWith(1);
    });

    test('POST /api/listeners/:id/restart — restarts listener', async () => {
      const res = await request(app).post('/api/listeners/1/restart').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockSM.restartListener).toHaveBeenCalledWith(1);
    });

    test('GET /api/listener-statuses — includes Web GUI entry', async () => {
      const res = await request(app).get('/api/listener-statuses').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const webEntry = res.body.find((s: any) => s.listener?.id === -1);
      expect(webEntry).toBeDefined();
      expect(webEntry.running).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Users API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/users — returns array', async () => {
      const res = await request(app).get('/api/users').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/users/:username — returns user', async () => {
      const res = await request(app).get('/api/users/admin').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('admin');
    });

    test('GET /api/users/:username — 404 for missing', async () => {
      mockDb.getUser.mockReturnValueOnce(undefined as any);
      const res = await request(app).get('/api/users/nobody').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('POST /api/users — creates user and hashes password', async () => {
      const res = await request(app).post('/api/users').set('Cookie', cookie)
        .send({ username: 'newuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      expect(res.status).toBe(200);
      expect(mockDb.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'newuser', password: expect.not.stringContaining('pass') })
      );
    });

    test('PUT /api/users/:username — updates and hashes password', async () => {
      const res = await request(app).put('/api/users/admin').set('Cookie', cookie)
        .send({ password: 'newPass', passwordEnabled: true, guiEnabled: true });
      expect(res.status).toBe(200);
      expect(mockDb.updateUser).toHaveBeenCalledWith(
        'admin', expect.objectContaining({ password: expect.not.stringContaining('newPass') })
      );
    });

    test('PUT /api/users/:username — no password field does not hash', async () => {
      const res = await request(app).put('/api/users/admin').set('Cookie', cookie)
        .send({ passwordEnabled: true, guiEnabled: true });
      expect(res.status).toBe(200);
      const updateArg = (mockDb.updateUser as jest.Mock).mock.calls[0][1];
      expect(updateArg.password).toBeUndefined();
    });

    test('DELETE /api/users/:username — deletes user', async () => {
      const res = await request(app).delete('/api/users/admin').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockDb.deleteUser).toHaveBeenCalledWith('admin');
    });

    test('GET /api/users/id/:userId/listeners — returns listener ids', async () => {
      const res = await request(app).get('/api/users/id/1/listeners').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Subscriptions API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/users/:username/subscriptions — returns array', async () => {
      const res = await request(app).get('/api/users/admin/subscriptions').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/users/:username/subscriptions — 404 for missing user', async () => {
      mockDb.getUser.mockReturnValueOnce(undefined as any);
      const res = await request(app).get('/api/users/ghost/subscriptions').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('POST /api/users/:username/subscriptions — subscribes user', async () => {
      const res = await request(app).post('/api/users/admin/subscriptions').set('Cookie', cookie)
        .send({ listenerId: 1 });
      expect(res.status).toBe(200);
      expect(mockDb.subscribeUserToListener).toHaveBeenCalled();
    });

    test('DELETE /api/users/:username/subscriptions/:id — unsubscribes user', async () => {
      const res = await request(app).delete('/api/users/admin/subscriptions/1').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockDb.unsubscribeUserFromListener).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Virtual Paths API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/users/:username/virtual-paths — returns array', async () => {
      const res = await request(app).get('/api/users/admin/virtual-paths').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/users/:username/virtual-paths — 404 for missing user', async () => {
      mockDb.getUser.mockReturnValueOnce(undefined as any);
      const res = await request(app).get('/api/users/ghost/virtual-paths').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('POST /api/users/:username/virtual-paths — adds path', async () => {
      const vp = {
        virtualPath: '/uploads', localPath: '/srv/uploads',
        canRead: true, canWrite: true, canAppend: true, canDelete: false,
        canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true
      };
      const res = await request(app).post('/api/users/admin/virtual-paths').set('Cookie', cookie)
        .send(vp);
      expect(res.status).toBe(200);
      expect(mockDb.addVirtualPath).toHaveBeenCalled();
    });

    test('DELETE /api/users/:username/virtual-paths/:id — removes path', async () => {
      const res = await request(app).delete('/api/users/admin/virtual-paths/1').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(mockDb.deleteVirtualPath).toHaveBeenCalledWith(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Activity Logs API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/activity — returns array', async () => {
      const res = await request(app).get('/api/activity').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/activity?limit=50 — passes limit to db', async () => {
      await request(app).get('/api/activity?limit=50').set('Cookie', cookie);
      expect(mockDb.getRecentActivities).toHaveBeenCalledWith(undefined, 50);
    });

    test('DELETE /api/activity — clears all when no beforeDate', async () => {
      const res = await request(app).delete('/api/activity').set('Cookie', cookie).send({});
      expect(res.status).toBe(200);
      expect(mockDb.clearAllActivities).toHaveBeenCalled();
    });

    test('DELETE /api/activity — clears by date when beforeDate provided', async () => {
      const res = await request(app).delete('/api/activity').set('Cookie', cookie)
        .send({ beforeDate: '2026-01-01' });
      expect(res.status).toBe(200);
      expect(mockDb.clearActivitiesByDate).toHaveBeenCalledWith('2026-01-01');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('Sessions API', () => {
    let cookie: string;
    beforeEach(async () => { cookie = await getAuthCookie(); });

    test('GET /api/sessions — returns array', async () => {
      const res = await request(app).get('/api/sessions').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('DELETE /api/sessions/:id — 404 when not found', async () => {
      mockSM.disconnectSession.mockReturnValue(false);
      const res = await request(app).delete('/api/sessions/ghost').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('DELETE /api/sessions/:id — 200 when found', async () => {
      mockSM.disconnectSession.mockReturnValue(true);
      const res = await request(app).delete('/api/sessions/s1').set('Cookie', cookie);
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('File Browser API', () => {
    let cookie: string;
    beforeEach(async () => {
      cookie = await getAuthCookie();
      mockDb.getVirtualPaths.mockReturnValue([{
        id: 1, userId: 1, virtualPath: '/', localPath: '/tmp',
        canRead: true, canWrite: false, canAppend: false, canDelete: false,
        canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true
      }]);
    });

    test('GET /api/files/browse — returns files list', async () => {
      const res = await request(app).get('/api/files/browse?username=admin&path=/').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('files');
    });

    test('GET /api/files/browse — 400 without username', async () => {
      const res = await request(app).get('/api/files/browse?path=/').set('Cookie', cookie);
      expect(res.status).toBe(400);
    });

    test('GET /api/files/browse — 404 for unknown user', async () => {
      mockDb.getUser.mockReturnValueOnce(undefined as any);
      const res = await request(app).get('/api/files/browse?username=ghost&path=/').set('Cookie', cookie);
      expect(res.status).toBe(404);
    });

    test('GET /api/files/browse — 403 when no matching virtual path', async () => {
      mockDb.getVirtualPaths.mockReturnValue([]);
      const res = await request(app).get('/api/files/browse?username=admin&path=/secret').set('Cookie', cookie);
      expect(res.status).toBe(403);
    });
  });
});
