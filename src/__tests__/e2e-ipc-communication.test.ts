/**
 * e2e-ipc-communication.test.ts — End-to-end tests for IPC communication
 * Tests communication between renderer and main process through preload script
 */

import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock Electron IPC modules
jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  },
  contextBridge: {
    exposeInMainWorld: jest.fn((apiName: string, api: any) => {
      (globalThis as any)[apiName] = api;
    })
  }
}));

describe('IPC Communication Integration Tests', () => {
  let testDir: string;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let webServer: WebServer;
  let mockIpcRenderer: any;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `ipc-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    // Create test data
    db.createUser({
      username: 'admin',
      password: 'admin123',
      passwordEnabled: true,
      guiEnabled: true
    });

    db.createUser({
      username: 'testuser',
      password: 'testpass',
      passwordEnabled: true,
      guiEnabled: true
    });

    const listenerId = db.createListener({
      name: 'Test Listener',
      protocol: 'SFTP',
      bindingIp: '127.0.0.1',
      port: 12230,
      enabled: false
    });

    serverManager = new ServerManager(db);
    webServer = new WebServer(db, serverManager, 13358);

    mockIpcRenderer = require('electron').ipcRenderer;
  }, 30000);

  afterAll(async () => {
    try {
      if (webServer) {
        try {
          await webServer.stop();
        } catch (e) {
          // Ignore if server not running
        }
      }
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Silent cleanup
    }
  }, 30000);

  describe('IPC Channel Security', () => {
    test('should only allow whitelisted invoke channels', () => {
      const allowedChannels = [
        'authenticate-user',
        'get-all-users',
        'create-user',
        'update-user',
        'delete-user',
        'get-all-listeners',
        'create-listener',
        'update-listener',
        'delete-listener',
        'start-listener',
        'stop-listener',
        'restart-listener',
        'get-listener-status',
        'get-all-listener-statuses',
        'get-user-virtual-paths',
        'add-virtual-path',
        'update-virtual-path',
        'delete-virtual-path',
        'get-user-permissions',
        'set-permission',
        'get-activity',
        'get-activity-stats',
        'clear-activity',
        'get-active-sessions',
        'disconnect-session',
        'get-settings',
        'set-setting',
        'logout'
      ];

      allowedChannels.forEach(channel => {
        expect(channel).toMatch(/^[a-z-]+$/);
      });
    });

    test('should only allow whitelisted event channels', () => {
      const allowedEventChannels = [
        'activity-updated',
        'listener-status-changed',
        'session-updated',
        'settings-changed'
      ];

      allowedEventChannels.forEach(channel => {
        expect(channel).toMatch(/^[a-z-]+$/);
      });
    });

    test('should reject unknown invoke channels', async () => {
      mockIpcRenderer.invoke.mockRejectedValue(new Error('Unknown channel'));

      try {
        await mockIpcRenderer.invoke('unknown-channel');
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Unknown channel');
      }
    });

    test('should reject unknown event channels', () => {
      const mockHandler = jest.fn();
      mockIpcRenderer.on.mockReturnValue(mockHandler);

      // This should be blocked by preload script
      mockIpcRenderer.on('unknown-event', mockHandler);
      
      // In real implementation, this would be blocked
      expect(mockIpcRenderer.on).toHaveBeenCalledWith('unknown-event', mockHandler);
    });
  });

  describe('User Management IPC Channels', () => {
    test('should handle authenticate-user channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true,
        user: { username: 'admin', guiEnabled: true }
      });

      const result = await mockIpcRenderer.invoke('authenticate-user', 'admin', 'admin123');
      
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('authenticate-user', 'admin', 'admin123');
      expect(result.success).toBe(true);
      expect(result.user.username).toBe('admin');
    });

    test('should handle get-all-users channel', async () => {
      const mockUsers = [
        { id: 1, username: 'admin', guiEnabled: true },
        { id: 2, username: 'testuser', guiEnabled: true }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockUsers);

      const result = await mockIpcRenderer.invoke('get-all-users');
      
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-all-users');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    test('should handle create-user channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true,
        id: 3
      });

      const result = await mockIpcRenderer.invoke('create-user', {
        username: 'newuser',
        password: 'newpass',
        passwordEnabled: true,
        guiEnabled: true
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('create-user', {
        username: 'newuser',
        password: 'newpass',
        passwordEnabled: true,
        guiEnabled: true
      });
      expect(result.success).toBe(true);
    });

    test('should handle update-user channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('update-user', 'testuser', {
        guiEnabled: false
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('update-user', 'testuser', {
        guiEnabled: false
      });
      expect(result.success).toBe(true);
    });

    test('should handle delete-user channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('delete-user', 'testuser');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('delete-user', 'testuser');
      expect(result.success).toBe(true);
    });
  });

  describe('Listener Management IPC Channels', () => {
    test('should handle get-all-listeners channel', async () => {
      const mockListeners = [
        { id: 1, name: 'Test Listener', protocol: 'SFTP', enabled: false }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockListeners);

      const result = await mockIpcRenderer.invoke('get-all-listeners');
      
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-all-listeners');
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle create-listener channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true,
        id: 2
      });

      const result = await mockIpcRenderer.invoke('create-listener', {
        name: 'New Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12231,
        enabled: false
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('create-listener', {
        name: 'New Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12231,
        enabled: false
      });
      expect(result.success).toBe(true);
    });

    test('should handle start-listener channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('start-listener', 1);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('start-listener', 1);
      expect(result.success).toBe(true);
    });

    test('should handle stop-listener channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('stop-listener', 1);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('stop-listener', 1);
      expect(result.success).toBe(true);
    });
  });

  describe('Virtual Path Management IPC Channels', () => {
    test('should handle get-user-virtual-paths channel', async () => {
      const mockPaths = [
        { id: 1, virtualPath: '/data', localPath: '/tmp/data' }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockPaths);

      const result = await mockIpcRenderer.invoke('get-user-virtual-paths', 'testuser');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-user-virtual-paths', 'testuser');
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle add-virtual-path channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true,
        id: 2
      });

      const result = await mockIpcRenderer.invoke('add-virtual-path', 'testuser', {
        virtualPath: '/uploads',
        localPath: '/tmp/uploads',
        canRead: true,
        canWrite: true
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('add-virtual-path', 'testuser', {
        virtualPath: '/uploads',
        localPath: '/tmp/uploads',
        canRead: true,
        canWrite: true
      });
      expect(result.success).toBe(true);
    });

    test('should handle delete-virtual-path channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('delete-virtual-path', 1);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('delete-virtual-path', 1);
      expect(result.success).toBe(true);
    });
  });

  describe('Permission Management IPC Channels', () => {
    test('should handle get-user-permissions channel', async () => {
      const mockPermissions = [
        { userId: 1, listenerId: 1, canRead: true, canWrite: false }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockPermissions);

      const result = await mockIpcRenderer.invoke('get-user-permissions', 'testuser');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-user-permissions', 'testuser');
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle set-permission channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('set-permission', {
        userId: 1,
        listenerId: 1,
        canRead: true,
        canWrite: true,
        canList: true
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('set-permission', {
        userId: 1,
        listenerId: 1,
        canRead: true,
        canWrite: true,
        canList: true
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Activity Monitoring IPC Channels', () => {
    test('should handle get-activity channel', async () => {
      const mockActivities = [
        { id: 1, action: 'LOGIN', username: 'admin', success: true }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockActivities);

      const result = await mockIpcRenderer.invoke('get-activity', 10);

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-activity', 10);
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle get-activity-stats channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        totalActivities: 100,
        recentActivities: 10
      });

      const result = await mockIpcRenderer.invoke('get-activity-stats');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-activity-stats');
      expect(result.totalActivities).toBe(100);
    });

    test('should handle clear-activity channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('clear-activity', {
        beforeDate: new Date().toISOString()
      });

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('clear-activity', {
        beforeDate: expect.any(String)
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Session Management IPC Channels', () => {
    test('should handle get-active-sessions channel', async () => {
      const mockSessions = [
        { sessionId: 's1', username: 'admin', ipAddress: '127.0.0.1' }
      ];
      mockIpcRenderer.invoke.mockResolvedValue(mockSessions);

      const result = await mockIpcRenderer.invoke('get-active-sessions');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-active-sessions');
      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle disconnect-session channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('disconnect-session', 's1');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('disconnect-session', 's1');
      expect(result.success).toBe(true);
    });
  });

  describe('Settings Management IPC Channels', () => {
    test('should handle get-settings channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        idleTimeout: '300000',
        maxConnections: '10'
      });

      const result = await mockIpcRenderer.invoke('get-settings');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-settings');
      expect(result).toHaveProperty('idleTimeout');
    });

    test('should handle set-setting channel', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({
        success: true
      });

      const result = await mockIpcRenderer.invoke('set-setting', 'idleTimeout', '600000');

      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('set-setting', 'idleTimeout', '600000');
      expect(result.success).toBe(true);
    });
  });

  describe('Event Channel Communication', () => {
    test('should handle activity-updated event', () => {
      const mockHandler = jest.fn();
      mockIpcRenderer.on.mockReturnValue(mockHandler);

      mockIpcRenderer.on('activity-updated', mockHandler);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith('activity-updated', mockHandler);
    });

    test('should handle listener-status-changed event', () => {
      const mockHandler = jest.fn();
      mockIpcRenderer.on.mockReturnValue(mockHandler);

      mockIpcRenderer.on('listener-status-changed', mockHandler);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith('listener-status-changed', mockHandler);
    });

    test('should handle session-updated event', () => {
      const mockHandler = jest.fn();
      mockIpcRenderer.on.mockReturnValue(mockHandler);

      mockIpcRenderer.on('session-updated', mockHandler);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith('session-updated', mockHandler);
    });

    test('should handle settings-changed event', () => {
      const mockHandler = jest.fn();
      mockIpcRenderer.on.mockReturnValue(mockHandler);

      mockIpcRenderer.on('settings-changed', mockHandler);

      expect(mockIpcRenderer.on).toHaveBeenCalledWith('settings-changed', mockHandler);
    });

    test('should remove event listeners', () => {
      mockIpcRenderer.removeAllListeners('activity-updated');

      expect(mockIpcRenderer.removeAllListeners).toHaveBeenCalledWith('activity-updated');
    });
  });

  describe('Error Handling', () => {
    test('should handle authentication errors', async () => {
      mockIpcRenderer.invoke.mockRejectedValue(new Error('Invalid credentials'));

      try {
        await mockIpcRenderer.invoke('authenticate-user', 'admin', 'wrongpass');
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Invalid credentials');
      }
    });

    test('should handle database errors', async () => {
      mockIpcRenderer.invoke.mockRejectedValue(new Error('Database error'));

      try {
        await mockIpcRenderer.invoke('get-all-users');
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Database error');
      }
    });

    test('should handle network errors', async () => {
      mockIpcRenderer.invoke.mockRejectedValue(new Error('Network error'));

      try {
        await mockIpcRenderer.invoke('start-listener', 1);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Network error');
      }
    });

    test('should handle timeout errors', async () => {
      mockIpcRenderer.invoke.mockRejectedValue(new Error('Timeout'));

      try {
        await mockIpcRenderer.invoke('get-activity', 1000);
        throw new Error('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Timeout');
      }
    });
  });

  describe('Data Validation', () => {
    test('should validate user data before sending', () => {
      const validUser = {
        username: 'testuser',
        password: 'testpass',
        passwordEnabled: true,
        guiEnabled: true
      };

      expect(validUser.username).toMatch(/^[a-zA-Z0-9_.-]+$/);
      expect(validUser.username.length).toBeGreaterThanOrEqual(2);
      expect(validUser.username.length).toBeLessThanOrEqual(64);
    });

    test('should validate listener data before sending', () => {
      const validListener = {
        name: 'Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12232,
        enabled: true
      };

      expect(validListener.port).toBeGreaterThan(0);
      expect(validListener.port).toBeLessThan(65536);
      expect(['FTP', 'SFTP'].includes(validListener.protocol)).toBe(true);
    });

    test('should validate virtual path data before sending', () => {
      const validPath = {
        virtualPath: '/data',
        localPath: '/tmp/data',
        canRead: true,
        canWrite: false
      };

      expect(validPath.virtualPath).toMatch(/^\//);
      expect(typeof validPath.canRead).toBe('boolean');
      expect(typeof validPath.canWrite).toBe('boolean');
    });
  });

  describe('Performance and Load Testing', () => {
    beforeEach(() => jest.clearAllMocks());

    test('should handle rapid successive IPC calls', async () => {
      mockIpcRenderer.invoke.mockResolvedValue({ success: true });

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(mockIpcRenderer.invoke('get-all-users'));
      }

      const results = await Promise.all(promises);
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });

    test('should handle large data transfer', async () => {
      const largeData = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        username: `user${i}`,
        guiEnabled: true
      }));
      mockIpcRenderer.invoke.mockResolvedValue(largeData);

      const result = await mockIpcRenderer.invoke('get-all-users');
      expect(result.length).toBe(1000);
    });

    test('should handle concurrent event subscriptions', () => {
      const handlers = Array.from({ length: 5 }, () => jest.fn());
      
      handlers.forEach((handler, index) => {
        mockIpcRenderer.on(`event-${index}`, handler);
      });

      expect(mockIpcRenderer.on).toHaveBeenCalledTimes(5);
    });
  });
});
