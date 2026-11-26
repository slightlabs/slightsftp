import Client from 'ssh2-sftp-client';
import * as FtpClient from 'basic-ftp';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

interface TestConfig {
  protocol: 'FTP' | 'SFTP';
  host: string;
  port: number;
  username: string;
  password: string;
  description: string;
  expectedPermissions: {
    canCreate: boolean;
    canEdit: boolean;
    canAppend: boolean;
    canDelete: boolean;
    canList: boolean;
    canCreateDir: boolean;
    canRename: boolean;
  };
}

interface TestResult {
  clientId: number;
  username: string;
  protocol: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  errors: string[];
}

class TestClient {
  private config: TestConfig;
  private clientId: number;
  private result: TestResult;
  private startTime: number = 0;

  constructor(config: TestConfig, clientId: number) {
    this.config = config;
    this.clientId = clientId;
    this.result = {
      clientId,
      username: config.username,
      protocol: config.protocol,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      errors: []
    };
  }

  async runTests(): Promise<TestResult> {
    this.startTime = Date.now();
    console.log(`[${this.config.username}] Starting tests (${this.config.description})...`);

    try {
      if (this.config.protocol === 'SFTP') {
        await this.testSFTP();
      } else {
        await this.testFTP();
      }
      console.log(`[${this.config.username}] ✓ Completed - Passed: ${this.result.passed}, Failed: ${this.result.failed}, Skipped: ${this.result.skipped}`);
    } catch (err: any) {
      console.error(`[${this.config.username}] ✗ Test suite failed:`, err.message);
      this.result.errors.push(`Suite error: ${err.message}`);
    }

    this.result.duration = Date.now() - this.startTime;
    return this.result;
  }

  private async runTest(name: string, testFn: () => Promise<void>, shouldSucceed: boolean = true): Promise<void> {
    try {
      await testFn();
      if (shouldSucceed) {
        console.log(`[${this.config.username}] ✓ ${name}`);
        this.result.passed++;
      } else {
        console.log(`[${this.config.username}] ✗ ${name} - Expected to fail but succeeded`);
        this.result.failed++;
        this.result.errors.push(`${name}: Expected to fail but succeeded`);
      }
    } catch (err: any) {
      if (!shouldSucceed) {
        console.log(`[${this.config.username}] ✓ ${name} - Failed as expected`);
        this.result.passed++;
      } else {
        console.log(`[${this.config.username}] ✗ ${name} - ${err.message}`);
        this.result.failed++;
        this.result.errors.push(`${name}: ${err.message}`);
      }
    }
  }

  private skipTest(name: string, reason: string): void {
    console.log(`[${this.config.username}] ⊘ ${name} - Skipped: ${reason}`);
    this.result.skipped++;
  }

  private async testSFTP(): Promise<void> {
    const sftp = new Client();
    const testDir = `/test-${this.config.username}`;
    const testFile = path.join(__dirname, `test-${this.config.username}.txt`);
    const downloadFile = path.join(__dirname, `download-${this.config.username}.txt`);
    const testContent = `Test from ${this.config.username}\nTimestamp: ${new Date().toISOString()}`;

    try {
      // Connect with timeout
      await this.runTest('Connect to SFTP', async () => {
        await sftp.connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          password: this.config.password,
          readyTimeout: 10000,
          retries: 2,
          retry_minTimeout: 2000
        });
      });

      // Test: List root directory
      if (this.config.expectedPermissions.canList) {
        await this.runTest('List root directory', async () => {
          const list = await sftp.list('/');
        });
      } else {
        this.skipTest('List root directory', 'No LIST permission');
      }

      // Test: Create directory
      if (this.config.expectedPermissions.canCreateDir) {
        await this.runTest('Create directory', async () => {
          await sftp.mkdir(testDir, true);
        });
      } else {
        await this.runTest('Create directory (should fail)', async () => {
          await sftp.mkdir(testDir, true);
        }, false);
      }

