import Client from 'ssh2-sftp-client';
import * as FtpClient from 'basic-ftp';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

interface VirtualPathTestConfig {
  protocol: 'FTP' | 'SFTP';
  host: string;
  port: number;
  username: string;
  password: string;
  virtualPath: string;
  permissions: {
    canRead: boolean;
    canWrite: boolean;
    canAppend: boolean;
    canDelete: boolean;
    canList: boolean;
    canCreateDir: boolean;
    canRename: boolean;
  };
}

async function checkServerAvailable(port: number, maxRetries: number = 10): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host: 'localhost' }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
        socket.setTimeout(1000);
      });
      return true;
    } catch (err) {
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  return false;
}

async function testSFTPVirtualPath(config: VirtualPathTestConfig): Promise<void> {
  const client = new Client();
  const testFile = `${config.virtualPath}/test-vp-${Date.now()}.txt`;
  const testDir = `${config.virtualPath}/testdir-${Date.now()}`;
  const testContent = 'Virtual Path Permission Test';
  
  console.log(`\n=== Testing SFTP Virtual Path: ${config.virtualPath} (User: ${config.username}) ===`);
  console.log(`Permissions: Read=${config.permissions.canRead}, Write=${config.permissions.canWrite}, ` +
              `List=${config.permissions.canList}, Delete=${config.permissions.canDelete}, ` +
              `CreateDir=${config.permissions.canCreateDir}, Rename=${config.permissions.canRename}`);
  
  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password
    });
    console.log('✓ Connected to SFTP server');

    // Test LIST permission
    if (config.permissions.canList) {
      try {
        const list = await client.list(config.virtualPath);
        console.log(`✓ LIST allowed: Found ${list.length} items`);
      } catch (err) {
        console.error(`✗ LIST should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        await client.list(config.virtualPath);
        console.error(`✗ LIST should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ LIST correctly denied`);
      }
    }

    // Test WRITE permission
    if (config.permissions.canWrite) {
      try {
        const tempLocalFile = path.join(__dirname, `temp-upload-${Date.now()}.txt`);
        fs.writeFileSync(tempLocalFile, testContent);
        await client.put(tempLocalFile, testFile);
        fs.unlinkSync(tempLocalFile);
        console.log(`✓ WRITE allowed: Created file ${testFile}`);
        
        // Test READ permission
        if (config.permissions.canRead) {
          try {
            const tempDownloadFile = path.join(__dirname, `temp-download-${Date.now()}.txt`);
            await client.get(testFile, tempDownloadFile);
            console.log(`✓ READ allowed: Read file successfully`);
            fs.unlinkSync(tempDownloadFile);
          } catch (err) {
            console.error(`✗ READ should be allowed but failed: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        console.error(`✗ WRITE should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        const tempLocalFile = path.join(__dirname, `temp-upload-${Date.now()}.txt`);
        fs.writeFileSync(tempLocalFile, testContent);
        await client.put(tempLocalFile, testFile);
        fs.unlinkSync(tempLocalFile);
        console.error(`✗ WRITE should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ WRITE correctly denied`);
      }
    }

    // Test CREATE_DIR permission
    if (config.permissions.canCreateDir) {
      try {
        await client.mkdir(testDir);
        console.log(`✓ CREATE_DIR allowed: Created directory ${testDir}`);
      } catch (err) {
        console.error(`✗ CREATE_DIR should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        await client.mkdir(testDir);
        console.error(`✗ CREATE_DIR should be denied but was allowed`);
        await client.rmdir(testDir);
      } catch (err) {
        console.log(`✓ CREATE_DIR correctly denied`);
      }
    }

    // Test RENAME permission (if file was created)
    if (config.permissions.canWrite && config.permissions.canRename) {
      try {
        const newName = testFile.replace('.txt', '-renamed.txt');
        await client.rename(testFile, newName);
        console.log(`✓ RENAME allowed: Renamed file`);
        
        // Rename back for cleanup
        await client.rename(newName, testFile);
      } catch (err) {
        console.error(`✗ RENAME should be allowed but failed: ${(err as Error).message}`);
      }
    } else if (!config.permissions.canRename && config.permissions.canWrite) {
      try {
        const newName = testFile.replace('.txt', '-renamed.txt');
        await client.rename(testFile, newName);
        console.error(`✗ RENAME should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ RENAME correctly denied`);
      }
    }

    // Test DELETE permission (cleanup)
    if (config.permissions.canDelete) {
      if (config.permissions.canWrite) {
        try {
          await client.delete(testFile);
          console.log(`✓ DELETE allowed: Deleted test file`);
        } catch (err) {
          console.error(`✗ DELETE should be allowed but failed: ${(err as Error).message}`);
        }
      }
      
      if (config.permissions.canCreateDir) {
        try {
          await client.rmdir(testDir);
          console.log(`✓ DELETE (dir) allowed: Deleted test directory`);
        } catch (err) {
          console.error(`✗ DELETE (dir) should be allowed but failed: ${(err as Error).message}`);
        }
      }
    } else {
      if (config.permissions.canWrite) {
        try {
          await client.delete(testFile);
          console.error(`✗ DELETE should be denied but was allowed`);
        } catch (err) {
          console.log(`✓ DELETE correctly denied`);
        }
      }
    }

  } catch (err) {
    console.error(`✗ Connection failed: ${(err as Error).message}`);
  } finally {
    await client.end();
  }
}

