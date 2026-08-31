import { FTPServer } from '../ftp-server';
import { DatabaseManager } from '../database';
const FtpClient = require('ftp');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('FTP Server Integration Tests', () => {
  let db: DatabaseManager;
  let ftpServer: FTPServer;
  let testDir: string;
  let ftpRoot: string;
  const TEST_PORT = 21212; // Use a different port for testing

  beforeAll(async () => {
    // Create temporary directories
    testDir = path.join(os.tmpdir(), `ftp-test-${Date.now()}`);
    ftpRoot = path.join(testDir, 'ftp-root');
    fs.mkdirSync(ftpRoot, { recursive: true });

    // Create test files
    fs.writeFileSync(path.join(ftpRoot, 'test1.txt'), 'Hello FTP World');
    fs.writeFileSync(path.join(ftpRoot, 'test2.txt'), 'FTP Test File 2');
    fs.mkdirSync(path.join(ftpRoot, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(ftpRoot, 'subdir', 'nested.txt'), 'Nested FTP file');

    // Initialize database
    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    // Create test user
    db.createUser({
      username: 'ftpuser',
      password: 'ftppass',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: false
    });

    const user = db.getUser('ftpuser');
    expect(user).toBeDefined();

    // Create listener
    const listenerId = db.createListener({
      name: 'Test FTP',
      protocol: 'FTP',
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

    // Start FTP server
    ftpServer = new FTPServer(listener!, db);
    await ftpServer.start();

    // Give the server a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 30000);

  afterAll(async () => {
    try {
      if (ftpServer) {
        await Promise.race([
          ftpServer.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Stop timeout')), 15000))
        ]).catch(() => {
          console.log('Force closing FTP server');
        });
      }
      // Wait for all connections to close
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('FTP cleanup error:', error);
    }
  }, 60000);

  afterEach(async () => {
    // Longer delay between tests to allow connections to close
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  test('should connect and authenticate with FTP', (done) => {
    const client = new FtpClient();
    
    client.on('ready', () => {
      client.end();
      done();
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should list FTP directory contents', (done) => {
    const client = new FtpClient();
    
    client.on('ready', () => {
      client.list('/', (err: Error, list: any[]) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        expect(list.length).toBeGreaterThanOrEqual(2);
        const hasTest1 = list.some((f: any) => f.name === 'test1.txt');
        const hasTest2 = list.some((f: any) => f.name === 'test2.txt');
        const hasSubdir = list.some((f: any) => f.name === 'subdir');
        
        expect(hasTest1 || hasTest2 || hasSubdir).toBe(true);
        
        client.end();
        done();
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should download file via FTP', (done) => {
    const client = new FtpClient();
    const downloadPath = path.join(testDir, 'downloaded-ftp.txt');
    
    client.on('ready', () => {
      client.get('/test1.txt', (err: Error, stream: NodeJS.ReadableStream) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        const writeStream = fs.createWriteStream(downloadPath);
        stream.pipe(writeStream);

        writeStream.on('finish', () => {
          const content = fs.readFileSync(downloadPath, 'utf8');
          expect(content).toBe('Hello FTP World');
          client.end();
          done();
        });

        writeStream.on('error', (err: Error) => {
          client.end();
          done(err);
        });
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should upload file via FTP', (done) => {
    const client = new FtpClient();
    const uploadPath = path.join(testDir, 'upload-test.txt');
    fs.writeFileSync(uploadPath, 'FTP Upload Test Content');
    
    client.on('ready', () => {
      client.put(uploadPath, '/uploaded-ftp.txt', (err: Error) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        // Verify file exists
        const uploadedFile = path.join(ftpRoot, 'uploaded-ftp.txt');
        expect(fs.existsSync(uploadedFile)).toBe(true);
        
        const content = fs.readFileSync(uploadedFile, 'utf8');
        expect(content).toBe('FTP Upload Test Content');
        
        client.end();
        done();
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should create directory via FTP', (done) => {
    const client = new FtpClient();
    
    client.on('ready', () => {
      client.mkdir('/ftpnewdir', (err: Error) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        const newDir = path.join(ftpRoot, 'ftpnewdir');
        expect(fs.existsSync(newDir)).toBe(true);
        expect(fs.statSync(newDir).isDirectory()).toBe(true);
        
        client.end();
        done();
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should delete file via FTP', (done) => {
    const client = new FtpClient();
    const deleteFile = path.join(ftpRoot, 'delete-ftp.txt');
    fs.writeFileSync(deleteFile, 'Delete me via FTP');
    
    client.on('ready', () => {
      client.delete('/delete-ftp.txt', (err: Error) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        expect(fs.existsSync(deleteFile)).toBe(false);
        
        client.end();
        done();
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should rename file via FTP', (done) => {
    const client = new FtpClient();
    const oldFile = path.join(ftpRoot, 'ftp-old.txt');
    const newFile = path.join(ftpRoot, 'ftp-new.txt');
    fs.writeFileSync(oldFile, 'Rename me via FTP');
    
    client.on('ready', () => {
      client.rename('/ftp-old.txt', '/ftp-new.txt', (err: Error) => {
        if (err) {
          client.end();
          done(err);
          return;
        }

        expect(fs.existsSync(oldFile)).toBe(false);
        expect(fs.existsSync(newFile)).toBe(true);
        
        const content = fs.readFileSync(newFile, 'utf8');
        expect(content).toBe('Rename me via FTP');
        
        client.end();
        done();
      });
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);

  test('should handle disconnect gracefully', (done) => {
    const client = new FtpClient();
    let readyCalled = false;
    
    client.on('ready', () => {
      readyCalled = true;
      client.end();
    });

    client.on('end', () => {
      expect(readyCalled).toBe(true);
      done();
    });

    client.on('error', (err: Error) => {
      done(err);
    });

    client.connect({
      host: '127.0.0.1',
      port: TEST_PORT,
      user: 'ftpuser',
      password: 'ftppass'
    });
  }, 15000);
});


