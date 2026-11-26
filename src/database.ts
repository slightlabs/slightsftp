import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SqliteDatabase } from './sqlite';
import logger from './logger';
import { assertCloudTarget } from './cloud-storage';
import { User, VirtualPath, Permission, Listener, UserListener, ServerActivity, FtpTlsMode, Share, Webhook, StorageConnection } from './types';
import { hashPassword, timingDummyHash, verifyPasswordHash, verifyPasswordHashAsync } from './password';
import { SecretBox, isSealed } from './secret-box';
import { SECRET_SETTINGS } from './settings-policy';

/** A web GUI or portal sign-in session (see sessions.ts); only the token's hash is stored. */
export interface StoredSession {
  kind: 'admin' | 'portal';
  tokenHash: string;
  username: string;
  createdAt: number;
  mustChangePassword: boolean;
}

/**
 * The schema version this build writes to PRAGMA user_version: the number of
 * entries in DatabaseManager.migrations. Add a migration (never edit a
 * released one) for every schema change.
 */
export const SCHEMA_VERSION = 2;

/** How many automatic pre-upgrade copies of config.db to keep. */
const UPGRADE_BACKUPS_KEPT = 3;

/** config.db was written by a newer version of the app. */
export class DatabaseTooNewError extends Error {
  constructor(readonly found: number) {
    super(`The configuration database was written by a newer version of SLightSFTP (schema ${found}; this version understands up to ${SCHEMA_VERSION}). Install the newer version again, or restore a backup made with this one.`);
    this.name = 'DatabaseTooNewError';
  }
}

function normalizeTlsMode(mode: unknown): FtpTlsMode {
  return mode === 'optional' || mode === 'required' ? mode : 'none';
}

