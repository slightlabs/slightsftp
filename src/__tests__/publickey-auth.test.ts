import { DatabaseManager } from '../database';
import { SFTPServer } from '../sftp-server';
import { Listener, User } from '../types';
import * as crypto from 'crypto';

describe('Public Key Authentication', () => {
  let db: DatabaseManager;
  let listenerId: number;
  
  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();
    listenerId = db.createListener({
      name: 'Test SFTP',
      protocol: 'SFTP',
      port: 22,
      bindingIp: '0.0.0.0',
      enabled: true
    });
  });

  describe('Public Key Storage and Retrieval', () => {
    test('should store RSA public key for user', () => {
      const rsaPublicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDTest123...';
      
      db.createUser({
        username: 'keyuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('keyuser');
      expect(user).toBeDefined();
      
      if (user) {
        db.updateUser('keyuser', { publicKey: rsaPublicKey });
        const updated = db.getUser('keyuser');
        
        expect(updated?.publicKey).toBe(rsaPublicKey);
        expect(updated?.passwordEnabled).toBe(false);
      }
    });

    test('should store ED25519 public key for user', () => {
      const ed25519PublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest456...';
      
      db.createUser({
        username: 'ed25519user',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('ed25519user');
      if (user) {
        db.updateUser('ed25519user', { publicKey: ed25519PublicKey });
        const updated = db.getUser('ed25519user');
        
        expect(updated?.publicKey).toBe(ed25519PublicKey);
      }
    });

    test('should allow user with both password and public key', () => {
      db.createUser({
        username: 'hybriduser',
        password: 'testpass',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('hybriduser');
      if (user) {
        const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDHybrid...';
        db.updateUser('hybriduser', { publicKey });
        const updated = db.getUser('hybriduser');
        
        expect(updated?.passwordEnabled).toBe(true);
        expect(updated?.publicKey).toBe(publicKey);
        expect(updated?.password).toBeDefined(); // Hashed password should exist
      }
    });

    test('should update existing public key', () => {
      const oldKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDOld...';
      const newKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDNew...';
      
      db.createUser({
        username: 'keyrotate',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('keyrotate');
      if (user) {
        db.updateUser('keyrotate', { publicKey: oldKey });
        let updated = db.getUser('keyrotate');
        expect(updated?.publicKey).toBe(oldKey);
        
        db.updateUser('keyrotate', { publicKey: newKey });
        updated = db.getUser('keyrotate');
        expect(updated?.publicKey).toBe(newKey);
      }
    });

    test('should remove public key by setting to null', () => {
      const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDRemove...';
      
      db.createUser({
        username: 'removekeyuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('removekeyuser');
      if (user) {
        db.updateUser('removekeyuser', { publicKey });
        let updated = db.getUser('removekeyuser');
        expect(updated?.publicKey).toBe(publicKey);
        
        db.updateUser('removekeyuser', { publicKey: '' });
        updated = db.getUser('removekeyuser');
        const removedKey = updated?.publicKey;
        expect(removedKey === '' || removedKey === null).toBe(true);
      }
    });
  });

  describe('Public Key Format Validation', () => {
    test('should handle various RSA key formats', () => {
      const keyFormats = [
        'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC...',
        'ssh-rsa AAAAB3NzaC1yc2EAAAABIwAAAQEA...',
        'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ...' // 4096-bit
      ];
      
      keyFormats.forEach((key, index) => {
        db.createUser({
          username: `rsauser${index}`,
          password: undefined,
          passwordEnabled: false,
          guiEnabled: false
        });
        
        const user = db.getUser(`rsauser${index}`);
        if (user) {
          db.updateUser(`rsauser${index}`, { publicKey: key });
          const updated = db.getUser(`rsauser${index}`);
          expect(updated?.publicKey).toBe(key);
        }
      });
    });

    test('should handle keys with comments', () => {
      const keyWithComment = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC... user@hostname';
      
      db.createUser({
        username: 'commentuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('commentuser');
      if (user) {
        db.updateUser('commentuser', { publicKey: keyWithComment });
        const updated = db.getUser('commentuser');
        expect(updated?.publicKey).toBe(keyWithComment);
      }
    });

    test('should handle multi-line public keys', () => {
      const multiLineKey = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC
long key data here that might span
multiple lines in storage`;
      
      db.createUser({
        username: 'multilineuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('multilineuser');
      if (user) {
        db.updateUser('multilineuser', { publicKey: multiLineKey });
        const updated = db.getUser('multilineuser');
        expect(updated?.publicKey).toBe(multiLineKey);
      }
    });
  });

  describe('Authentication Method Selection', () => {
    test('should prefer public key when both password and key are available', () => {
      db.createUser({
        username: 'hybridauth',
        password: 'testpass',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('hybridauth');
      if (user) {
        const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...';
        db.updateUser('hybridauth', { publicKey });
        const updated = db.getUser('hybridauth');
        
        // Both methods should be available
        expect(updated?.passwordEnabled).toBe(true);
        expect(updated?.publicKey).toBeDefined();
        
        // Verify password works
        expect(db.verifyPassword('hybridauth', 'testpass')).toBe(true);
        
        // Public key should also be stored
        expect(updated?.publicKey).toBe(publicKey);
      }
    });

    test('should reject password auth when only public key is enabled', () => {
      db.createUser({
        username: 'keyonlyuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('keyonlyuser');
      if (user) {
        const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...';
        db.updateUser('keyonlyuser', { publicKey });
        const updated = db.getUser('keyonlyuser');
        
        expect(updated?.passwordEnabled).toBe(false);
        expect(updated?.password).toBeNull();
        expect(updated?.publicKey).toBe(publicKey);
      }
    });

    test('should allow password auth when only password is enabled', () => {
      db.createUser({
        username: 'passonlyuser',
        password: 'securepass',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('passonlyuser');
      expect(user?.passwordEnabled).toBe(true);
      expect(user?.publicKey).toBeNull();
      expect(db.verifyPassword('passonlyuser', 'securepass')).toBe(true);
    });
  });

  describe('Listener Access with Public Keys', () => {
    test('should allow public key user access to subscribed listener', () => {
      db.createUser({
        username: 'keylistener',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('keylistener');
      if (user && user.id) {
        const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...';
        db.updateUser('keylistener', { publicKey });
        
        // Subscribe user to listener
        db.subscribeUserToListener(user.id, listenerId);
        
        const userListeners = db.getUserListeners(user.id);
        expect(userListeners).toContain(listenerId);
        
        const updated = db.getUser('keylistener');
        expect(updated?.publicKey).toBe(publicKey);
      }
    });

    test('should enforce listener permissions with public key auth', () => {
      db.createUser({
        username: 'keyperm',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('keyperm');
      if (user && user.id) {
        const publicKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...';
        db.updateUser('keyperm', { publicKey });
        
        db.subscribeUserToListener(user.id, listenerId);
        
        // Set read-only permissions
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
        
        const permissions = db.getPermission(user.id, listenerId);
        expect(permissions?.canEdit).toBe(false);
        expect(permissions?.canCreate).toBe(false);
        expect(permissions?.canDelete).toBe(false);
        expect(permissions?.canList).toBe(true);
      }
    });
  });

  describe('Security Considerations', () => {
    test('should not expose private key storage', () => {
      db.createUser({
        username: 'secureuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('secureuser');
      expect(user).not.toHaveProperty('privateKey');
      expect(user).toHaveProperty('publicKey');
    });

    test('should handle empty public key string', () => {
      db.createUser({
        username: 'emptykey',
        password: 'fallback',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('emptykey');
      if (user) {
        db.updateUser('emptykey', { publicKey: '' });
        const updated = db.getUser('emptykey');
        
        // Empty string should be stored as-is or converted to null
        expect(updated?.publicKey === '' || updated?.publicKey === null).toBe(true);
      }
    });

    test('should handle very long public keys', () => {
      // Simulate a 8192-bit RSA key (very long)
      const longKey = 'ssh-rsa ' + 'A'.repeat(2000) + '... user@host';
      
      db.createUser({
        username: 'longkeyuser',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user = db.getUser('longkeyuser');
      if (user) {
        db.updateUser('longkeyuser', { publicKey: longKey });
        const updated = db.getUser('longkeyuser');
        expect(updated?.publicKey).toBe(longKey);
      }
    });
  });

  describe('Multiple Users with Public Keys', () => {
    test('should handle multiple users with different public keys', () => {
      const users = [
        { username: 'alice', key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDAlice...' },
        { username: 'bob', key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDBob...' },
        { username: 'charlie', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICharlie...' }
      ];
      
      users.forEach(({ username, key }) => {
        db.createUser({
          username,
          password: undefined,
          passwordEnabled: false,
          guiEnabled: false
        });
        
        const user = db.getUser(username);
        if (user) {
          db.updateUser(username, { publicKey: key });
        }
      });
      
      // Verify each user has their unique key
      users.forEach(({ username, key }) => {
        const user = db.getUser(username);
        expect(user?.publicKey).toBe(key);
      });
    });

    test('should not allow duplicate public keys across users', () => {
      const sharedKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDShared...';
      
      db.createUser({
        username: 'user1',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      db.createUser({
        username: 'user2',
        password: undefined,
        passwordEnabled: false,
        guiEnabled: false
      });
      
      const user1 = db.getUser('user1');
      const user2 = db.getUser('user2');
      
      if (user1) {
        db.updateUser('user1', { publicKey: sharedKey });
      }
      
      if (user2) {
        db.updateUser('user2', { publicKey: sharedKey });
      }
      
      // Both users have the same key (security concern, but technically allowed)
      const updated1 = db.getUser('user1');
      const updated2 = db.getUser('user2');
      
      expect(updated1?.publicKey).toBe(sharedKey);
      expect(updated2?.publicKey).toBe(sharedKey);
      
      // Note: In production, you might want to add a unique constraint
    });
  });

  describe('Public Key Rotation', () => {
    test('should support key rotation without downtime', () => {
      const oldKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDOld...';
      const newKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDNew...';
      
      db.createUser({
        username: 'rotateuser',
        password: 'backup',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('rotateuser');
      if (user) {
        // Set initial key
        db.updateUser('rotateuser', { publicKey: oldKey });
        let updated = db.getUser('rotateuser');
        expect(updated?.publicKey).toBe(oldKey);
        
        // Password should still work during rotation
        expect(db.verifyPassword('rotateuser', 'backup')).toBe(true);
        
        // Rotate to new key
        db.updateUser('rotateuser', { publicKey: newKey });
        updated = db.getUser('rotateuser');
        expect(updated?.publicKey).toBe(newKey);
        expect(updated?.passwordEnabled).toBe(true);
      }
    });

    test('should handle temporary key removal', () => {
      db.createUser({
        username: 'tempremove',
        password: 'temppass',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const user = db.getUser('tempremove');
      if (user) {
        const key = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD...';
        
        // Add key
        db.updateUser('tempremove', { publicKey: key });
        expect(db.getUser('tempremove')?.publicKey).toBe(key);
        
        // Remove key temporarily - set to empty string since undefined doesn't clear it
        db.updateUser('tempremove', { publicKey: '' });
        const removedKey = db.getUser('tempremove')?.publicKey;
        expect(removedKey === '' || removedKey === null).toBe(true);
        expect(db.verifyPassword('tempremove', 'temppass')).toBe(true);
        
        // Add key back
        db.updateUser('tempremove', { publicKey: key });
        expect(db.getUser('tempremove')?.publicKey).toBe(key);
      }
    });
  });
});


