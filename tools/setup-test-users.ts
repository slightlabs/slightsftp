import { DatabaseManager } from '../src/database';
import * as path from 'path';
import * as fs from 'fs';

interface TestUser {
  username: string;
  password: string;
  description: string;
  permissions: {
    canRead: boolean;
    canCreate: boolean;
    canEdit: boolean;
    canAppend: boolean;
    canDelete: boolean;
    canList: boolean;
    canCreateDir: boolean;
    canRename: boolean;
  };
}

const testUsers: TestUser[] = [
  {
    username: 'fullaccess',
    password: 'test123',
    description: 'Full permissions - can do everything',
    permissions: {
      canRead: true,
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
    username: 'readonly',
    password: 'test123',
    description: 'Read-only user - can only list directories',
    permissions: {
      canRead: true,
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
    username: 'uploader',
    password: 'test123',
    description: 'Upload only - can create and list',
    permissions: {
      canRead: true,
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
    username: 'editor',
    password: 'test123',
    description: 'Editor - can edit and append existing files',
    permissions: {
      canRead: true,
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
    username: 'deleter',
    password: 'test123',
    description: 'Deleter - can delete files',
    permissions: {
      canRead: true,
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
    username: 'dirmanager',
    password: 'test123',
    description: 'Directory manager - can create directories',
    permissions: {
      canRead: true,
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
    username: 'renamer',
    password: 'test123',
    description: 'Renamer - can rename files',
    permissions: {
      canRead: true,
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
    username: 'creator',
    password: 'test123',
    description: 'Creator - can create files and directories',
    permissions: {
      canRead: true,
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
    username: 'modifier',
    password: 'test123',
    description: 'Modifier - can create, edit, and append',
    permissions: {
      canRead: true,
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
    username: 'poweruser',
    password: 'test123',
    description: 'Power user - can do everything except delete',
    permissions: {
      canRead: true,
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

async function setupTestUsers(): Promise<void> {
  console.log('Setting up test users...\n');

  const dbPath = path.join(process.cwd(), 'config.db');
  const db = new DatabaseManager(dbPath);
  await db.init();

  // Get all listeners to assign users to them
  const listeners = db.getAllListeners();
  if (listeners.length === 0) {
    console.error('Error: No listeners found. Please start the server first to create default listeners.');
    return;
  }

  console.log(`Found ${listeners.length} listener(s):`);
  listeners.forEach(l => console.log(`  - ${l.name} (${l.protocol}) on port ${l.port}`));
  console.log('');

  // Ensure ftp-root directory exists
  const ftpRoot = path.join(process.cwd(), 'ftp-root');
  if (!fs.existsSync(ftpRoot)) {
    fs.mkdirSync(ftpRoot, { recursive: true });
    console.log('Created ftp-root directory\n');
  }

  let createdCount = 0;
  let updatedCount = 0;

  for (const testUser of testUsers) {
    try {
      // Check if user exists
      const existingUser = db.getUser(testUser.username);

      let userId: number;
      if (existingUser) {
        console.log(`User '${testUser.username}' already exists - updating...`);
        db.updateUser(testUser.username, {
          password: testUser.password,
          passwordEnabled: true,
          guiEnabled: false
        });
        userId = existingUser.id!;
        updatedCount++;
      } else {
        console.log(`Creating user '${testUser.username}' (${testUser.description})`);
        userId = db.createUser({
          username: testUser.username,
          password: testUser.password,
          passwordEnabled: true,
          publicKey: undefined,
          guiEnabled: false
        });
        createdCount++;
      }

      // Ensure user has a virtual path
      const existingPaths = db.getVirtualPaths(userId);
      if (existingPaths.length === 0) {
        db.addVirtualPath({
          userId: userId,
          virtualPath: '/',
          localPath: ftpRoot
        });
        console.log(`  - Created virtual path mapping: / -> ${ftpRoot}`);
      }

      // Subscribe user to all listeners and set permissions
      for (const listener of listeners) {
        db.subscribeUserToListener(userId, listener.id!);
        
        // Check if permission already exists
        const existingPerm = db.getPermission(userId, listener.id!);
        if (existingPerm) {
          // Update existing permission
          db.setPermission({
            userId: userId,
            listenerId: listener.id!,
            ...testUser.permissions
          });
        } else {
          // Create new permission
          db.setPermission({
            userId: userId,
            listenerId: listener.id!,
            ...testUser.permissions
          });
        }
        console.log(`  - Subscribed to ${listener.name} with permissions:`, 
          Object.entries(testUser.permissions)
            .filter(([_, v]) => v)
            .map(([k, _]) => k.replace('can', ''))
            .join(', ') || 'NONE');
      }

      console.log('');
    } catch (err) {
      console.error(`Error setting up user ${testUser.username}:`, err);
    }
  }

  console.log(`\n========================================`);
  console.log(`Test users setup complete!`);
  console.log(`Created: ${createdCount} users`);
  console.log(`Updated: ${updatedCount} users`);
  console.log(`Total test users: ${testUsers.length}`);
  console.log(`========================================\n`);

  console.log('Test user credentials:');
  testUsers.forEach(u => {
    console.log(`  ${u.username.padEnd(15)} / ${u.password.padEnd(10)} - ${u.description}`);
  });
  console.log('');
}

setupTestUsers().catch(err => {
  console.error('Failed to setup test users:', err);
  process.exit(1);
});