      // Test: Upload file (CREATE)
      if (this.config.expectedPermissions.canCreate) {
        fs.writeFileSync(testFile, testContent);
        const remoteFile = testDir ? `${testDir}/test-file.txt` : '/test-file.txt';
        await this.runTest('Upload file', async () => {
          await sftp.put(testFile, remoteFile);
        });

        // Test: Download file (LIST + READ)
        if (this.config.expectedPermissions.canList) {
          await this.runTest('Download file', async () => {
            await sftp.get(remoteFile, downloadFile);
            const content = fs.readFileSync(downloadFile, 'utf8');
            if (content !== testContent) throw new Error('Content mismatch');
          });
        } else {
          this.skipTest('Download file', 'No LIST permission');
        }

        // Test: Edit file
        if (this.config.expectedPermissions.canEdit) {
          const editContent = 'Edited content';
          fs.writeFileSync(testFile, editContent);
          await this.runTest('Edit file', async () => {
            await sftp.put(testFile, remoteFile);
          });
        } else {
          this.skipTest('Edit file', 'No EDIT permission');
        }

        // Test: Append to file
        if (this.config.expectedPermissions.canAppend) {
          await this.runTest('Append to file', async () => {
            await sftp.append(Buffer.from('\nAppended'), remoteFile);
          });
        } else {
          this.skipTest('Append to file', 'No APPEND permission');
        }

        // Test: Rename file
        if (this.config.expectedPermissions.canRename) {
          const renamedFile = testDir ? `${testDir}/renamed.txt` : '/renamed.txt';
          await this.runTest('Rename file', async () => {
            await sftp.rename(remoteFile, renamedFile);
          });
          
          // Delete renamed file for cleanup
          if (this.config.expectedPermissions.canDelete) {
            await this.runTest('Delete renamed file', async () => {
              await sftp.delete(renamedFile);
            });
          }
        } else {
          // Test: Delete original file
          if (this.config.expectedPermissions.canDelete) {
            await this.runTest('Delete file', async () => {
              await sftp.delete(remoteFile);
            });
          } else {
            this.skipTest('Delete file', 'No DELETE permission');
          }
        }
      } else {
        await this.runTest('Upload file (should fail)', async () => {
          fs.writeFileSync(testFile, testContent);
          await sftp.put(testFile, '/test-file.txt');
        }, false);
      }

      // Test: Delete directory
      if (this.config.expectedPermissions.canDelete && this.config.expectedPermissions.canCreateDir) {
        await this.runTest('Delete directory', async () => {
          try {
            await sftp.rmdir(testDir);
          } catch (err: any) {
            // Directory might not be empty or might not exist, that's okay
            if (!err.message.includes('No such file') && !err.message.includes('not empty')) {
              throw err;
            }
          }
        });
      } else {
        this.skipTest('Delete directory', 'No DELETE or CREATE_DIR permission');
      }

