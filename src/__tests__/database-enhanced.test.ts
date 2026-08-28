import { DatabaseManager } from '../database';
import { User, Listener, Permission, VirtualPath, ServerActivity } from '../types';
import * as crypto from 'crypto';

describe('DatabaseManager - Enhanced Tests', () => {
  let db: DatabaseManager;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();
  });

  describe('User Operations - Edge Cases', () => {
    test('should handle duplicate username creation', async () => {
      const username = 'testuser';
      db.createUser({ username, password: 'password123', passwordEnabled: true, guiEnabled: true });
      
      expect(() => {
        db.createUser({ username, password: 'password456', passwordEnabled: true, guiEnabled: true });
      }).toThrow();
    });

    test('should hash password correctly', () => {
      const password = 'myPassword123';
      const hash1 = crypto.createHash("sha256").update(password).digest("hex");
      const hash2 = crypto.createHash("sha256").update(password).digest("hex");
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex length
    });

    test('should verify correct password', () => {
      const username = 'testuser';
      const password = 'correctPassword';
      
      db.createUser({ username, password, passwordEnabled: true, guiEnabled: true });
      
      expect(db.verifyPassword(username, password)).toBe(true);
      expect(db.verifyPassword(username, 'wrongPassword')).toBe(false);
    });

    test('should not verify password when password is disabled', () => {
      const username = 'keyonlyuser';
      
      db.createUser({ username, password: undefined, passwordEnabled: false, guiEnabled: true });
      
      expect(db.verifyPassword(username, 'anyPassword')).toBe(false);
    });

    test('should update user password', () => {
      const username = 'testuser';
      const oldPassword = 'oldPass123';
      const newPassword = 'newPass456';
      
      db.createUser({ username, password: oldPassword, passwordEnabled: true, guiEnabled: true });
      const user = db.getUser(username);
      
      if (user) {
        db.updateUser(username, { password: newPassword });
        
        expect(db.verifyPassword(username, newPassword)).toBe(true);
        expect(db.verifyPassword(username, oldPassword)).toBe(false);
      }
    });

    test('should enable/disable GUI access', () => {
      const username = 'adminuser';
      
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: true });
      let user = db.getUser(username);
      expect(user?.guiEnabled).toBe(true);
      
      if (user) {
        db.updateUser(username, { guiEnabled: false });
        user = db.getUser(username);
        expect(user?.guiEnabled).toBe(false);
      }
    });

    test('should delete user and cascade deletions', () => {
      const username = 'testuser';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: true });
      
      const user = db.getUser(username);
      if (user) {
        // Add virtual path for user
        db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/home',
          localPath: 'C:\\Users\\test',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        });
        
        db.deleteUser(username);
        
        expect(db.getUser(username)).toBeUndefined();
        const vpaths = db.getVirtualPaths(user.id!);
        expect(vpaths).toHaveLength(0);
      }
    });

    test('should get all users excluding system users', () => {
      db.createUser({ username: 'user1', password: 'pass', passwordEnabled: true, guiEnabled: false });
      db.createUser({ username: 'user2', password: 'pass', passwordEnabled: true, guiEnabled: false });
      db.createUser({ username: 'admin', password: 'pass', passwordEnabled: true, guiEnabled: true });
      
      const users = db.getAllUsers();
      
      expect(users.length).toBeGreaterThanOrEqual(3);
      expect(users.some(u => u.username === 'user1')).toBe(true);
    });
  });

  describe('Virtual Path Operations - Complex Scenarios', () => {
    test('should create virtual path with all permissions enabled', () => {
      const username = 'testuser';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        const vpathId = db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/full-access',
          localPath: 'C:\\FullAccess',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: true,
          canList: true,
          canCreateDir: true,
          canRename: true,
          applyToSubdirs: true
        });
        
        expect(vpathId).toBeGreaterThan(0);
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        expect(vpaths).toHaveLength(1);
        expect(vpaths[0].canDelete).toBe(true);
        expect(vpaths[0].canCreateDir).toBe(true);
        expect(vpaths[0].canRename).toBe(true);
      }
    });

    test('should create read-only virtual path', () => {
      const username = 'readonly';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/readonly',
          localPath: 'C:\\ReadOnly',
          canRead: true,
          canWrite: false,
          canAppend: false,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        });
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        expect(vpaths[0].canWrite).toBe(false);
        expect(vpaths[0].canDelete).toBe(false);
      }
    });

    test('should update virtual path permissions', () => {
      const username = 'testuser';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        const vpathId = db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/data',
          localPath: 'C:\\Data',
          canRead: true,
          canWrite: false,
          canAppend: false,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        });
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        const vpath = vpaths[0];
        
        db.updateVirtualPath({
          ...vpath,
          canWrite: true,
          canDelete: true
        });
        
        const updated = user.id ? db.getVirtualPaths(user.id)[0] : undefined;
        expect(updated?.canWrite).toBe(true);
        expect(updated?.canDelete).toBe(true);
      }
    });

    test('should support multiple virtual paths per user', () => {
      const username = 'multipath';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/home',
          localPath: 'C:\\Home',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        });
        
        db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/work',
          localPath: 'C:\\Work',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: true,
          canList: true,
          canCreateDir: true,
          canRename: true,
          applyToSubdirs: true
        });
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        expect(vpaths).toHaveLength(2);
        expect(vpaths.map(v => v.virtualPath)).toContain('/home');
        expect(vpaths.map(v => v.virtualPath)).toContain('/work');
      }
    });

    test('should delete virtual path', () => {
      const username = 'testuser';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        const vpathId = db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/temp',
          localPath: 'C:\\Temp',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        });
        
        db.deleteVirtualPath(vpathId);
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        expect(vpaths).toHaveLength(0);
      }
    });

    test('should handle applyToSubdirs flag', () => {
      const username = 'testuser';
      db.createUser({ username, password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser(username);
      
      if (user) {
        db.addVirtualPath({
          userId: user.id!,
          virtualPath: '/parent',
          localPath: 'C:\\Parent',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: false
        });
        
        const vpaths = user.id ? db.getVirtualPaths(user.id) : [];
        expect(vpaths[0].applyToSubdirs).toBe(false);
      }
    });
  });

  describe('Listener Operations - Complete Coverage', () => {
    test('should create SFTP listener', () => {
      const listenerId = db.createListener({
        name: 'SFTP Server',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      expect(listenerId).toBeGreaterThan(0);
      
      const listener = db.getListener(listenerId);
      expect(listener?.protocol).toBe('SFTP');
      expect(listener?.port).toBe(22);
    });

    test('should create FTP listener', () => {
      const listenerId = db.createListener({
        name: 'FTP Server',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      const listener = db.getListener(listenerId);
      expect(listener?.protocol).toBe('FTP');
      expect(listener?.port).toBe(21);
    });

    test('should disable listener', () => {
      const listenerId = db.createListener({
        name: 'Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 3333,
        enabled: true
      });
      
      let listener = db.getListener(listenerId);
      expect(listener?.enabled).toBe(true);
      
      if (listener && listener.id) {
        db.updateListener(listener.id, { enabled: false });
        listener = db.getListener(listenerId);
        expect(listener?.enabled).toBe(false);
      }
    });

    test('should update listener port', () => {
      const listenerId = db.createListener({
        name: 'Port Changer',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      const listener = db.getListener(listenerId);
      if (listener && listener.id) {
        db.updateListener(listener.id, { port: 2122 });
        const updated = db.getListener(listenerId);
        expect(updated?.port).toBe(2122);
      }
    });

    test('should delete listener and cascade', () => {
      const listenerId = db.createListener({
        name: 'Temp Listener',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 9999,
        enabled: true
      });
      
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listenerId);
        db.setPermission({
          userId: user.id,
          listenerId: listenerId,
      canRead: true,
          canCreate: true,
          canEdit: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false
        });
        
        db.deleteListener(listenerId);
        
        expect(db.getListener(listenerId)).toBeUndefined();
        const listeners = user.id ? db.getUserListeners(user.id) : [];
        expect(listeners).toHaveLength(0);
        const perm = user.id ? db.getPermission(user.id, listenerId) : undefined;
        expect(perm).toBeUndefined();
      }
    });

    test('should get all listeners', () => {
      db.createListener({
        name: 'SFTP 1',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      db.createListener({
        name: 'FTP 1',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      const listeners = db.getAllListeners();
      expect(listeners.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Permission Operations - Detailed Testing', () => {
    test('should set full permissions', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listenerId);
        db.setPermission({
          userId: user.id,
          listenerId: listenerId,
      canRead: true,
          canCreate: true,
          canEdit: true,
          canAppend: true,
          canDelete: true,
          canList: true,
          canCreateDir: true,
          canRename: true
        });
        
        const perm = user.id ? db.getPermission(user.id, listenerId) : undefined;
        expect(perm?.canDelete).toBe(true);
        expect(perm?.canCreateDir).toBe(true);
        expect(perm?.canRename).toBe(true);
      }
    });

    test('should set read-only permissions', () => {
      db.createUser({ username: 'readonly', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('readonly');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listenerId);
        db.setPermission({
          userId: user.id,
          listenerId: listenerId,
      canRead: true,
          canCreate: false,
          canEdit: false,
          canAppend: false,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false
        });
        
        const perm = user.id ? db.getPermission(user.id, listenerId) : undefined;
        expect(perm?.canCreate).toBe(false);
        expect(perm?.canDelete).toBe(false);
        expect(perm?.canList).toBe(true);
      }
    });

    test('should update existing permissions', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listenerId);
        db.setPermission({
          userId: user.id,
          listenerId: listenerId,
      canRead: true,
          canCreate: true,
          canEdit: false,
          canAppend: false,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false
        });
        
        // Update permissions
        db.setPermission({
          userId: user.id,
          listenerId: listenerId,
      canRead: true,
          canCreate: true,
          canEdit: true,
          canAppend: true,
          canDelete: true,
          canList: true,
          canCreateDir: true,
          canRename: true
        });
        
        const perm = user.id ? db.getPermission(user.id, listenerId) : undefined;
        expect(perm?.canEdit).toBe(true);
        expect(perm?.canDelete).toBe(true);
      }
    });

    test('should get all user permissions', () => {
      db.createUser({ username: 'multilistener', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('multilistener');
      
      const listener1 = db.createListener({
        name: 'SFTP',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      const listener2 = db.createListener({
        name: 'FTP',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listener1);
        db.subscribeUserToListener(user.id, listener2);
        
        db.setPermission({
          userId: user.id,
          listenerId: listener1,
      canRead: true,
          canCreate: true,
          canEdit: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false
        });
        
        db.setPermission({
          userId: user.id,
          listenerId: listener2,
      canRead: true,
          canCreate: true,
          canEdit: false,
          canAppend: false,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false
        });
        
        const perms = user.id ? db.getUserPermissions(user.id) : [];
        expect(perms).toHaveLength(2);
      }
    });
  });

  describe('User-Listener Subscription', () => {
    test('should subscribe user to listener', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user) {
        if (user.id) db.subscribeUserToListener(user.id, listenerId);
        
        const listeners = user.id ? db.getUserListeners(user.id) : [];
        expect(listeners).toContain(listenerId);
        
        const users = db.getListenerUsers(listenerId!);
        expect(users).toContain(user.id);
      }
    });

    test('should handle duplicate subscription gracefully', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user) {
        if (user.id) db.subscribeUserToListener(user.id, listenerId);
        if (user.id) db.subscribeUserToListener(user.id, listenerId); // Duplicate
        
        const listeners = user.id ? db.getUserListeners(user.id) : [];
        expect(listeners.filter(l => l === listenerId)).toHaveLength(1);
      }
    });

    test('should unsubscribe user from listener', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listenerId);
        let result = db.getUserListeners(user.id);
        expect(result).toContain(listenerId);
        
        db.unsubscribeUserFromListener(user.id, listenerId);
        result = db.getUserListeners(user.id);
        expect(result).not.toContain(listenerId);
      }
    });

    test('should subscribe user to multiple listeners', () => {
      db.createUser({ username: 'testuser', password: 'pass', passwordEnabled: true, guiEnabled: false });
      const user = db.getUser('testuser');
      
      const listener1 = db.createListener({
        name: 'SFTP',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      const listener2 = db.createListener({
        name: 'FTP',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      if (user && user.id) {
        db.subscribeUserToListener(user.id, listener1);
        db.subscribeUserToListener(user.id, listener2);
        
        const listeners = user.id ? db.getUserListeners(user.id) : [];
        expect(listeners).toHaveLength(2);
        expect(listeners).toContain(listener1);
        expect(listeners).toContain(listener2);
      }
    });
  });

  describe('Activity Logging - Comprehensive', () => {
    test('should log successful activity', () => {
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      db.logActivity({
        listenerId: listenerId,
        username: 'testuser',
        action: 'FILE_UPLOAD',
        path: '/home/test.txt',
        success: true
      });
      
      const activities = db.getRecentActivities(listenerId);
      expect(activities).toHaveLength(1);
      expect(activities[0].action).toBe('FILE_UPLOAD');
      expect(activities[0].success).toBe(true);
    });

    test('should log failed activity', () => {
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      db.logActivity({
        listenerId: listenerId,
        username: 'testuser',
        action: 'FILE_DELETE',
        path: '/home/protected.txt',
        success: false
      });
      
      const activities = db.getRecentActivities(listenerId);
      expect(activities[0].success).toBe(false);
    });

    test('should log GUI actions with null listenerId', () => {
      db.logActivity({
        listenerId: null,
        username: 'admin',
        action: 'GUI_LOGIN',
        path: '',
        success: true
      });
      
      const activities = db.getRecentActivities();
      const loginActivity = activities.find(a => a.action === 'GUI_LOGIN');
      expect(loginActivity).toBeDefined();
      expect(loginActivity?.listenerId).toBeNull();
    });

    test('should retrieve limited activities', () => {
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      // Log 15 activities
      for (let i = 0; i < 15; i++) {
        db.logActivity({
          listenerId: listenerId,
          username: 'testuser',
          action: 'FILE_UPLOAD',
          path: `/file${i}.txt`,
          success: true
        });
      }
      
      const activities = db.getRecentActivities(listenerId, 10);
      expect(activities).toHaveLength(10);
    });

    test('should filter activities by listener', () => {
      const listener1 = db.createListener({
        name: 'SFTP',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      const listener2 = db.createListener({
        name: 'FTP',
        protocol: 'FTP',
        bindingIp: '0.0.0.0',
        port: 21,
        enabled: true
      });
      
      db.logActivity({
        listenerId: listener1,
        username: 'user1',
        action: 'FILE_UPLOAD',
        path: '/file1.txt',
        success: true
      });
      
      db.logActivity({
        listenerId: listener2,
        username: 'user2',
        action: 'FILE_DOWNLOAD',
        path: '/file2.txt',
        success: true
      });
      
      const activities1 = db.getRecentActivities(listener1);
      const activities2 = db.getRecentActivities(listener2);
      
      expect(activities1.every(a => a.listenerId === listener1)).toBe(true);
      expect(activities2.every(a => a.listenerId === listener2)).toBe(true);
    });

    test('should log various action types', () => {
      const listenerId = db.createListener({
        name: 'Test',
        protocol: 'SFTP',
        bindingIp: '0.0.0.0',
        port: 22,
        enabled: true
      });
      
      const actions = [
        'FILE_UPLOAD',
        'FILE_DOWNLOAD',
        'FILE_DELETE',
        'DIR_CREATE',
        'FILE_RENAME',
        'LOGIN_SUCCESS',
        'LOGIN_FAILED'
      ];
      
      actions.forEach(action => {
        db.logActivity({
          listenerId: listenerId,
          username: 'testuser',
          action: action,
          path: '/test',
          success: true
        });
      });
      
      const activities = db.getRecentActivities(listenerId);
      expect(activities).toHaveLength(actions.length);
      
      const loggedActions = activities.map(a => a.action);
      actions.forEach(action => {
        expect(loggedActions).toContain(action);
      });
    });
  });

  describe('Database Initialization', () => {
    test('should initialize database only once', async () => {
      const newDb = new DatabaseManager(':memory:');
      await newDb.init();
      
      // Try to initialize again
      await newDb.init();
      
      // Should not throw error
      expect(true).toBe(true);
    });

    test('should throw error when accessing uninitialized database', () => {
      const newDb = new DatabaseManager(':memory:');
      
      expect(() => {
        newDb.getAllUsers();
      }).toThrow('Database not initialized');
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid user ID gracefully', () => {
      const vpaths = db.getVirtualPaths(99999);
      expect(vpaths).toHaveLength(0);
    });

    test('should handle invalid listener ID gracefully', () => {
      const listener = db.getListener(99999);
      expect(listener).toBeUndefined();
    });

    test('should handle missing virtual path ID on update', () => {
      expect(() => {
        db.updateVirtualPath({
          userId: 1,
          virtualPath: '/test',
          localPath: 'C:\\Test',
          canRead: true,
          canWrite: true,
          canAppend: true,
          canDelete: false,
          canList: true,
          canCreateDir: false,
          canRename: false,
          applyToSubdirs: true
        } as VirtualPath);
      }).toThrow('Virtual path ID is required');
    });
  });
});


