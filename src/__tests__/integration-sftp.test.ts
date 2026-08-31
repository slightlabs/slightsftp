import { SFTPServer } from '../sftp-server';
import { DatabaseManager } from '../database';
const SftpClient = require('ssh2-sftp-client');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('SFTP Server Integration Tests', () => {
  let db: DatabaseManager;
  let sftpServer: SFTPServer;
  let testDir: string;
  let ftpRoot: string;
  const TEST_PORT = 22222; // Use a different port for testing

  beforeAll(async () => {
    // Create temporary directories
    testDir = path.join(os.tmpdir(), `sftp-test-${Date.now()}`);
    ftpRoot = path.join(testDir, 'ftp-root');
    fs.mkdirSync(ftpRoot, { recursive: true });

    // Create test files
    fs.writeFileSync(path.join(ftpRoot, 'test1.txt'), 'Hello World');
    fs.writeFileSync(path.join(ftpRoot, 'test2.txt'), 'Test File 2');
    fs.mkdirSync(path.join(ftpRoot, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(ftpRoot, 'subdir', 'nested.txt'), 'Nested file');

    // Initialize database
    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    // Create test user
    db.createUser({
      username: 'testuser',
      password: 'testpass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });

    const user = db.getUser('testuser');
    expect(user).toBeDefined();

    // Create listener
    const listenerId = db.createListener({
      name: 'Test SFTP',
      protocol: 'SFTP',
      bindingIp: '127.0.0.1',
      port: TEST_PORT,
      enabled: true
    });

    const listener = db.getListener(listenerId);
    expect(listener).toBeDefined();

    // Add virtual path with full permissions
    db.addVirtualPath({
      userId: user!.id!,
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

    // Subscribe user to listener
    db.subscribeUserToListener(user!.id!, listener!.id!);

    // Add permissions
    db.setPermission({
      userId: user!.id!,
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

    // Start SFTP server
    sftpServer = new SFTPServer(listener!, db);
    await sftpServer.start();

    // Wait a bit for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
  }, 30000);

  afterEach(async () => {
    // Small delay between tests to allow connections to close
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    // Stop server
    await sftpServer.stop();

    // Cleanup
    db.close();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }, 20000);

  test('should connect and authenticate', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      expect(client.sftp).toBeDefined();
      
      await client.end();
    } catch (error) {
      throw new Error(`Connection failed: ${error}`);
    }
  }, 10000);

  test('should list directory contents', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      const list = await client.list('/');
      
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((f: any) => f.name === 'test1.txt')).toBe(true);
      expect(list.some((f: any) => f.name === 'test2.txt')).toBe(true);
      expect(list.some((f: any) => f.name === 'subdir')).toBe(true);
      
      await client.end();
    } catch (error) {
      throw new Error(`List operation failed: ${error}`);
    }
  }, 10000);

  test('should download file', async () => {
    const client = new SftpClient();
    const localPath = path.join(testDir, 'downloaded.txt');
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      await client.get('/test1.txt', localPath);
      
      expect(fs.existsSync(localPath)).toBe(true);
      const content = fs.readFileSync(localPath, 'utf8');
      expect(content).toBe('Hello World');
      
      await client.end();
    } catch (error) {
      throw new Error(`Download failed: ${error}`);
    }
  }, 10000);

  test('should upload file', async () => {
    const client = new SftpClient();
    const localPath = path.join(testDir, 'upload.txt');
    fs.writeFileSync(localPath, 'Uploaded content');
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      await client.put(localPath, '/uploaded.txt');
      
      const remotePath = path.join(ftpRoot, 'uploaded.txt');
      expect(fs.existsSync(remotePath)).toBe(true);
      const content = fs.readFileSync(remotePath, 'utf8');
      expect(content).toBe('Uploaded content');
      
      await client.end();
    } catch (error) {
      throw new Error(`Upload failed: ${error}`);
    }
  }, 10000);

  test('should handle disconnect gracefully', async () => {
    const client = new SftpClient();
    let disconnected = false;
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      // Do some operations
      const list = await client.list('/');
      expect(list.length).toBeGreaterThan(0);
      
      // Disconnect
      await client.end();
      disconnected = true;
      
      // If we got here, disconnect was successful
      expect(disconnected).toBe(true);
    } catch (error) {
      throw new Error(`Disconnect test failed: ${error}`);
    }
  }, 10000);

  test('should handle multiple sequential connections', async () => {
    for (let i = 0; i < 3; i++) {
      const client = new SftpClient();
      
      try {
        await client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'testuser',
          password: 'testpass',
          readyTimeout: 5000
        });

        const list = await client.list('/');
        expect(list.length).toBeGreaterThan(0);
        
        await client.end();
      } catch (error) {
        throw new Error(`Connection ${i + 1} failed: ${error}`);
      }
    }
  }, 30000);

  test('should create and delete directory', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      // Create directory
      await client.mkdir('/testdir');
      
      const remotePath = path.join(ftpRoot, 'testdir');
      expect(fs.existsSync(remotePath)).toBe(true);
      expect(fs.statSync(remotePath).isDirectory()).toBe(true);
      
      // Delete directory
      await client.rmdir('/testdir');
      expect(fs.existsSync(remotePath)).toBe(false);
      
      await client.end();
    } catch (error) {
      throw new Error(`Directory operations failed: ${error}`);
    }
  }, 10000);

  test('should delete file', async () => {
    const client = new SftpClient();
    const testFile = path.join(ftpRoot, 'delete-me.txt');
    fs.writeFileSync(testFile, 'Delete this');
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      await client.delete('/delete-me.txt');
      
      expect(fs.existsSync(testFile)).toBe(false);
      
      await client.end();
    } catch (error) {
      throw new Error(`Delete failed: ${error}`);
    }
  }, 10000);

  test('should rename file', async () => {
    const client = new SftpClient();
    const oldFile = path.join(ftpRoot, 'old-name.txt');
    const newFile = path.join(ftpRoot, 'new-name.txt');
    fs.writeFileSync(oldFile, 'Rename me');
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });

      await client.rename('/old-name.txt', '/new-name.txt');
      
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
      
      await client.end();
    } catch (error) {
      throw new Error(`Rename failed: ${error}`);
    }
  }, 10000);
});