async function testFTPVirtualPath(config: VirtualPathTestConfig): Promise<void> {
  const client = new FtpClient.Client();
  client.ftp.verbose = false;
  const testFile = path.join(config.virtualPath, `test-vp-${Date.now()}.txt`).replace(/\\/g, '/');
  const testDir = path.join(config.virtualPath, `testdir-${Date.now()}`).replace(/\\/g, '/');
  const testContent = 'Virtual Path Permission Test';
  
  console.log(`\n=== Testing FTP Virtual Path: ${config.virtualPath} (User: ${config.username}) ===`);
  console.log(`Permissions: Read=${config.permissions.canRead}, Write=${config.permissions.canWrite}, ` +
              `List=${config.permissions.canList}, Delete=${config.permissions.canDelete}, ` +
              `CreateDir=${config.permissions.canCreateDir}, Rename=${config.permissions.canRename}`);
  
  try {
    await client.access({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password
    });
    console.log('✓ Connected to FTP server');

    // Test LIST permission
    if (config.permissions.canList) {
      try {
        const list = await client.list(config.virtualPath);
        console.log(`✓ LIST allowed: Found ${list.length} items`);
      } catch (err) {
        console.error(`✗ LIST should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        await client.list(config.virtualPath);
        console.error(`✗ LIST should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ LIST correctly denied`);
      }
    }

    // Test WRITE permission
    if (config.permissions.canWrite) {
      try {
        await client.uploadFrom(Buffer.from(testContent) as any, testFile);
        console.log(`✓ WRITE allowed: Uploaded file ${testFile}`);
        
        // Test READ permission
        if (config.permissions.canRead) {
          try {
            await client.downloadTo(fs.createWriteStream(path.join(__dirname, 'temp-download.txt')), testFile);
            console.log(`✓ READ allowed: Downloaded file successfully`);
            fs.unlinkSync(path.join(__dirname, 'temp-download.txt'));
          } catch (err) {
            console.error(`✗ READ should be allowed but failed: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        console.error(`✗ WRITE should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        await client.uploadFrom(Buffer.from(testContent) as any, testFile);
        console.error(`✗ WRITE should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ WRITE correctly denied`);
      }
    }

    // Test CREATE_DIR permission
    if (config.permissions.canCreateDir) {
      try {
        await client.ensureDir(testDir);
        console.log(`✓ CREATE_DIR allowed: Created directory ${testDir}`);
      } catch (err) {
        console.error(`✗ CREATE_DIR should be allowed but failed: ${(err as Error).message}`);
      }
    } else {
      try {
        await client.ensureDir(testDir);
        console.error(`✗ CREATE_DIR should be denied but was allowed`);
        await client.removeDir(testDir);
      } catch (err) {
        console.log(`✓ CREATE_DIR correctly denied`);
      }
    }

    // Test RENAME permission (if file was created)
    if (config.permissions.canWrite && config.permissions.canRename) {
      try {
        const newName = testFile.replace('.txt', '-renamed.txt');
        await client.rename(testFile, newName);
        console.log(`✓ RENAME allowed: Renamed file`);
        
        // Rename back for cleanup
        await client.rename(newName, testFile);
      } catch (err) {
        console.error(`✗ RENAME should be allowed but failed: ${(err as Error).message}`);
      }
    } else if (!config.permissions.canRename && config.permissions.canWrite) {
      try {
        const newName = testFile.replace('.txt', '-renamed.txt');
        await client.rename(testFile, newName);
        console.error(`✗ RENAME should be denied but was allowed`);
      } catch (err) {
        console.log(`✓ RENAME correctly denied`);
      }
    }

    // Test DELETE permission (cleanup)
    if (config.permissions.canDelete) {
      if (config.permissions.canWrite) {
        try {
          await client.remove(testFile);
          console.log(`✓ DELETE allowed: Deleted test file`);
        } catch (err) {
          console.error(`✗ DELETE should be allowed but failed: ${(err as Error).message}`);
        }
      }
      
      if (config.permissions.canCreateDir) {
        try {
          await client.removeDir(testDir);
          console.log(`✓ DELETE (dir) allowed: Deleted test directory`);
        } catch (err) {
          console.error(`✗ DELETE (dir) should be allowed but failed: ${(err as Error).message}`);
        }
      }
    } else {
      if (config.permissions.canWrite) {
        try {
          await client.remove(testFile);
          console.error(`✗ DELETE should be denied but was allowed`);
        } catch (err) {
          console.log(`✓ DELETE correctly denied`);
        }
      }
    }

  } catch (err) {
    console.error(`✗ Connection failed: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

async function main() {
  console.log('=== Virtual Path Permissions Test Client ===\n');
  
  // Check if servers are running
  console.log('Checking server availability...');
  const sftpAvailable = await checkServerAvailable(22);
  const ftpAvailable = await checkServerAvailable(21);
  
  if (!sftpAvailable) {
    console.error('✗ SFTP server not available on Port 22');
  } else {
    console.log('✓ SFTP server available');
  }
  
  if (!ftpAvailable) {
    console.error('✗ FTP server not available on Port 21');
  } else {
    console.log('✓ FTP server available');
  }
  
  if (!sftpAvailable && !ftpAvailable) {
    console.error('\nNo servers available. Please start the servers first.');
    process.exit(1);
  }

  // Test configurations for different virtual path permission scenarios
  const tests: VirtualPathTestConfig[] = [
    // Full access virtual path
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'fullaccess',
      password: 'full123',
      virtualPath: '/',
      permissions: {
        canRead: true,
        canWrite: true,
        canAppend: true,
        canDelete: true,
        canList: true,
        canCreateDir: true,
        canRename: true
      }
    },
    // Read-only virtual path
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'readonly',
      password: 'read123',
      virtualPath: '/',
      permissions: {
        canRead: true,
        canWrite: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    },
    // Upload-only virtual path
    {
      protocol: 'SFTP',
      host: 'localhost',
      port: 22,
      username: 'uploader',
      password: 'upload123',
      virtualPath: '/',
      permissions: {
        canRead: false,
        canWrite: true,
        canAppend: true,
        canDelete: false,
        canList: false,
        canCreateDir: false,
        canRename: false
      }
    },
    // FTP Full access
    {
      protocol: 'FTP',
      host: 'localhost',
      port: 21,
      username: 'fullaccess',
      password: 'full123',
      virtualPath: '/',
      permissions: {
        canRead: true,
        canWrite: true,
        canAppend: true,
        canDelete: true,
        canList: true,
        canCreateDir: true,
        canRename: true
      }
    },
    // FTP Read-only
    {
      protocol: 'FTP',
      host: 'localhost',
      port: 21,
      username: 'readonly',
      password: 'read123',
      virtualPath: '/',
      permissions: {
        canRead: true,
        canWrite: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      }
    }
  ];

  for (const test of tests) {
    if (test.protocol === 'SFTP' && !sftpAvailable) {
      console.log(`\nSkipping SFTP test for ${test.username} (server unavailable)`);
      continue;
    }
    if (test.protocol === 'FTP' && !ftpAvailable) {
      console.log(`\nSkipping FTP test for ${test.username} (server unavailable)`);
      continue;
    }

    try {
      if (test.protocol === 'SFTP') {
        await testSFTPVirtualPath(test);
      } else {
        await testFTPVirtualPath(test);
      }
    } catch (err) {
      console.error(`Error testing ${test.protocol} ${test.username}:`, err);
    }
    
    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n=== Virtual Path Permissions Testing Complete ===\n');
}

main().catch(console.error);
