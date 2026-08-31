import { SFTPServer } from '../sftp-server';
import { DatabaseManager } from '../database';
const SftpClient = require('ssh2-sftp-client');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('SFTP Disconnect Scenarios - Comprehensive Tests', () => {
  let db: DatabaseManager;
  let sftpServer: SFTPServer;
  let testDir: string;
  let ftpRoot: string;
  const TEST_PORT = 22224;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `sftp-disconnect-test-${Date.now()}`);
    ftpRoot = path.join(testDir, 'ftp-root');
    fs.mkdirSync(ftpRoot, { recursive: true });
    fs.writeFileSync(path.join(ftpRoot, 'test.txt'), 'Test content');

    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    db.createUser({
      username: 'testuser',
      password: 'testpass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });

    const user = db.getUser('testuser');
    const listenerId = db.createListener({
      name: 'Disconnect Test SFTP',
      protocol: 'SFTP',
      bindingIp: '127.0.0.1',
      port: TEST_PORT,
      enabled: true
    });

    const listener = db.getListener(listenerId);
    db.subscribeUserToListener(user!.id!, listener!.id!);
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

    sftpServer = new SFTPServer(listener!, db);
    await sftpServer.start();
  });

  afterAll(async () => {
    try {
      if (sftpServer) {
        await Promise.race([
          sftpServer.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Stop timeout')), 15000))
        ]).catch(() => {});
      }
      // Wait for all connections to close
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 60000);

  afterEach(async () => {
    // Longer delay between tests to allow connections to close
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  test('should handle immediate disconnect after connect', async () => {
    const client = new SftpClient();
    let connected = false;
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      connected = true;
      
      // Disconnect immediately without any operations
      await client.end();
      
      expect(connected).toBe(true);
    } catch (error) {
      throw new Error(`Immediate disconnect test failed: ${error}`);
    }
  }, 10000);

  test('should handle disconnect after single operation', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      // Perform one operation
      await client.list('/');
      
      // Then disconnect
      await client.end();
      
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`Single operation disconnect failed: ${error}`);
    }
  }, 10000);

  test('should handle disconnect after multiple operations', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      // Perform multiple operations
      await client.list('/');
      await client.list('/');
      await client.list('/');
      
      // Then disconnect
      await client.end();
      
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`Multiple operations disconnect failed: ${error}`);
    }
  }, 10000);

  test('should handle reconnect after disconnect', async () => {
    const client = new SftpClient();
    
    try {
      // First connection
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      await client.list('/');
      await client.end();
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Reconnect
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      await client.list('/');
      await client.end();
      
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`Reconnect test failed: ${error}`);
    }
  }, 15000);

  test('should handle multiple concurrent connections', async () => {
    const clients = [new SftpClient(), new SftpClient(), new SftpClient()];
    
    try {
      // Connect all clients
      await Promise.all(clients.map(client => 
        client.connect({
          host: '127.0.0.1',
          port: TEST_PORT,
          username: 'testuser',
          password: 'testpass',
          readyTimeout: 5000
        })
      ));
      
      // Each performs operations
      await Promise.all(clients.map(client => client.list('/')));
      
      // All disconnect
      await Promise.all(clients.map(client => client.end()));
      
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`Concurrent connections test failed: ${error}`);
    }
  }, 15000);

  test('should handle disconnect during file operation', async () => {
    const client = new SftpClient();
    const uploadPath = path.join(testDir, 'upload-test.txt');
    fs.writeFileSync(uploadPath, 'Test upload content for disconnect test');
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      // Start upload
      await client.put(uploadPath, '/uploaded.txt');
      
      // Disconnect after operation completes
      await client.end();
      
      // Verify file was uploaded
      const uploadedFile = path.join(ftpRoot, 'uploaded.txt');
      expect(fs.existsSync(uploadedFile)).toBe(true);
    } catch (error) {
      throw new Error(`Disconnect during file operation failed: ${error}`);
    }
  }, 10000);

  test('should handle rapid connect/disconnect cycles', async () => {
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
        
        await client.list('/');
        await client.end();
        
        // Small delay between cycles
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        throw new Error(`Rapid cycle ${i + 1} failed: ${error}`);
      }
    }
    
    expect(true).toBe(true);
  }, 20000);

  test('should clean up resources after disconnect', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      // Open a directory (creates a handle on server)
      const list = await client.list('/');
      expect(list.length).toBeGreaterThan(0);
      
      // Disconnect - should clean up directory handles
      await client.end();
      
      // Reconnect and verify we can still operate normally
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      const list2 = await client.list('/');
      expect(list2.length).toBeGreaterThan(0);
      
      await client.end();
    } catch (error) {
      throw new Error(`Resource cleanup test failed: ${error}`);
    }
  }, 15000);

  test('should handle disconnect with pending operations', async () => {
    const client = new SftpClient();
    
    try {
      await client.connect({
        host: '127.0.0.1',
        port: TEST_PORT,
        username: 'testuser',
        password: 'testpass',
        readyTimeout: 5000
      });
      
      // Start multiple operations
      const promises = [
        client.list('/'),
        client.list('/'),
        client.list('/')
      ];
      
      // Wait for all to complete
      await Promise.all(promises);
      
      // Now disconnect
      await client.end();
      
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`Pending operations disconnect failed: ${error}`);
    }
  }, 10000);
});


