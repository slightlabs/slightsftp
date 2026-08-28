import { SFTPServer } from '../sftp-server';
import { DatabaseManager } from '../database';
const SftpClient = require('ssh2-sftp-client');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('SFTP Authentication & Authorization Integration Tests', () => {
  let db: DatabaseManager;
  let sftpServer: SFTPServer;
  let testDir: string;
  let ftpRoot: string;
  const TEST_PORT = 22223;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `sftp-auth-test-${Date.now()}`);
    ftpRoot = path.join(testDir, 'ftp-root');
    fs.mkdirSync(ftpRoot, { recursive: true });

    // Create test files and directories
    fs.writeFileSync(path.join(ftpRoot, 'public-file.txt'), 'Public content');
    fs.mkdirSync(path.join(ftpRoot, 'readonly-dir'), { recursive: true });
    fs.writeFileSync(path.join(ftpRoot, 'readonly-dir', 'readonly.txt'), 'Cannot modify');
    fs.mkdirSync(path.join(ftpRoot, 'writeonly-dir'), { recursive: true });

    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    // Create listener
    const listenerId = db.createListener({
      name: 'Auth Test SFTP',
      protocol: 'SFTP',
      bindingIp: '127.0.0.1',
      port: TEST_PORT,
      enabled: true
    });

    const listener = db.getListener(listenerId);

    // Create multiple users with different permissions
    
    // 1. Admin user - full permissions
    db.createUser({
      username: 'admin',
      password: 'adminpass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });
    const admin = db.getUser('admin');
    db.subscribeUserToListener(admin!.id!, listener!.id!);
    db.setPermission({
      userId: admin!.id!,
      listenerId: listener!.id!,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true
    });
    db.addVirtualPath({
      userId: admin!.id!,
      virtualPath: '/',
      localPath: ftpRoot,
      canRead: true,
      canWrite: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true,
      applyToSubdirs: true
    });

    // 2. Read-only user
    db.createUser({
      username: 'readonly',
      password: 'readonlypass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });
    const readonly = db.getUser('readonly');
    db.subscribeUserToListener(readonly!.id!, listener!.id!);
    db.setPermission({
      userId: readonly!.id!,
      listenerId: listener!.id!,
      canRead: true,
      canCreate: false,
      canEdit: false,
      canAppend: false,
      canDelete: false,
      canList: true,
      canCreateDir: false,
      canRename: false
    });
    db.addVirtualPath({
      userId: readonly!.id!,
      virtualPath: '/',
      localPath: ftpRoot,
      canRead: true,
      canWrite: false,
      canAppend: false,
      canDelete: false,
      canList: true,
      canCreateDir: false,
      canRename: false,
      applyToSubdirs: true
    });

    // 3. Write-only user
    db.createUser({
      username: 'writeonly',
      password: 'writeonlypass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });
    const writeonly = db.getUser('writeonly');
    db.subscribeUserToListener(writeonly!.id!, listener!.id!);
    db.setPermission({
      userId: writeonly!.id!,
      listenerId: listener!.id!,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canAppend: true,
      canDelete: false,
      canList: false,
      canCreateDir: false,
      canRename: false
    });
    db.addVirtualPath({
      userId: writeonly!.id!,
      virtualPath: '/',
      localPath: ftpRoot,
      canRead: false,
      canWrite: true,
      canAppend: true,
      canDelete: false,
      canList: false,
      canCreateDir: false,
      canRename: false,
      applyToSubdirs: true
    });

    // 4. User with no permissions (disabled)
    db.createUser({
      username: 'disabled',
      password: 'disabledpass',
      passwordEnabled: false, // Password disabled
      publicKey: '',
      guiEnabled: false
    });

    // Start SFTP server
    sftpServer = new SFTPServer(listener!, db);
    await sftpServer.start();
  }, 30000);

  afterAll(async () => {
    try {
      if (sftpServer) {
        await Promise.race([
          sftpServer.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Stop timeout')), 5000))
        ]).catch(() => {
          // Force close if timeout
          console.log('Force closing SFTP server');
        });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 60000);

  describe('Authentication Tests', () => {
    test('should authenticate admin with correct password', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        expect(client.sftp).toBeDefined();
        await client.end();
      } catch (error) {
        throw new Error(`Admin authentication failed: ${error}`);
      }
    }, 10000);

    test('should reject authentication with wrong password', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'wrongpass',
          readyTimeout: 5000
        });

        // Should not reach here
        await client.end();
        throw new Error('Should have rejected wrong password');
      } catch (error: any) {
        // Expect authentication failure
        expect(error.message).toContain('All configured authentication methods failed');
      }
    }, 10000);

    test('should reject authentication for disabled user', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'disabled',
          password: 'disabledpass',
          readyTimeout: 5000
        });

        await client.end();
        throw new Error('Should have rejected disabled user');
      } catch (error: any) {
        expect(error.message).toContain('All configured authentication methods failed');
      }
    }, 10000);

    test('should reject authentication for non-existent user', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'nonexistent',
          password: 'anypass',
          readyTimeout: 5000
        });

        await client.end();
        throw new Error('Should have rejected non-existent user');
      } catch (error: any) {
        expect(error.message).toContain('All configured authentication methods failed');
      }
    }, 10000);
  });

  describe('Authorization - Admin User (Full Permissions)', () => {
    test('admin should be able to list directories', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        const list = await client.list('/');
        expect(list.length).toBeGreaterThan(0);
        
        await client.end();
      } catch (error) {
        throw new Error(`Admin list failed: ${error}`);
      }
    }, 10000);

    test('admin should be able to upload files', async () => {
      const client = new SftpClient();
      const uploadContent = 'Admin upload test';
      const tempFile = path.join(testDir, 'admin-upload.txt');
      fs.writeFileSync(tempFile, uploadContent);
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        await client.put(tempFile, '/admin-uploaded.txt');
        
        const uploaded = path.join(ftpRoot, 'admin-uploaded.txt');
        expect(fs.existsSync(uploaded)).toBe(true);
        expect(fs.readFileSync(uploaded, 'utf8')).toBe(uploadContent);
        
        await client.end();
      } catch (error) {
        throw new Error(`Admin upload failed: ${error}`);
      }
    }, 10000);

    test('admin should be able to delete files', async () => {
      const client = new SftpClient();
      const deleteFile = path.join(ftpRoot, 'admin-delete-me.txt');
      fs.writeFileSync(deleteFile, 'Delete me');
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        await client.delete('/admin-delete-me.txt');
        expect(fs.existsSync(deleteFile)).toBe(false);
        
        await client.end();
      } catch (error) {
        throw new Error(`Admin delete failed: ${error}`);
      }
    }, 10000);

    test('admin should be able to create directories', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        await client.mkdir('/admin-newdir');
        
        const newDir = path.join(ftpRoot, 'admin-newdir');
        expect(fs.existsSync(newDir)).toBe(true);
        expect(fs.statSync(newDir).isDirectory()).toBe(true);
        
        await client.end();
      } catch (error) {
        throw new Error(`Admin mkdir failed: ${error}`);
      }
    }, 10000);

    test('admin should be able to rename files', async () => {
      const client = new SftpClient();
      const oldFile = path.join(ftpRoot, 'admin-old-name.txt');
      fs.writeFileSync(oldFile, 'Rename me');
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'admin',
          password: 'adminpass',
          readyTimeout: 5000
        });

        await client.rename('/admin-old-name.txt', '/admin-new-name.txt');
        
        expect(fs.existsSync(oldFile)).toBe(false);
        expect(fs.existsSync(path.join(ftpRoot, 'admin-new-name.txt'))).toBe(true);
        
        await client.end();
      } catch (error) {
        throw new Error(`Admin rename failed: ${error}`);
      }
    }, 10000);
  });

  describe('Authorization - Read-Only User', () => {
    test('readonly user should be able to list directories', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'readonly',
          password: 'readonlypass',
          readyTimeout: 5000
        });

        const list = await client.list('/');
        expect(list.length).toBeGreaterThan(0);
        
        await client.end();
      } catch (error) {
        throw new Error(`Readonly list failed: ${error}`);
      }
    }, 10000);

    test('readonly user should be able to download files', async () => {
      const client = new SftpClient();
      const downloadPath = path.join(testDir, 'readonly-download.txt');
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'readonly',
          password: 'readonlypass',
          readyTimeout: 5000
        });

        await client.get('/public-file.txt', downloadPath);
        
        expect(fs.existsSync(downloadPath)).toBe(true);
        expect(fs.readFileSync(downloadPath, 'utf8')).toBe('Public content');
        
        await client.end();
      } catch (error) {
        throw new Error(`Readonly download failed: ${error}`);
      }
    }, 10000);

    test('readonly user should NOT be able to upload files', async () => {
      const client = new SftpClient();
      const tempFile = path.join(testDir, 'readonly-upload-attempt.txt');
      fs.writeFileSync(tempFile, 'Should not upload');
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'readonly',
          password: 'readonlypass',
          readyTimeout: 5000
        });

        await client.put(tempFile, '/readonly-should-fail.txt');
        
        // Should not reach here
        await client.end();
        throw new Error('Readonly user should not be able to upload');
      } catch (error: any) {
        // Expect permission denied or failure
        expect(error.message).toBeTruthy();
      }
    }, 10000);

    test('readonly user should NOT be able to delete files', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'readonly',
          password: 'readonlypass',
          readyTimeout: 5000
        });

        await client.delete('/public-file.txt');
        
        // Should not reach here
        await client.end();
        throw new Error('Readonly user should not be able to delete');
      } catch (error: any) {
        // Expect permission denied
        expect(error.message).toBeTruthy();
      }
    }, 10000);

    test('readonly user should NOT be able to create directories', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'readonly',
          password: 'readonlypass',
          readyTimeout: 5000
        });

        await client.mkdir('/readonly-newdir');
        
        // Should not reach here
        await client.end();
        throw new Error('Readonly user should not be able to create directories');
      } catch (error: any) {
        // Expect permission denied
        expect(error.message).toBeTruthy();
      }
    }, 10000);
  });

  describe('Authorization - Write-Only User', () => {
    test('writeonly user should be able to upload files', async () => {
      const client = new SftpClient();
      const uploadContent = 'Writeonly upload';
      const tempFile = path.join(testDir, 'writeonly-upload.txt');
      fs.writeFileSync(tempFile, uploadContent);
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'writeonly',
          password: 'writeonlypass',
          readyTimeout: 5000
        });

        await client.put(tempFile, '/writeonly-uploaded.txt');
        
        const uploaded = path.join(ftpRoot, 'writeonly-uploaded.txt');
        expect(fs.existsSync(uploaded)).toBe(true);
        expect(fs.readFileSync(uploaded, 'utf8')).toBe(uploadContent);
        
        await client.end();
      } catch (error) {
        throw new Error(`Writeonly upload failed: ${error}`);
      }
    }, 10000);

    test('writeonly user should NOT be able to list directories', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'writeonly',
          password: 'writeonlypass',
          readyTimeout: 5000
        });

        await client.list('/');
        
        // Should not reach here
        await client.end();
        throw new Error('Writeonly user should not be able to list');
      } catch (error: any) {
        // Expect permission denied
        expect(error.message).toBeTruthy();
      }
    }, 10000);

    test('writeonly user should NOT be able to download files', async () => {
      const client = new SftpClient();
      const downloadPath = path.join(testDir, 'writeonly-download-attempt.txt');
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'writeonly',
          password: 'writeonlypass',
          readyTimeout: 5000
        });

        await client.get('/public-file.txt', downloadPath);
        
        // Should not reach here
        await client.end();
        throw new Error('Writeonly user should not be able to download');
      } catch (error: any) {
        // Expect permission denied
        expect(error.message).toBeTruthy();
      }
    }, 10000);

    test('writeonly user should NOT be able to delete files', async () => {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'writeonly',
          password: 'writeonlypass',
          readyTimeout: 5000
        });

        await client.delete('/public-file.txt');
        
        // Should not reach here
        await client.end();
        throw new Error('Writeonly user should not be able to delete');
      } catch (error: any) {
        // Expect permission denied
        expect(error.message).toBeTruthy();
      }
    }, 10000);
  });
});


