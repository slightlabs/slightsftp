import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { User, VirtualPath, Permission, Listener, UserListener, ServerActivity } from './types';

export class DatabaseManager {
  private db: Database | null = null;
  private dbPath: string;
  private initialized: boolean = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'config.db');
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const SQL = await initSqlJs();
    
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
    
    this.initialize();
    this.save();
    this.initialized = true;
  }

  private save(): void {
    if (!this.db) return;
    // Don't save in-memory databases
    if (this.dbPath === ':memory:') return;
    
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  private initialize(): void {
    if (!this.db) throw new Error('Database not initialized');
    
    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT,
        passwordEnabled INTEGER NOT NULL DEFAULT 1,
        publicKey TEXT,
        guiEnabled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS virtual_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        virtualPath TEXT NOT NULL,
        localPath TEXT NOT NULL,
        canRead INTEGER NOT NULL DEFAULT 1,
        canWrite INTEGER NOT NULL DEFAULT 1,
        canAppend INTEGER NOT NULL DEFAULT 1,
        canDelete INTEGER NOT NULL DEFAULT 0,
        canList INTEGER NOT NULL DEFAULT 1,
        canCreateDir INTEGER NOT NULL DEFAULT 0,
        canRename INTEGER NOT NULL DEFAULT 0,
        applyToSubdirs INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS listeners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        protocol TEXT NOT NULL CHECK(protocol IN ('FTP', 'SFTP')),
        bindingIp TEXT NOT NULL,
        port INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        listenerId INTEGER NOT NULL,
        canRead INTEGER NOT NULL DEFAULT 1,
        canCreate INTEGER NOT NULL DEFAULT 1,
        canEdit INTEGER NOT NULL DEFAULT 1,
        canAppend INTEGER NOT NULL DEFAULT 1,
        canDelete INTEGER NOT NULL DEFAULT 1,
        canList INTEGER NOT NULL DEFAULT 1,
        canCreateDir INTEGER NOT NULL DEFAULT 1,
        canRename INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (listenerId) REFERENCES listeners(id) ON DELETE CASCADE,
        UNIQUE(userId, listenerId)
      );

      CREATE TABLE IF NOT EXISTS user_listeners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        listenerId INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (listenerId) REFERENCES listeners(id) ON DELETE CASCADE,
        UNIQUE(userId, listenerId)
      );

      CREATE TABLE IF NOT EXISTS server_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listenerId INTEGER,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        path TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        success INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (listenerId) REFERENCES listeners(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_listener ON server_activities(listenerId);
      CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON server_activities(timestamp);
    `);

    // Set default settings
    this.db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('logRetentionDays', '30')`);

    this.db.run('PRAGMA foreign_keys = ON');
  }

  // User operations
  createUser(user: User): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const hashedPassword = user.password ? this.hashPassword(user.password) : null;
    this.db.run(`
      INSERT INTO users (username, password, passwordEnabled, publicKey, guiEnabled)
      VALUES (?, ?, ?, ?, ?)
    `, [
      user.username,
      hashedPassword,
      user.passwordEnabled ? 1 : 0,
      user.publicKey || null,
      user.guiEnabled ? 1 : 0
    ]);
    
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  getUser(username: string): User | undefined {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM users WHERE username = ?', [username]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    
    return this.mapUserFromRow(result[0].columns, result[0].values[0]);
  }

  getAllUsers(): User[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM users');
    if (result.length === 0) return [];
    
    return result[0].values.map(row => this.mapUserFromRow(result[0].columns, row));
  }

  updateUser(username: string, user: Partial<User>): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const updates: string[] = [];
    const values: any[] = [];

    if (user.password !== undefined) {
      updates.push('password = ?');
      values.push(user.password ? this.hashPassword(user.password) : null);
    }
    if (user.passwordEnabled !== undefined) {
      updates.push('passwordEnabled = ?');
      values.push(user.passwordEnabled ? 1 : 0);
    }
    if (user.publicKey !== undefined) {
      updates.push('publicKey = ?');
      values.push(user.publicKey || null);
    }
    if (user.guiEnabled !== undefined) {
      updates.push('guiEnabled = ?');
      values.push(user.guiEnabled ? 1 : 0);
    }

    if (updates.length === 0) return;

    values.push(username);
    this.db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, values);
    this.save();
  }

  deleteUser(username: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run('DELETE FROM users WHERE username = ?', [username]);
    this.save();
  }

  verifyPassword(username: string, password: string): boolean {
    const user = this.getUser(username);
    if (!user || !user.password || !user.passwordEnabled) return false;
    return this.hashPassword(password) === user.password;
  }

  // Virtual path operations
  addVirtualPath(vpath: VirtualPath): number {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run(`
      INSERT INTO virtual_paths (userId, virtualPath, localPath, canRead, canWrite, canAppend, canDelete, canList, canCreateDir, canRename, applyToSubdirs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [vpath.userId, vpath.virtualPath, vpath.localPath, 
        vpath.canRead !== false ? 1 : 0,
        vpath.canWrite !== false ? 1 : 0,
        vpath.canAppend !== false ? 1 : 0,
        vpath.canDelete || false ? 1 : 0,
        vpath.canList !== false ? 1 : 0,
        vpath.canCreateDir || false ? 1 : 0,
        vpath.canRename || false ? 1 : 0,
        vpath.applyToSubdirs !== false ? 1 : 0]);
    
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  getVirtualPaths(userId: number): VirtualPath[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM virtual_paths WHERE userId = ?', [userId]);
    if (result.length === 0) return [];
    
    return result[0].values.map(row => ({
      id: row[0] as number,
      userId: row[1] as number,
      virtualPath: row[2] as string,
      localPath: row[3] as string,
      canRead: (row[4] as number) === 1,
      canWrite: (row[5] as number) === 1,
      canAppend: (row[6] as number) === 1,
      canDelete: (row[7] as number) === 1,
      canList: (row[8] as number) === 1,
      canCreateDir: (row[9] as number) === 1,
      canRename: (row[10] as number) === 1,
      applyToSubdirs: (row[11] as number) === 1
    }));
  }

  updateVirtualPath(vpath: VirtualPath): void {
    if (!this.db) throw new Error('Database not initialized');
    if (!vpath.id) throw new Error('Virtual path ID is required');
    
    this.db.run(`
      UPDATE virtual_paths 
      SET virtualPath = ?, localPath = ?, canRead = ?, canWrite = ?, canAppend = ?, 
          canDelete = ?, canList = ?, canCreateDir = ?, canRename = ?, applyToSubdirs = ?
      WHERE id = ?
    `, [vpath.virtualPath, vpath.localPath,
        vpath.canRead !== false ? 1 : 0,
        vpath.canWrite !== false ? 1 : 0,
        vpath.canAppend !== false ? 1 : 0,
        vpath.canDelete || false ? 1 : 0,
        vpath.canList !== false ? 1 : 0,
        vpath.canCreateDir || false ? 1 : 0,
        vpath.canRename || false ? 1 : 0,
        vpath.applyToSubdirs !== false ? 1 : 0,
        vpath.id]);
    this.save();
  }

  deleteVirtualPath(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run('DELETE FROM virtual_paths WHERE id = ?', [id]);
    this.save();
  }

  // Listener operations
  createListener(listener: Listener): number {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run(`
      INSERT INTO listeners (name, protocol, bindingIp, port, enabled)
      VALUES (?, ?, ?, ?, ?)
    `, [
      listener.name,
      listener.protocol,
      listener.bindingIp,
      listener.port,
      listener.enabled ? 1 : 0
    ]);
    
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  getListener(id: number): Listener | undefined {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM listeners WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    
    return this.mapListenerFromRow(result[0].columns, result[0].values[0]);
  }

  getAllListeners(): Listener[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM listeners');
    if (result.length === 0) return [];
    
    return result[0].values.map(row => this.mapListenerFromRow(result[0].columns, row));
  }

  updateListener(id: number, listener: Partial<Listener>): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const updates: string[] = [];
    const values: any[] = [];

    if (listener.name !== undefined) {
      updates.push('name = ?');
      values.push(listener.name);
    }
    if (listener.protocol !== undefined) {
      updates.push('protocol = ?');
      values.push(listener.protocol);
    }
    if (listener.bindingIp !== undefined) {
      updates.push('bindingIp = ?');
      values.push(listener.bindingIp);
    }
    if (listener.port !== undefined) {
      updates.push('port = ?');
      values.push(listener.port);
    }
    if (listener.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(listener.enabled ? 1 : 0);
    }

    if (updates.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE listeners SET ${updates.join(', ')} WHERE id = ?`, values);
    this.save();
  }

  deleteListener(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run('DELETE FROM listeners WHERE id = ?', [id]);
    this.save();
  }

  // Permission operations
  setPermission(permission: Permission): void {
    if (!this.db) throw new Error('Database not initialized');
    
    // Check if exists
    const existing = this.db.exec(
      'SELECT id FROM permissions WHERE userId = ? AND listenerId = ?',
      [permission.userId, permission.listenerId]
    );

    if (existing.length > 0 && existing[0].values.length > 0) {
      // Update
      this.db.run(`
        UPDATE permissions SET
          canRead = ?, canCreate = ?, canEdit = ?, canAppend = ?, canDelete = ?,
          canList = ?, canCreateDir = ?, canRename = ?
        WHERE userId = ? AND listenerId = ?
      `, [
        permission.canRead ? 1 : 0,
        permission.canCreate ? 1 : 0,
        permission.canEdit ? 1 : 0,
        permission.canAppend ? 1 : 0,
        permission.canDelete ? 1 : 0,
        permission.canList ? 1 : 0,
        permission.canCreateDir ? 1 : 0,
        permission.canRename ? 1 : 0,
        permission.userId,
        permission.listenerId
      ]);
    } else {
      // Insert
      this.db.run(`
        INSERT INTO permissions (userId, listenerId, canRead, canCreate, canEdit, canAppend, canDelete, canList, canCreateDir, canRename)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        permission.userId,
        permission.listenerId,
        permission.canRead ? 1 : 0,
        permission.canCreate ? 1 : 0,
        permission.canEdit ? 1 : 0,
        permission.canAppend ? 1 : 0,
        permission.canDelete ? 1 : 0,
        permission.canList ? 1 : 0,
        permission.canCreateDir ? 1 : 0,
        permission.canRename ? 1 : 0
      ]);
    }
    
    this.save();
  }

  getPermission(userId: number, listenerId: number): Permission | undefined {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec(
      'SELECT * FROM permissions WHERE userId = ? AND listenerId = ?',
      [userId, listenerId]
    );
    
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    
    return this.mapPermissionFromRow(result[0].columns, result[0].values[0]);
  }

  getUserPermissions(userId: number): Permission[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT * FROM permissions WHERE userId = ?', [userId]);
    if (result.length === 0) return [];
    
    return result[0].values.map(row => this.mapPermissionFromRow(result[0].columns, row));
  }

  // User-Listener association
  subscribeUserToListener(userId: number, listenerId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    // Check if exists
    const existing = this.db.exec(
      'SELECT id FROM user_listeners WHERE userId = ? AND listenerId = ?',
      [userId, listenerId]
    );

    if (existing.length === 0 || existing[0].values.length === 0) {
      this.db.run(`
        INSERT INTO user_listeners (userId, listenerId)
        VALUES (?, ?)
      `, [userId, listenerId]);
      this.save();
    }
  }

  unsubscribeUserFromListener(userId: number, listenerId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run('DELETE FROM user_listeners WHERE userId = ? AND listenerId = ?', [userId, listenerId]);
    this.save();
  }

  getUserListeners(userId: number): number[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT listenerId FROM user_listeners WHERE userId = ?', [userId]);
    if (result.length === 0) return [];
    
    return result[0].values.map(row => row[0] as number);
  }

  getListenerUsers(listenerId: number): number[] {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT userId FROM user_listeners WHERE listenerId = ?', [listenerId]);
    if (result.length === 0) return [];
    
    return result[0].values.map(row => row[0] as number);
  }

  // Activity logging
  logActivity(activity: ServerActivity): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run(`
      INSERT INTO server_activities (listenerId, username, action, path, success)
      VALUES (?, ?, ?, ?, ?)
    `, [
      activity.listenerId,
      activity.username,
      activity.action,
      activity.path,
      activity.success ? 1 : 0
    ]);
    
    this.save();
  }

  getRecentActivities(listenerId?: number, limit: number = 100): ServerActivity[] {
    if (!this.db) throw new Error('Database not initialized');
    
    let result;
    
    if (listenerId !== undefined) {
      result = this.db.exec(`
        SELECT * FROM server_activities 
        WHERE listenerId = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, [listenerId, limit]);
    } else {
      result = this.db.exec(`
        SELECT * FROM server_activities 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, [limit]);
    }

    if (result.length === 0) return [];

    return result[0].values.map(row => ({
      id: row[0] as number,
      listenerId: row[1] as number,
      username: row[2] as string,
      action: row[3] as string,
      path: row[4] as string,
      timestamp: row[5] as string,
      success: (row[6] as number) === 1
    }));
  }

  clearActivitiesByDate(beforeDate: string): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT COUNT(*) FROM server_activities WHERE timestamp < ?', [beforeDate]);
    const count = result[0].values[0][0] as number;
    
    this.db.run('DELETE FROM server_activities WHERE timestamp < ?', [beforeDate]);
    this.save();
    
    return count;
  }

  clearAllActivities(): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT COUNT(*) FROM server_activities');
    const count = result[0].values[0][0] as number;
    
    this.db.run('DELETE FROM server_activities');
    this.save();
    
    return count;
  }

  cleanupOldActivities(): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const retentionDays = parseInt(this.getSetting('logRetentionDays') || '30');
    const beforeDate = new Date();
    beforeDate.setDate(beforeDate.getDate() - retentionDays);
    
    return this.clearActivitiesByDate(beforeDate.toISOString());
  }

  getActivityCount(): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT COUNT(*) FROM server_activities');
    return result[0].values[0][0] as number;
  }

  // Settings operations
  getSetting(key: string): string | undefined {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    
    return result[0].values[0][0] as string;
  }

  setSetting(key: string, value: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    this.save();
  }

  getAllSettings(): Record<string, string> {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT key, value FROM settings');
    if (result.length === 0) return {};
    
    const settings: Record<string, string> = {};
    for (const row of result[0].values) {
      settings[row[0] as string] = row[1] as string;
    }
    return settings;
  }
  getOldLogsStats(retentionDays: number): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const beforeDate = new Date();
    beforeDate.setDate(beforeDate.getDate() - retentionDays);
    
    const result = this.db.exec(
      'SELECT COUNT(*) FROM server_activities WHERE timestamp < ?',
      [beforeDate.toISOString()]
    );
    
    return result[0]?.values[0]?.[0] as number || 0;
  }
  // Helper methods
  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  private mapUserFromRow(columns: string[], row: any[]): User {
    const obj: any = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    
    return {
      id: obj.id,
      username: obj.username,
      password: obj.password,
      passwordEnabled: obj.passwordEnabled === 1,
      publicKey: obj.publicKey,
      guiEnabled: obj.guiEnabled === 1,
      createdAt: obj.createdAt
    };
  }

  private mapListenerFromRow(columns: string[], row: any[]): Listener {
    const obj: any = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    
    return {
      id: obj.id,
      name: obj.name,
      protocol: obj.protocol,
      bindingIp: obj.bindingIp,
      port: obj.port,
      enabled: obj.enabled === 1,
      createdAt: obj.createdAt
    };
  }

  private mapPermissionFromRow(columns: string[], row: any[]): Permission {
    const obj: any = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    
    return {
      id: obj.id,
      userId: obj.userId,
      listenerId: obj.listenerId,
      canRead: obj.canRead === 1,
      canCreate: obj.canCreate === 1,
      canEdit: obj.canEdit === 1,
      canAppend: obj.canAppend === 1,
      canDelete: obj.canDelete === 1,
      canList: obj.canList === 1,
      canCreateDir: obj.canCreateDir === 1,
      canRename: obj.canRename === 1
    };
  }

  close(): void {
    if (this.db && this.initialized) {
      try {
        this.save();
        this.db.close();
        this.db = null;
        this.initialized = false;
        console.log('Database closed successfully');
      } catch (err) {
        console.error('Error closing database:', err);
        // Even if there's an error, mark as not initialized to prevent further operations
        this.db = null;
        this.initialized = false;
      }
    }
  }
}
