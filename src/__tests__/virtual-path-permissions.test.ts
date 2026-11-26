import { DatabaseManager } from '../database';
import { VirtualPath, User } from '../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Virtual Path Permissions', () => {
  let db: DatabaseManager;
  // a temp folder per test: the database brings its -wal / -shm journal and secret.key along
  let testDir: string;
  let testDbPath: string;
  let testUser: User;
  let listenerId: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-vp-'));
    testDbPath = path.join(testDir, 'test-vp-permissions.db');
    db = new DatabaseManager(testDbPath);
    await db.init();

    // Create test user
    const userId = db.createUser({
      username: 'vptest',
      password: 'test123',
      passwordEnabled: true,
      guiEnabled: false
    });
    testUser = db.getUser('vptest')!;

    // Create test listener
    listenerId = db.createListener({
      name: 'Test Listener',
      protocol: 'SFTP',
      bindingIp: '0.0.0.0',
      port: 3333,
      enabled: true
    });

    // Subscribe user to listener
    db.subscribeUserToListener(testUser.id!, listenerId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Virtual Path Creation with Permissions', () => {
    test('should create virtual path with default permissions', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data'
      };

      const vpId = db.addVirtualPath(vp);
      expect(vpId).toBeGreaterThan(0);

      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps).toHaveLength(1);
      expect(vps[0].virtualPath).toBe('/data');
      expect(vps[0].canRead).toBe(true);
      expect(vps[0].canWrite).toBe(true);
      expect(vps[0].canList).toBe(true);
    });

    test('should create virtual path with custom permissions', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/readonly',
        localPath: 'C:\\readonly',
        canRead: true,
        canWrite: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false,
        applyToSubdirs: true
      };

      const vpId = db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].canRead).toBe(true);
      expect(vps[0].canWrite).toBe(false);
      expect(vps[0].canAppend).toBe(false);
      expect(vps[0].canDelete).toBe(false);
      expect(vps[0].canList).toBe(true);
      expect(vps[0].canCreateDir).toBe(false);
      expect(vps[0].canRename).toBe(false);
      expect(vps[0].applyToSubdirs).toBe(true);
    });

    test('should create multiple virtual paths with different permissions', () => {
      const vp1: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/readonly',
        localPath: 'C:\\readonly',
        canRead: true,
        canWrite: false,
        canList: true
      };

      const vp2: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/upload',
        localPath: 'C:\\upload',
        canRead: false,
        canWrite: true,
        canList: false
      };

      db.addVirtualPath(vp1);
      db.addVirtualPath(vp2);

      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps).toHaveLength(2);
      
      const readonly = vps.find(v => v.virtualPath === '/readonly')!;
      expect(readonly.canRead).toBe(true);
      expect(readonly.canWrite).toBe(false);

      const upload = vps.find(v => v.virtualPath === '/upload')!;
      expect(upload.canRead).toBe(false);
      expect(upload.canWrite).toBe(true);
    });
  });

  describe('Permission Flags', () => {
    test('should handle all 7 permission flags', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/full',
        localPath: 'C:\\full',
        canRead: true,
        canWrite: true,
        canAppend: true,
        canDelete: true,
        canList: true,
        canCreateDir: true,
        canRename: true
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].canRead).toBe(true);
      expect(vps[0].canWrite).toBe(true);
      expect(vps[0].canAppend).toBe(true);
      expect(vps[0].canDelete).toBe(true);
      expect(vps[0].canList).toBe(true);
      expect(vps[0].canCreateDir).toBe(true);
      expect(vps[0].canRename).toBe(true);
    });

    test('should handle read-only permissions', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/readonly',
        localPath: 'C:\\readonly',
        canRead: true,
        canWrite: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].canRead).toBe(true);
      expect(vps[0].canList).toBe(true);
      expect(vps[0].canWrite).toBe(false);
      expect(vps[0].canAppend).toBe(false);
      expect(vps[0].canDelete).toBe(false);
      expect(vps[0].canCreateDir).toBe(false);
      expect(vps[0].canRename).toBe(false);
    });

    test('should handle upload-only permissions', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/upload',
        localPath: 'C:\\upload',
        canRead: false,
        canWrite: true,
        canAppend: true,
        canDelete: false,
        canList: false,
        canCreateDir: false,
        canRename: false
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].canWrite).toBe(true);
      expect(vps[0].canAppend).toBe(true);
      expect(vps[0].canRead).toBe(false);
      expect(vps[0].canList).toBe(false);
      expect(vps[0].canDelete).toBe(false);
    });
  });

  describe('Virtual Path Update', () => {
    test('should update virtual path permissions', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data',
        canRead: true,
        canWrite: true
      };

      const vpId = db.addVirtualPath(vp);
      
      // Update permissions
      const updatedVp: VirtualPath = {
        id: vpId,
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data',
        canRead: true,
        canWrite: false,
        canDelete: true
      };

      db.updateVirtualPath(updatedVp);
      
      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps[0].canRead).toBe(true);
      expect(vps[0].canWrite).toBe(false);
      expect(vps[0].canDelete).toBe(true);
    });

    test('should update virtual path location and permissions together', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/old',
        localPath: 'C:\\old',
        canRead: true,
        canWrite: false
      };

      const vpId = db.addVirtualPath(vp);
      
      const updatedVp: VirtualPath = {
        id: vpId,
        userId: testUser.id!,
        virtualPath: '/new',
        localPath: 'C:\\new',
        canRead: false,
        canWrite: true
      };

      db.updateVirtualPath(updatedVp);
      
      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps[0].virtualPath).toBe('/new');
      expect(vps[0].localPath).toBe('C:\\new');
      expect(vps[0].canRead).toBe(false);
      expect(vps[0].canWrite).toBe(true);
    });
  });

  describe('Apply to Subdirectories Flag', () => {
    test('should set applyToSubdirs to true by default', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data'
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].applyToSubdirs).toBe(true);
    });

    test('should allow disabling applyToSubdirs', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data',
        applyToSubdirs: false
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].applyToSubdirs).toBe(false);
    });
  });

  describe('Virtual Path Deletion', () => {
    test('should delete virtual path', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data'
      };

      const vpId = db.addVirtualPath(vp);
      expect(db.getVirtualPaths(testUser.id!)).toHaveLength(1);

      db.deleteVirtualPath(vpId);
      expect(db.getVirtualPaths(testUser.id!)).toHaveLength(0);
    });

    test('should delete only specific virtual path', () => {
      const vp1: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data1',
        localPath: 'C:\\data1'
      };

      const vp2: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data2',
        localPath: 'C:\\data2'
      };

      const vpId1 = db.addVirtualPath(vp1);
      const vpId2 = db.addVirtualPath(vp2);

      db.deleteVirtualPath(vpId1);
      
      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps).toHaveLength(1);
      expect(vps[0].virtualPath).toBe('/data2');
    });
  });

  describe('Multi-User Virtual Paths', () => {
    let user2: User;

    beforeEach(() => {
      const user2Id = db.createUser({
        username: 'vptest2',
        password: 'test456',
        passwordEnabled: true,
        guiEnabled: false
      });
      user2 = db.getUser('vptest2')!;
    });

    test('should isolate virtual paths per user', () => {
      const vp1: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/user1data',
        localPath: 'C:\\user1',
        canRead: true,
        canWrite: false
      };

      const vp2: VirtualPath = {
        userId: user2.id!,
        virtualPath: '/user2data',
        localPath: 'C:\\user2',
        canRead: false,
        canWrite: true
      };

      db.addVirtualPath(vp1);
      db.addVirtualPath(vp2);

      const user1Vps = db.getVirtualPaths(testUser.id!);
      const user2Vps = db.getVirtualPaths(user2.id!);

      expect(user1Vps).toHaveLength(1);
      expect(user2Vps).toHaveLength(1);
      expect(user1Vps[0].virtualPath).toBe('/user1data');
      expect(user2Vps[0].virtualPath).toBe('/user2data');
      expect(user1Vps[0].canRead).toBe(true);
      expect(user1Vps[0].canWrite).toBe(false);
      expect(user2Vps[0].canRead).toBe(false);
      expect(user2Vps[0].canWrite).toBe(true);
    });
  });

  describe('Permission Edge Cases', () => {
    test('should handle all permissions disabled', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/blocked',
        localPath: 'C:\\blocked',
        canRead: false,
        canWrite: false,
        canAppend: false,
        canDelete: false,
        canList: false,
        canCreateDir: false,
        canRename: false,
        applyToSubdirs: false
      };

      db.addVirtualPath(vp);
      const vps = db.getVirtualPaths(testUser.id!);
      
      expect(vps[0].canRead).toBe(false);
      expect(vps[0].canWrite).toBe(false);
      expect(vps[0].canAppend).toBe(false);
      expect(vps[0].canDelete).toBe(false);
      expect(vps[0].canList).toBe(false);
      expect(vps[0].canCreateDir).toBe(false);
      expect(vps[0].canRename).toBe(false);
      expect(vps[0].applyToSubdirs).toBe(false);
    });

    test('should handle partial permission updates', () => {
      const vp: VirtualPath = {
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data',
        canRead: true,
        canWrite: true,
        canDelete: true
      };

      const vpId = db.addVirtualPath(vp);
      
      // Update only some permissions
      const updatedVp: VirtualPath = {
        id: vpId,
        userId: testUser.id!,
        virtualPath: '/data',
        localPath: 'C:\\data',
        canRead: false,
        canWrite: true,
        canList: true,
        canRename: true
      };

      db.updateVirtualPath(updatedVp);
      
      const vps = db.getVirtualPaths(testUser.id!);
      expect(vps[0].canRead).toBe(false);
      expect(vps[0].canWrite).toBe(true);
      expect(vps[0].canList).toBe(true);
      expect(vps[0].canRename).toBe(true);
    });
  });
});