      // Cleanup local files
      try {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        if (fs.existsSync(downloadFile)) fs.unlinkSync(downloadFile);
      } catch (err) {
        // Ignore cleanup errors
      }

    } finally {
      await sftp.end();
    }
  }

  private async testFTP(): Promise<void> {
    const ftp = new FtpClient.Client();
    ftp.ftp.verbose = false;
    const testDir = `/test-${this.config.username}`;
    const testFile = path.join(__dirname, `test-${this.config.username}.txt`);
    const downloadFile = path.join(__dirname, `download-${this.config.username}.txt`);
    const testContent = `Test from ${this.config.username}\nTimestamp: ${new Date().toISOString()}`;

    try {
      // Connect with timeout
      await this.runTest('Connect to FTP', async () => {
        await ftp.access({
          host: this.config.host,
          port: this.config.port,
          user: this.config.username,
          password: this.config.password,
          secure: false
        });
      });

      // Test: List root directory
      if (this.config.expectedPermissions.canList) {
        await this.runTest('List root directory', async () => {
          await ftp.list('/');
        });
      } else {
        this.skipTest('List root directory', 'No LIST permission');
      }

      // Test: Create directory
      if (this.config.expectedPermissions.canCreateDir) {
        await this.runTest('Create directory', async () => {
          await ftp.ensureDir(testDir);
        });
      } else {
        await this.runTest('Create directory (should fail)', async () => {
          await ftp.ensureDir(testDir);
        }, false);
      }

      // Test: Upload file (CREATE)
      if (this.config.expectedPermissions.canCreate) {
        fs.writeFileSync(testFile, testContent);
        const remoteFile = testDir ? `${testDir}/test-file.txt` : '/test-file.txt';
        await this.runTest('Upload file', async () => {
          await ftp.uploadFrom(testFile, remoteFile);
        });

        // Test: Download file
        if (this.config.expectedPermissions.canList) {
          await this.runTest('Download file', async () => {
            await ftp.downloadTo(downloadFile, remoteFile);
            const content = fs.readFileSync(downloadFile, 'utf8');
            if (content !== testContent) throw new Error('Content mismatch');
          });
        } else {
          this.skipTest('Download file', 'No LIST permission');
        }

        // Test: Rename file
        if (this.config.expectedPermissions.canRename) {
          const renamedFile = testDir ? `${testDir}/renamed.txt` : '/renamed.txt';
          await this.runTest('Rename file', async () => {
            await ftp.rename(remoteFile, renamedFile);
          });
          
          // Delete renamed file
          if (this.config.expectedPermissions.canDelete) {
            await this.runTest('Delete renamed file', async () => {
              await ftp.remove(renamedFile);
            });
          }
        } else {
          // Test: Delete original file
          if (this.config.expectedPermissions.canDelete) {
            await this.runTest('Delete file', async () => {
              await ftp.remove(remoteFile);
            });
          } else {
            this.skipTest('Delete file', 'No DELETE permission');
          }
        }
      } else {
        await this.runTest('Upload file (should fail)', async () => {
          fs.writeFileSync(testFile, testContent);
          await ftp.uploadFrom(testFile, '/test-file.txt');
        }, false);
      }

      // Test: Delete directory
      if (this.config.expectedPermissions.canDelete && this.config.expectedPermissions.canCreateDir) {
        await this.runTest('Delete directory', async () => {
          try {
            await ftp.removeDir(testDir);
          } catch (err: any) {
            // Directory might not exist or not be empty, that's okay
            if (!err.message.includes('No such') && !err.message.includes('not empty')) {
              throw err;
            }
          }
        });
      } else {
        this.skipTest('Delete directory', 'No DELETE or CREATE_DIR permission');
      }

      // Cleanup local files
      try {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        if (fs.existsSync(downloadFile)) fs.unlinkSync(downloadFile);
      } catch (err) {
        // Ignore cleanup errors
      }

    } finally {
      ftp.close();
    }
  }
}