export class DatabaseManager {
  private db: SqliteDatabase | null = null;
  private dbPath: string;
  private initialized: boolean = false;
  private activityListeners: Array<(activity: ServerActivity) => void> = [];
  /** encrypts the secrets stored in the database (see secret-box.ts) */
  private secrets: SecretBox | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'config.db');
  }

  /** The database file (':memory:' for an in-memory database). */
  get filePath(): string {
    return this.dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.secrets = SecretBox.forDatabase(this.dbPath);
    this.db = this.open();
    try {
      this.backUpBeforeUpgrade();
      this.initialize();
    } catch (err) {
      this.db.close();
      this.db = null;
      throw err;
    }
    this.initialized = true;
  }

  private schemaVersion(db: SqliteDatabase = this.db!): number {
    return Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
  }

  /**
   * Before a newer version changes the schema of an existing database, keep
   * a copy next to it (config.db.v<old>-<time>.bak, the newest few), so an
   * upgrade can always be undone by reinstalling the old version.
   */
  private backUpBeforeUpgrade(): void {
    if (!this.db || this.dbPath === ':memory:') return;
    const version = this.schemaVersion();
    const hasTables = this.db.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").length > 0;
    if (!hasTables || version >= SCHEMA_VERSION) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const target = `${this.dbPath}.v${version}-${stamp}.bak`;
    fs.writeFileSync(target, this.db.serialize(), { mode: 0o600 });
    logger.warn(`Upgrading the configuration database (schema ${version} -> ${SCHEMA_VERSION}); previous version saved as ${target}`);

    const dir = path.dirname(path.resolve(this.dbPath));
    const prefix = `${path.basename(this.dbPath)}.v`;
    const copies = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of copies.slice(UPGRADE_BACKUPS_KEPT)) fs.rmSync(path.join(dir, f), { force: true });
  }

  /**
   * Open the database file (created owner-only: it holds password hashes and
   * secrets). Files written by older versions with sql.js are plain SQLite
   * databases and open as they are.
   */
  private open(): SqliteDatabase {
    if (this.dbPath === ':memory:') return new SqliteDatabase(':memory:');
    fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
    fs.closeSync(fs.openSync(this.dbPath, 'a', 0o600));
    if (process.platform !== 'win32') {
      // databases created by older versions were world-readable; SQLite gives
      // its -wal / -shm files the database file's permissions
      for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch { /* not our file to change */ }
      }
    }
    return new SqliteDatabase(this.dbPath);
  }

  /**
   * Changes are written to disk as each statement runs; there is nothing to
   * save. Kept so callers written for the in-memory sql.js engine still work.
   */
  private save(): void { /* written already */ }

  private scheduleSave(_delayMs?: number): void { /* written already */ }

  /** Make sure everything is on disk (call before exiting). */
  flush(): void {
    this.db?.run('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /** The master key holder, e.g. for configuration backups. */
  get secretBox(): SecretBox {
    if (!this.secrets) throw new Error('Database not initialized');
    return this.secrets;
  }

  /** Use a different master key (a restored backup's); the caller re-opens the data. */
  useSecretBox(box: SecretBox): void {
    this.secrets = box;
  }

  private seal(value: string | null | undefined): string | null | undefined {
    return this.secrets ? this.secrets.seal(value) : value;
  }

  /**
   * Decrypt a stored secret. With a missing or different master key the
   * sealed value is returned unchanged, so it fails like a wrong secret
   * would (TOTP codes and webhook signatures don't verify) instead of
   * breaking every query that reads the row.
   */
  private unseal(value: string | null | undefined, what: string): string | null | undefined {
    if (!this.secrets || !isSealed(value)) return value;
    try {
      return this.secrets.open(value);
    } catch (err: any) {
      logger.error(`Cannot read ${what}: ${err?.message || err}`);
      return value;
    }
  }

  /** Encrypt secrets written in plaintext by older versions (or restored from their backups). */
  private sealStoredSecrets(): void {
    if (!this.db || !this.secrets) return;
    const reseal = (table: string, key: string, column: string) => {
      const rows = this.db!.exec(`SELECT ${key}, ${column} FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE 'enc:v1:%'`);
      for (const [id, value] of rows.length ? rows[0].values : []) {
        this.db!.run(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`, [this.secrets!.seal(String(value)), id]);
      }
    };
    reseal('users', 'id', 'totpSecret');
    reseal('users', 'id', 'totpPendingSecret');
    reseal('webhooks', 'id', 'secret');
    reseal('storage_connections', 'id', 'config');
    for (const key of SECRET_SETTINGS) {
      const rows = this.db.exec(`SELECT value FROM settings WHERE key = ? AND value != '' AND value NOT LIKE 'enc:v1:%'`, [key]);
      if (rows.length && rows[0].values.length) {
        this.db.run('UPDATE settings SET value = ? WHERE key = ?', [this.secrets.seal(String(rows[0].values[0][0])), key]);
      }
    }
  }

  private initialize(): void {
    if (!this.db) throw new Error('Database not initialized');
    const version = this.schemaVersion();
    if (version > SCHEMA_VERSION) throw new DatabaseTooNewError(version);
    
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
        success INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        owner TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('download', 'upload')),
        virtualPath TEXT NOT NULL,
        passwordHash TEXT,
        expiresAt TEXT,
        maxDownloads INTEGER,
        downloadCount INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'json',
        usernameFilter TEXT,
        pathPrefix TEXT,
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        lastStatus TEXT,
        lastDeliveredAt TEXT,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ip_bans (
        ip TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        bannedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trash_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        virtualPath TEXT NOT NULL,
        originalPath TEXT NOT NULL,
        trashPath TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        deletedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        tokenHash TEXT UNIQUE NOT NULL,
        hint TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastUsedAt TEXT,
        expiresAt TEXT
      );

      CREATE TABLE IF NOT EXISTS storage_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        tokenHash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        username TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        mustChangePassword INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(username);

      CREATE INDEX IF NOT EXISTS idx_activities_listener ON server_activities(listenerId);
      CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON server_activities(timestamp);
    `);

    this.migrate(version);
    this.sealStoredSecrets();

    // Set default settings
    this.db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('logRetentionDays', '30')`);

    this.db.run('PRAGMA foreign_keys = ON');
  }

  /**
   * Schema changes, in order; entry i takes the database from version i to
   * i + 1. Each runs in its own transaction together with the version bump.
   * Released entries are never edited: add a new one.
   */
  private readonly migrations: Array<{ name: string; up: () => void }> = [
    { name: 'columns added up to v1.7', up: () => this.addLegacyColumns() },
    { name: 'audit log keeps entries of deleted listeners; remove orphan rows', up: () => { this.keepActivityHistory(); this.removeOrphanRows(); } },
  ];

  /** Bring the database from `from` up to SCHEMA_VERSION. */
  private migrate(from: number): void {
    if (!this.db) return;
    if (this.migrations.length !== SCHEMA_VERSION) throw new Error('SCHEMA_VERSION does not match the migrations');
    for (let v = from; v < SCHEMA_VERSION; v++) {
      this.db.transaction(() => {
        this.migrations[v].up();
        this.db!.run(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Columns introduced before schema versions were tracked (idempotent: v1.7 databases have some of them). */
  private addLegacyColumns(): void {
    const addColumn = (table: string, column: string, definition: string) => {
      const info = this.db!.exec(`PRAGMA table_info(${table})`);
      const columns = info.length ? info[0].values.map(row => row[1]) : [];
      if (!columns.includes(column)) {
        this.db!.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    addColumn('users', 'mustChangePassword', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('listeners', 'tlsMode', "TEXT NOT NULL DEFAULT 'none'");
    addColumn('users', 'portalEnabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('server_activities', 'bytes', 'INTEGER');
    addColumn('users', 'allowedIps', 'TEXT');
    addColumn('users', 'totpEnabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('users', 'totpSecret', 'TEXT');
    addColumn('users', 'totpPendingSecret', 'TEXT');
    addColumn('server_activities', 'checksum', 'TEXT');
    addColumn('users', 'quotaBytes', 'INTEGER');
    addColumn('users', 'uploadLimitKBps', 'INTEGER');
    addColumn('users', 'downloadLimitKBps', 'INTEGER');
    addColumn('users', 'authSource', "TEXT NOT NULL DEFAULT 'local'");
    // existing GUI users keep full access
    addColumn('users', 'guiRole', "TEXT NOT NULL DEFAULT 'admin'");
  }

  /**
   * The activity log is an audit trail: entries outlive the listener they
   * mention. Older databases declared server_activities.listenerId as a
   * foreign key with ON DELETE CASCADE (never enforced by the sql.js engine,
   * whose export() reset PRAGMA foreign_keys); rebuild the table without it,
   * the standard SQLite procedure for changing a constraint.
   */
  private keepActivityHistory(): void {
    const fks = this.db!.exec('PRAGMA foreign_key_list(server_activities)');
    if (!fks.length) return;
    const info = this.db!.exec('PRAGMA table_info(server_activities)');
    const columns = info[0].values.map(r => `"${String(r[1])}"`).join(', ');
    this.db!.run(`
      CREATE TABLE server_activities_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listenerId INTEGER,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        path TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        success INTEGER NOT NULL DEFAULT 1,
        bytes INTEGER,
        checksum TEXT
      )`);
    this.db!.run(`INSERT INTO server_activities_new (${columns}) SELECT ${columns} FROM server_activities`);
    this.db!.run('DROP TABLE server_activities');
    this.db!.run('ALTER TABLE server_activities_new RENAME TO server_activities');
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_activities_listener ON server_activities(listenerId)');
    this.db!.run('CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON server_activities(timestamp)');
  }

  /** Rows whose user or listener is gone (left behind while foreign keys were not enforced). */
  private removeOrphanRows(): void {
    this.db!.run('DELETE FROM virtual_paths WHERE userId NOT IN (SELECT id FROM users)');
    for (const table of ['permissions', 'user_listeners']) {
      this.db!.run(`DELETE FROM ${table} WHERE userId NOT IN (SELECT id FROM users) OR listenerId NOT IN (SELECT id FROM listeners)`);
    }
  }

  // User operations
  createUser(user: User): number {
    if (!this.db) throw new Error('Database not initialized');
    
    const hashedPassword = user.password ? this.hashPassword(user.password) : null;
    this.db.run(`
      INSERT INTO users (username, password, passwordEnabled, publicKey, guiEnabled, mustChangePassword, portalEnabled, allowedIps, quotaBytes, uploadLimitKBps, downloadLimitKBps, authSource, guiRole)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user.username,
      hashedPassword,
      user.passwordEnabled ? 1 : 0,
      user.publicKey || null,
      user.guiEnabled ? 1 : 0,
      user.mustChangePassword ? 1 : 0,
      user.portalEnabled ? 1 : 0,
      user.allowedIps || null,
      user.quotaBytes || null,
      user.uploadLimitKBps || null,
      user.downloadLimitKBps || null,
      user.authSource === 'ldap' ? 'ldap' : 'local',
      user.guiRole === 'viewer' ? 'viewer' : 'admin'
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
    if (user.mustChangePassword !== undefined) {
      updates.push('mustChangePassword = ?');
      values.push(user.mustChangePassword ? 1 : 0);
    }
    if (user.portalEnabled !== undefined) {
      updates.push('portalEnabled = ?');
      values.push(user.portalEnabled ? 1 : 0);
    }
    if (user.allowedIps !== undefined) {
      updates.push('allowedIps = ?');
      values.push(user.allowedIps || null);
    }
    if (user.quotaBytes !== undefined) {
      updates.push('quotaBytes = ?');
      values.push(user.quotaBytes || null);
    }
    if (user.uploadLimitKBps !== undefined) {
      updates.push('uploadLimitKBps = ?');
      values.push(user.uploadLimitKBps || null);
    }
    if (user.downloadLimitKBps !== undefined) {
      updates.push('downloadLimitKBps = ?');
      values.push(user.downloadLimitKBps || null);
    }
    if (user.guiRole !== undefined) {
      updates.push('guiRole = ?');
      values.push(user.guiRole === 'viewer' ? 'viewer' : 'admin');
    }
    if (user.authSource !== undefined) {
      updates.push('authSource = ?');
      values.push(user.authSource === 'ldap' ? 'ldap' : 'local');
    }
    if (user.totpPendingSecret !== undefined) {
      updates.push('totpPendingSecret = ?');
      values.push(this.seal(user.totpPendingSecret) || null);
    }
    if (user.totpSecret !== undefined) {
      updates.push('totpSecret = ?');
      values.push(this.seal(user.totpSecret) || null);
    }
    if (user.totpEnabled !== undefined) {
      updates.push('totpEnabled = ?');
      values.push(user.totpEnabled ? 1 : 0);
      if (!user.totpEnabled) {
        // turning 2FA off always forgets the secret
        updates.push('totpSecret = NULL', 'totpPendingSecret = NULL');
      }
    }

    if (updates.length === 0) return;

    values.push(username);
    this.db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, values);
    this.save();
  }

  /**
   * Delete a user and everything that grants access as them. Done explicitly:
   * sql.js turns foreign keys off when it exports the database, so ON DELETE
   * CASCADE does not run on saved databases, and API tokens / share links are
   * keyed by user name: a later account with the same name must not inherit them.
   */
  deleteUser(username: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const user = this.getUser(username);
    const db = this.db;
    // all or nothing: never a user without their tokens revoked
    db.transaction(() => {
      if (user?.id !== undefined) {
        for (const table of ['virtual_paths', 'permissions', 'user_listeners']) {
          db.run(`DELETE FROM ${table} WHERE userId = ?`, [user.id]);
        }
      }
      db.run('DELETE FROM api_tokens WHERE username = ?', [username]);
      db.run('DELETE FROM shares WHERE owner = ?', [username]);
      db.run('DELETE FROM web_sessions WHERE username = ?', [username]);
      db.run('DELETE FROM users WHERE username = ?', [username]);
    });
  }

  /**
   * Protocol (SFTP/FTP) password authentication: requires password auth to be
   * enabled for the user.
   */
  verifyPassword(username: string, password: string): boolean {
    const user = this.getUser(username);
    if (!user || !user.passwordEnabled) return false;
    return this.checkPassword(username, password);
  }

  /**
   * Check a user's password (used by GUI logins too). Legacy unsalted hashes are
   * transparently upgraded to scrypt on success.
   */
  checkPassword(username: string, password: string): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const user = this.getUser(username);
    if (!user || !user.password) return false;

    const { valid, needsRehash } = verifyPasswordHash(user.password, password);
    if (valid && needsRehash) {
      this.db.run('UPDATE users SET password = ? WHERE username = ?', [hashPassword(password), username]);
      this.save();
    }
    return valid;
  }

  /** checkPassword without blocking the event loop (all login paths use this). */
  async checkPasswordAsync(username: string, password: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');
    const user = this.getUser(username);
    if (!user || !user.password) {
      await verifyPasswordHashAsync(timingDummyHash(), password || 'x');
      return false;
    }
    const { valid, needsRehash } = await verifyPasswordHashAsync(user.password, password);
    if (valid && needsRehash && this.db) {
      this.db.run('UPDATE users SET password = ? WHERE username = ?', [hashPassword(password), username]);
      this.save();
    }
    return valid;
  }

  // Virtual path operations
  addVirtualPath(vpath: VirtualPath): number {
    if (!this.db) throw new Error('Database not initialized');
    assertCloudTarget(this, vpath.localPath);
    
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
    assertCloudTarget(this, vpath.localPath);
    
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
      INSERT INTO listeners (name, protocol, bindingIp, port, enabled, tlsMode)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      listener.name,
      listener.protocol,
      listener.bindingIp,
      listener.port,
      listener.enabled ? 1 : 0,
      normalizeTlsMode(listener.tlsMode)
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
    if (listener.tlsMode !== undefined) {
      updates.push('tlsMode = ?');
      values.push(normalizeTlsMode(listener.tlsMode));
    }

    if (updates.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE listeners SET ${updates.join(', ')} WHERE id = ?`, values);
    this.save();
  }

  deleteListener(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    
    // explicit for the same reason as deleteUser; the activity log keeps its history
    const db = this.db;
    db.transaction(() => {
      db.run('DELETE FROM permissions WHERE listenerId = ?', [id]);
      db.run('DELETE FROM user_listeners WHERE listenerId = ?', [id]);
      db.run('DELETE FROM listeners WHERE id = ?', [id]);
    });
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

  /**
   * Replace a user's listener subscriptions, listener permissions and virtual
   * paths in one go (the "Edit User" dialog in the GUI).
   */
  replaceUserAccess(
    userId: number,
    listenerIds: number[],
    virtualPaths: Array<Partial<VirtualPath>>,
    permissions: Array<Partial<Permission>> = []
  ): void {
    const currentListeners = this.getUserListeners(userId);
    for (const listenerId of currentListeners) {
      if (!listenerIds.includes(listenerId)) {
        this.unsubscribeUserFromListener(userId, listenerId);
      }
    }
    for (const listenerId of listenerIds) {
      if (!currentListeners.includes(listenerId)) {
        this.subscribeUserToListener(userId, listenerId);
      }
    }

    for (const perm of permissions) {
      this.setPermission({ ...perm, userId } as Permission);
    }

    for (const vp of this.getVirtualPaths(userId)) {
      this.deleteVirtualPath(vp.id!);
    }
    for (const vp of virtualPaths) {
      this.addVirtualPath({
        userId,
        virtualPath: vp.virtualPath!,
        localPath: vp.localPath!,
        canRead: vp.canRead,
        canWrite: vp.canWrite,
        canAppend: vp.canAppend,
        canDelete: vp.canDelete,
        canList: vp.canList,
        canCreateDir: vp.canCreateDir,
        canRename: vp.canRename,
        applyToSubdirs: vp.applyToSubdirs
      } as VirtualPath);
    }
  }

  // API tokens (only hashes are stored)
  addApiToken(t: { username: string; name: string; tokenHash: string; hint: string; expiresAt: string | null }): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('INSERT INTO api_tokens (username, name, tokenHash, hint, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
      [t.username, t.name, t.tokenHash, t.hint, new Date().toISOString(), t.expiresAt]);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  listApiTokens(username?: string): Array<{ id: number; username: string; name: string; hint: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null }> {
    if (!this.db) throw new Error('Database not initialized');
    const cols = 'id, username, name, hint, createdAt, lastUsedAt, expiresAt';
    const result = username
      ? this.db.exec(`SELECT ${cols} FROM api_tokens WHERE username = ? ORDER BY id DESC`, [username])
      : this.db.exec(`SELECT ${cols} FROM api_tokens ORDER BY id DESC`);
    if (result.length === 0) return [];
    return result[0].values.map(row => {
      const o: any = {};
      result[0].columns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  }

  findApiToken(tokenHash: string): { id: number; username: string; expiresAt: string | null } | undefined {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT id, username, expiresAt FROM api_tokens WHERE tokenHash = ?', [tokenHash]);
    if (result.length === 0 || result[0].values.length === 0) return undefined;
    const [id, username, expiresAt] = result[0].values[0];
    return { id: id as number, username: username as string, expiresAt: expiresAt as string | null };
  }

  touchApiToken(id: number): void {
    if (!this.db) return;
    this.db.run('UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?', [new Date().toISOString(), id]);
    this.save();
  }

  deleteApiToken(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM api_tokens WHERE id = ?', [id]);
    this.save();
  }

  // Recycle bin
  addTrashItem(item: { username: string; virtualPath: string; originalPath: string; trashPath: string; size: number }): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('INSERT INTO trash_items (username, virtualPath, originalPath, trashPath, size, deletedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [item.username, item.virtualPath, item.originalPath, item.trashPath, item.size, new Date().toISOString()]);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  listTrashItems(username?: string): Array<{ id: number; username: string; virtualPath: string; originalPath: string; trashPath: string; size: number; deletedAt: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = username
      ? this.db.exec('SELECT * FROM trash_items WHERE username = ? ORDER BY id DESC', [username])
      : this.db.exec('SELECT * FROM trash_items ORDER BY id DESC');
    if (result.length === 0) return [];
    return result[0].values.map(row => {
      const o: any = {};
      result[0].columns.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  }

  getTrashItem(id: number) {
    return this.listTrashItems().find(i => i.id === id);
  }

  deleteTrashItem(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM trash_items WHERE id = ?', [id]);
    this.save();
  }

  // IP bans (brute-force protection)
  addIpBan(ban: { ip: string; reason: string; bannedAt: string; expiresAt: string }): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('INSERT OR REPLACE INTO ip_bans (ip, reason, bannedAt, expiresAt) VALUES (?, ?, ?, ?)', [ban.ip, ban.reason, ban.bannedAt, ban.expiresAt]);
    this.save();
  }

  getIpBan(ip: string): { ip: string; reason: string; bannedAt: string; expiresAt: string } | undefined {
    return this.listIpBans(ip)[0];
  }

  listIpBans(ip?: string): Array<{ ip: string; reason: string; bannedAt: string; expiresAt: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = ip
      ? this.db.exec('SELECT ip, reason, bannedAt, expiresAt FROM ip_bans WHERE ip = ?', [ip])
      : this.db.exec('SELECT ip, reason, bannedAt, expiresAt FROM ip_bans ORDER BY bannedAt DESC');
    if (result.length === 0) return [];
    return result[0].values.map(([ip, reason, bannedAt, expiresAt]) => ({ ip: ip as string, reason: reason as string, bannedAt: bannedAt as string, expiresAt: expiresAt as string }));
  }

  deleteIpBan(ip: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM ip_bans WHERE ip = ?', [ip]);
    this.save();
  }

  // Webhooks
  createWebhook(hook: Webhook): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(`
      INSERT INTO webhooks (name, url, events, format, usernameFilter, pathPrefix, secret, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [hook.name, hook.url, hook.events.join(','), hook.format || 'json', hook.usernameFilter ?? null, hook.pathPrefix ?? null, this.seal(hook.secret) ?? null, hook.enabled === false ? 0 : 1]);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  updateWebhook(id: number, hook: Partial<Webhook>): void {
    if (!this.db) throw new Error('Database not initialized');
    const fields: Record<string, any> = {
      name: hook.name, url: hook.url, events: hook.events?.join(','), format: hook.format,
      usernameFilter: hook.usernameFilter, pathPrefix: hook.pathPrefix, secret: hook.secret === undefined ? undefined : (this.seal(hook.secret) ?? null),
      enabled: hook.enabled === undefined ? undefined : (hook.enabled ? 1 : 0),
    };
    const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
    if (!keys.length) return;
    this.db.run(`UPDATE webhooks SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => fields[k]), id]);
    this.save();
  }

  deleteWebhook(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM webhooks WHERE id = ?', [id]);
    this.save();
  }

  getWebhook(id: number): Webhook | undefined {
    return this.queryWebhooks('SELECT * FROM webhooks WHERE id = ?', [id])[0];
  }

  listWebhooks(): Webhook[] {
    return this.queryWebhooks('SELECT * FROM webhooks ORDER BY id', []);
  }

  recordWebhookDelivery(id: number, status: string): void {
    if (!this.db) return;
    this.db.run('UPDATE webhooks SET lastStatus = ?, lastDeliveredAt = ? WHERE id = ?', [status, new Date().toISOString(), id]);
    this.save();
  }

  private queryWebhooks(sql: string, params: any[]): Webhook[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map(row => {
      const obj: any = {};
      result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
      const secret = this.unseal(obj.secret, `the signing secret of webhook ${obj.id}`);
      return { ...obj, secret, events: String(obj.events || '').split(',').filter(Boolean), enabled: obj.enabled === 1 } as Webhook;
    });
  }

  /** Every cloud:// local path used by a virtual path. */
  getCloudVirtualPathTargets(): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec("SELECT DISTINCT localPath FROM virtual_paths WHERE localPath LIKE 'cloud://%'");
    return result.length ? result[0].values.map(r => String(r[0])) : [];
  }

  // Cloud storage connections (config is JSON: bucket, credentials, ...)
  createStorageConnection(conn: StorageConnection): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('INSERT INTO storage_connections (name, type, config) VALUES (?, ?, ?)', [conn.name, conn.type, this.seal(JSON.stringify(conn.config || {})) as string]);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  updateStorageConnection(id: number, conn: Partial<StorageConnection>): void {
    if (!this.db) throw new Error('Database not initialized');
    const fields: Record<string, any> = { name: conn.name, type: conn.type, config: conn.config === undefined ? undefined : this.seal(JSON.stringify(conn.config)) };
    const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
    if (!keys.length) return;
    this.db.run(`UPDATE storage_connections SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => fields[k]), id]);
    this.save();
  }

  deleteStorageConnection(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM storage_connections WHERE id = ?', [id]);
    this.save();
  }

  getStorageConnection(id: number): StorageConnection | undefined {
    return this.queryStorageConnections('SELECT * FROM storage_connections WHERE id = ?', [id])[0];
  }

  listStorageConnections(): StorageConnection[] {
    return this.queryStorageConnections('SELECT * FROM storage_connections ORDER BY id', []);
  }

  private queryStorageConnections(sql: string, params: any[]): StorageConnection[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map(row => {
      const obj: any = {};
      result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
      let config = {};
      const raw = this.unseal(obj.config, `the credentials of storage connection ${obj.id}`);
      try { config = isSealed(raw) ? {} : JSON.parse(raw || '{}'); } catch { /* corrupt row: treat as empty */ }
      return { ...obj, config } as StorageConnection;
    });
  }

  // Share links
  createShare(share: Share): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(`
      INSERT INTO shares (token, owner, type, virtualPath, passwordHash, expiresAt, maxDownloads)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [share.token, share.owner, share.type, share.virtualPath, share.passwordHash ?? null, share.expiresAt ?? null, share.maxDownloads ?? null]);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    this.save();
    return result[0].values[0][0] as number;
  }

  getShare(id: number): Share | undefined {
    return this.queryShares('SELECT * FROM shares WHERE id = ?', [id])[0];
  }

  getShareByToken(token: string): Share | undefined {
    return this.queryShares('SELECT * FROM shares WHERE token = ?', [token])[0];
  }

  /** All shares, or those created by `owner`, newest first. */
  listShares(owner?: string): Share[] {
    return owner
      ? this.queryShares('SELECT * FROM shares WHERE owner = ? ORDER BY id DESC', [owner])
      : this.queryShares('SELECT * FROM shares ORDER BY id DESC', []);
  }

  revokeShare(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('UPDATE shares SET revoked = 1 WHERE id = ?', [id]);
    this.save();
  }

  recordShareDownload(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('UPDATE shares SET downloadCount = downloadCount + 1 WHERE id = ?', [id]);
    this.save();
  }

  private queryShares(sql: string, params: any[]): Share[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map(row => {
      const obj: any = {};
      result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
      return { ...obj, revoked: obj.revoked === 1 } as Share;
    });
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
      INSERT INTO server_activities (listenerId, username, action, path, success, bytes, checksum)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      activity.listenerId,
      activity.username,
      activity.action,
      activity.path,
      activity.success ? 1 : 0,
      activity.bytes ?? null,
      activity.checksum ?? null
    ]);
    
    this.scheduleSave();

    for (const listener of this.activityListeners) {
      try {
        listener({ ...activity, timestamp: activity.timestamp || new Date().toISOString() });
      } catch (err) {
        logger.error('Activity listener failed:', err);
      }
    }
  }

  /** Be notified of every activity entry after it is stored (used by webhooks). */
  onActivity(listener: (activity: ServerActivity) => void): () => void {
    this.activityListeners.push(listener);
    return () => { this.activityListeners = this.activityListeners.filter(l => l !== listener); };
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
      success: (row[6] as number) === 1,
      bytes: (row[7] as number | null) ?? null,
      checksum: (row[8] as string | null) ?? null
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
    
    const value = result[0].values[0][0] as string;
    if (!SECRET_SETTINGS.has(key)) return value;
    const plain = this.unseal(value, `the ${key} setting`);
    return isSealed(plain) ? undefined : plain ?? undefined;
  }

  setSetting(key: string, value: string): void {
    if (!this.db) throw new Error('Database not initialized');
    
    const stored = SECRET_SETTINGS.has(key) ? this.seal(value) ?? '' : value;
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, stored]);
    this.save();
  }

  getAllSettings(): Record<string, string> {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.exec('SELECT key, value FROM settings');
    if (result.length === 0) return {};
    
    const settings: Record<string, string> = {};
    for (const row of result[0].values) {
      const key = row[0] as string;
      if (SECRET_SETTINGS.has(key)) {
        const value = this.getSetting(key);
        if (value !== undefined) settings[key] = value;
      } else {
        settings[key] = row[1] as string;
      }
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
    return hashPassword(password);
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
      mustChangePassword: obj.mustChangePassword === 1,
      portalEnabled: obj.portalEnabled === 1,
      allowedIps: obj.allowedIps || null,
      totpEnabled: obj.totpEnabled === 1,
      totpSecret: this.unseal(obj.totpSecret, 'a two-factor secret') || null,
      totpPendingSecret: this.unseal(obj.totpPendingSecret, 'a two-factor secret') || null,
      quotaBytes: obj.quotaBytes || null,
      uploadLimitKBps: obj.uploadLimitKBps || null,
      downloadLimitKBps: obj.downloadLimitKBps || null,
      authSource: obj.authSource === 'ldap' ? 'ldap' : 'local',
      guiRole: obj.guiRole === 'viewer' ? 'viewer' : 'admin',
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
      tlsMode: normalizeTlsMode(obj.tlsMode),
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

  // Sign-in sessions (web GUI and portal)
  createSession(session: StoredSession): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('INSERT OR REPLACE INTO web_sessions (tokenHash, kind, username, createdAt, mustChangePassword) VALUES (?, ?, ?, ?, ?)',
      [session.tokenHash, session.kind, session.username, session.createdAt, session.mustChangePassword ? 1 : 0]);
  }

  getSession(kind: StoredSession['kind'], tokenHash: string): StoredSession | undefined {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT tokenHash, kind, username, createdAt, mustChangePassword FROM web_sessions WHERE tokenHash = ? AND kind = ?', [tokenHash, kind]);
    if (!result.length) return undefined;
    const [hash, k, username, createdAt, mustChange] = result[0].values[0];
    return { tokenHash: String(hash), kind: k as StoredSession['kind'], username: String(username), createdAt: Number(createdAt), mustChangePassword: mustChange === 1 };
  }

  updateSession(kind: StoredSession['kind'], tokenHash: string, fields: { mustChangePassword: boolean }): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('UPDATE web_sessions SET mustChangePassword = ? WHERE tokenHash = ? AND kind = ?', [fields.mustChangePassword ? 1 : 0, tokenHash, kind]);
  }

  deleteSession(kind: StoredSession['kind'], tokenHash: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM web_sessions WHERE tokenHash = ? AND kind = ?', [tokenHash, kind]);
  }

  deleteSessionsForUser(kind: StoredSession['kind'], username: string, exceptTokenHash?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM web_sessions WHERE kind = ? AND username = ? AND tokenHash != ?', [kind, username, exceptTokenHash ?? '']);
  }

  deleteSessionsBefore(kind: StoredSession['kind'], createdBefore: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM web_sessions WHERE kind = ? AND createdAt < ?', [kind, createdBefore]);
  }

  /** The whole configuration database as SQLite bytes (for backups). */
  exportBytes(): Buffer {
    if (!this.db) throw new Error('Database not initialized');
    // sign-in sessions belong to this server's running state, not its configuration
    return this.db.serialize(['DELETE FROM web_sessions']);
  }

  /** Replace the configuration with a backup (validated first). */
  async restoreFrom(bytes: Buffer): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    // next to the database, so the finished file can be renamed into place
    const dir = fs.mkdtempSync(path.join(this.dbPath === ':memory:' ? os.tmpdir() : path.dirname(path.resolve(this.dbPath)), '.restore-'));
    const candidate = path.join(dir, 'restore.db');
    try {
      fs.writeFileSync(candidate, bytes, { mode: 0o600 });
      let check: SqliteDatabase | null = null;
      let tooNew = false;
      try {
        check = new SqliteDatabase(candidate, { readOnly: true });
        const tables = check.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
        const names = tables.length ? tables[0].values.map(r => r[0]) : [];
        if (!['users', 'listeners', 'virtual_paths'].every(t => names.includes(t))) throw new Error('missing tables');
        tooNew = this.schemaVersion(check) > SCHEMA_VERSION;
        const integrity = check.exec('PRAGMA quick_check');
        if (integrity[0]?.values[0]?.[0] !== 'ok') throw new Error('corrupt');
      } catch {
        throw new Error('This is not a SLightSFTP configuration backup');
      } finally {
        check?.close();
      }
      if (tooNew) throw new Error('This backup was made by a newer version of SLightSFTP; install that version to restore it');

      // the people signed in now stay signed in (sessions are not part of backups)
      const sessions = this.db.exec('SELECT tokenHash, kind, username, createdAt, mustChangePassword FROM web_sessions');
      const keep = sessions.length ? sessions[0].values : [];

      if (this.dbPath === ':memory:') {
        // copy the backup into the in-memory database, table by table
        this.db.close();
        this.db = new SqliteDatabase(':memory:');
        this.db.run('ATTACH DATABASE ? AS backup', [candidate]);
        const tables = this.db.exec("SELECT name, sql FROM backup.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
        for (const [name, sql] of tables.length ? tables[0].values : []) {
          this.db.run(String(sql));
          this.db.run(`INSERT INTO main."${String(name)}" SELECT * FROM backup."${String(name)}"`);
        }
        this.db.run('DETACH DATABASE backup');
      } else {
        // swap the file: close, replace (dropping the old journal), reopen
        this.db.close();
        this.db = null;
        for (const suffix of ['-wal', '-shm']) fs.rmSync(this.dbPath + suffix, { force: true });
        fs.renameSync(candidate, this.dbPath);
        this.db = this.open();
      }
      this.initialize(); // bring older backups up to the current schema
      this.db.run('DELETE FROM web_sessions');
      for (const row of keep) {
        this.db.run('INSERT OR REPLACE INTO web_sessions (tokenHash, kind, username, createdAt, mustChangePassword) VALUES (?, ?, ?, ?, ?)', row);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!this.db) this.db = this.open(); // never leave the manager without a database
    }
  }

  close(): void {
    if (this.db && this.initialized) {
      try {
        this.db.close();
        this.db = null;
        this.initialized = false;
        logger.debug('Database closed');
      } catch (err) {
        logger.error('Error closing database:', err);
        // Even if there's an error, mark as not initialized to prevent further operations
        this.db = null;
        this.initialized = false;
      }
    }
  }
}