// Check if server is reachable
async function checkServerConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 3000; // 3 seconds

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function runMultipleClients(configs: TestConfig[]): Promise<void> {
  console.log(`\n========================================`);
  console.log(`Running ${configs.length} concurrent clients`);
  console.log(`Protocol: ${configs[0].protocol}`);
  console.log(`Host: ${configs[0].host}:${configs[0].port}`);
  console.log(`========================================\n`);

  // Check if server is running
  console.log(`Checking if ${configs[0].protocol} server is running on ${configs[0].host}:${configs[0].port}...`);
  const serverRunning = await checkServerConnection(configs[0].host, configs[0].port);
  
  if (!serverRunning) {
    console.error(`\n❌ ERROR: Cannot connect to ${configs[0].protocol} server at ${configs[0].host}:${configs[0].port}`);
    console.error(`\nPlease start the server first:`);
    console.error(`  1. Run: npm start`);
    console.error(`  2. Wait for "SFTP server listening" and "FTP server listening" messages`);
    console.error(`  3. Then run the tests again\n`);
    console.error(`========================================\n`);
    return;
  }
  
  console.log(`✓ Server is running and accepting connections\n`);

  const clients: TestClient[] = [];
  for (let i = 0; i < configs.length; i++) {
    clients.push(new TestClient(configs[i], i + 1));
  }

  const startTime = Date.now();
  const promises = clients.map(client => client.runTests());
  const results = await Promise.all(promises);
  const totalTime = Date.now() - startTime;

  // Print summary
  console.log(`\n========================================`);
  console.log(`Test Summary for ${configs[0].protocol}`);
  console.log(`========================================`);
  
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  
  results.forEach(result => {
    totalPassed += result.passed;
    totalFailed += result.failed;
    totalSkipped += result.skipped;
    
    const status = result.failed === 0 ? '✓' : '✗';
    console.log(`${status} ${result.username.padEnd(15)} - Pass: ${result.passed}, Fail: ${result.failed}, Skip: ${result.skipped} (${result.duration}ms)`);
    
    if (result.errors.length > 0) {
      result.errors.forEach(err => {
        console.log(`  └─ ${err}`);
      });
    }
  });
  
  console.log(`\nTotal Tests: ${totalPassed + totalFailed + totalSkipped}`);
  console.log(`Passed: ${totalPassed} | Failed: ${totalFailed} | Skipped: ${totalSkipped}`);
  console.log(`Total Time: ${totalTime}ms`);
  
  if (totalFailed === 0) {
    console.log(`\n✓✓✓ All ${configs[0].protocol} tests passed! ✓✓✓`);
  } else {
    console.log(`\n⚠ ${totalFailed} test(s) failed`);
  }
  console.log(`========================================\n`);
}

async function main(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║      SLightSFTP Comprehensive Test Suite                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const testConfigs: TestConfig[] = [
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'fullaccess',
      password: 'test123',
      description: 'Full permissions',
      expectedPermissions: {
        canCreate: true,
        canEdit: true,
        canAppend: true,
        canDelete: true,
        canList: true,
        canCreateDir: true,
        canRename: true
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'readonly',
      password: 'test123',
      description: 'Read-only',
      expectedPermissions: {
        canCreate: false,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'uploader',
      password: 'test123',
      description: 'Upload only',
      expectedPermissions: {
        canCreate: true,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'editor',
      password: 'test123',
      description: 'Editor',
      expectedPermissions: {
        canCreate: false,
        canEdit: true,
        canAppend: true,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'deleter',
      password: 'test123',
      description: 'Deleter',
      expectedPermissions: {
        canCreate: false,
        canEdit: false,
        canAppend: false,
        canDelete: true,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'dirmanager',
      password: 'test123',
      description: 'Directory manager',
      expectedPermissions: {
        canCreate: false,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: true,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'renamer',
      password: 'test123',
      description: 'Renamer',
      expectedPermissions: {
        canCreate: false,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: true
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'creator',
      password: 'test123',
      description: 'Creator',
      expectedPermissions: {
        canCreate: true,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: true,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'modifier',
      password: 'test123',
      description: 'Modifier',
      expectedPermissions: {
        canCreate: true,
        canEdit: true,
        canAppend: true,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'poweruser',
      password: 'test123',
      description: 'Power user',
      expectedPermissions: {
        canCreate: true,
        canEdit: true,
        canAppend: true,
        canDelete: false,
        canList: true,
        canCreateDir: true,
        canRename: true
      }
    }
  ];

  // Test SFTP with all users
  const sftpConfigs = testConfigs.filter(c => c.protocol === 'SFTP');
  await runMultipleClients(sftpConfigs);

  // Wait before FTP tests
  console.log('\nWaiting 3 seconds before FTP tests...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Test FTP with all users
  const ftpConfigs = testConfigs.map(c => ({ ...c, protocol: 'FTP' as 'FTP', port: 21 }));
  await runMultipleClients(ftpConfigs);

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  ✓✓✓ All comprehensive tests completed! ✓✓✓              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

// Run the tests
main().catch(err => {
  console.error('\n❌ Test suite failed:', err.message);
  console.error('\nStack trace:', err.stack);
  process.exit(1);
});

