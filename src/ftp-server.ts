import { FtpSrv, FileSystem } from 'ftp-srv';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { Listener, User, Permission } from './types';
import { EventEmitter } from 'events';
import logger from './logger';
import { getServerCertificate } from './tls';

interface ClientSession {
  connection: any;
  username: string;
  ipAddress: string;
  connectedAt: Date;
}

export class FTPServer extends EventEmitter {
  private server: FtpSrv | null = null;
  private listener: Listener;
  private db: DatabaseManager;
  private activeSessions: Map<string, ClientSession> = new Map();

  constructor(listener: Listener, db: DatabaseManager) {
    super();
    this.listener = listener;
    this.db = db;
  }

  async start(): Promise<void> {
    // Explicit FTPS: clients upgrade the control (and data) channel with AUTH TLS / PROT P
    const tlsMode = this.listener.tlsMode || 'none';
    const tls = tlsMode === 'none' ? false : await getServerCertificate({
      certPath: this.db.getSetting('tlsCertPath'),
      keyPath: this.db.getSetting('tlsKeyPath')
    }).then(c => ({ key: c.key, cert: c.cert }));

    return new Promise((resolve, reject) => {
      this.server = new FtpSrv({
        url: `ftp://${this.listener.bindingIp}:${this.listener.port}`,
        pasv_url: this.listener.bindingIp,
        anonymous: false,
        tls,
        greeting: ['Welcome to SLightSFTP Server']
      });

      this.server.on('login', ({ connection, username, password }, resolve, reject) => {
        logger.info(`FTP login attempt: ${username}`);
        const sessionId = `ftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const ipAddress = connection.ip || 'unknown';
        const remotePort = (connection as any).socket?.remotePort || 0;

        if (tlsMode === 'required' && !connection.secure) {
          this.logActivity(`LOGIN_FAILED (TLS required) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error('This server requires an encrypted connection (AUTH TLS)'));
        }

        const user = this.db.getUser(username);
        if (!user) {
          this.logActivity(`LOGIN_FAILED (User not found) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error('Invalid credentials'));
        }

        const userListeners = this.db.getUserListeners(user.id!);
        if (!userListeners.includes(this.listener.id!)) {
          this.logActivity(`LOGIN_FAILED (Not authorized for this listener) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error('User not subscribed to this listener'));
        }

        // Verify password
        if (!user.passwordEnabled || !this.db.verifyPassword(username, password)) {
          this.logActivity(`LOGIN_FAILED (Invalid password) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error('Invalid credentials'));
        }

        const virtualPaths = this.db.getVirtualPaths(user.id!);
        const userPermissions = this.db.getPermission(user.id!, this.listener.id!);

        // Default to first virtual path or root
        const rootPath = virtualPaths.length > 0 ? virtualPaths[0].localPath : process.cwd();
        
        // Track active session
        this.activeSessions.set(sessionId, {
          connection,
          username,
          ipAddress,
          connectedAt: new Date()
        });

        this.logActivity(`LOGIN (password) [${ipAddress}:${remotePort}]`, username, '/', true);

        // Create custom file system
        const customFS = new CustomFileSystem(
          connection,
          {
            root: rootPath,
            cwd: '/'
          },
          this.db,
          user,
          this.listener,
          userPermissions || this.createDefaultPermission(user.id!, this.listener.id!),
          virtualPaths,
          (action: string, filePath: string, success: boolean) => {
            this.logActivity(action, username, filePath, success);
          }
        );

        connection.on('error', (err: any) => {
          logger.error('FTP connection error:', err);
        });

        connection.on('close', () => {
          logger.info(`FTP user disconnected: ${username}`);
          this.activeSessions.delete(sessionId);
          this.logActivity('LOGOUT', username, '/', true);
        });

        resolve({ fs: customFS });
      });

      this.server.listen()
        .then(() => {
          logger.info(`FTP server listening on ${this.listener.bindingIp}:${this.listener.port}`);
          this.emit('started');
          resolve();
        })
        .catch((err: Error) => {
          logger.error('FTP server error:', err);
          this.emit('error', err);
          reject(err);
        });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Clear all active sessions
      this.activeSessions.clear();
      
      if (this.server) {
        this.server.close()
          .then(() => {
            logger.info('FTP server stopped');
            this.emit('stopped');
            resolve();
          })
          .catch(() => {
            resolve();
          });
      } else {
        resolve();
      }
    });
  }

  getActiveSessions(): Array<{ sessionId: string; username: string; ipAddress: string; connectedAt: Date }> {
    return Array.from(this.activeSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      username: session.username,
      ipAddress: session.ipAddress,
      connectedAt: session.connectedAt
    }));
  }

  disconnectSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.connection.close();
      this.activeSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  private createDefaultPermission(userId: number, listenerId: number): Permission {
    return {
      userId,
      listenerId,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true
    };
  }

  private logActivity(action: string, username: string, filePath: string, success: boolean): void {
    this.emit('activity', {
      listenerId: this.listener.id!,
      username: username,
      action,
      path: filePath,
      success
    });
  }
}

export class CustomFileSystem extends FileSystem {
  private db: DatabaseManager;
  private user: User;
  private listener: Listener;
  private permissions: Permission;
  private virtualPaths: any[];
  private logCallback: (action: string, path: string, success: boolean) => void;

  constructor(
    connection: any,
    options: any,
    db: DatabaseManager,
    user: User,
    listener: Listener,
    permissions: Permission,
    virtualPaths: any[],
    logCallback: (action: string, path: string, success: boolean) => void
  ) {
    super(connection, options);
    this.db = db;
    this.user = user;
    this.listener = listener;
    this.permissions = permissions;
    this.virtualPaths = virtualPaths;
    this.logCallback = logCallback;
  }

  // Override _resolvePath to fix double path resolution issue
  _resolvePath(inputPath: string = '.'): { clientPath: string; fsPath: string } {
    // Normalize separators to forward slashes
    const resolvedPath = inputPath.replace(/\\/g, '/');
    
    // Join cwd with new path
    const joinedPath = path.posix.normalize(path.posix.isAbsolute(resolvedPath)
      ? resolvedPath
      : path.posix.join('/', this.cwd, resolvedPath));
    
    // Map through our virtual path system
    let fsPath: string;
    
    // Check if we already have an absolute path within our virtual paths
    if (path.isAbsolute(resolvedPath)) {
      for (const vp of this.virtualPaths) {
        if (resolvedPath.startsWith(vp.localPath) || resolvedPath.replace(/\\/g, '/').startsWith(vp.localPath.replace(/\\/g, '/'))) {
          // Already correctly resolved
          fsPath = this.confine(resolvedPath);
          return {
            clientPath: joinedPath.replace(/\\/g, '/'),
            fsPath: fsPath
          };
        }
      }
    }
    
    // Otherwise map the virtual path to local path
    for (const vp of this.virtualPaths) {
      if (joinedPath.startsWith(vp.virtualPath)) {
        const relativePath = joinedPath.substring(vp.virtualPath.length);
        fsPath = this.confine(path.join(vp.localPath, relativePath));
        return {
          clientPath: joinedPath.replace(/\\/g, '/'),
          fsPath: fsPath
        };
      }
    }
    
    // Default: use first virtual path or root
    fsPath = this.confine(this.virtualPaths.length > 0
      ? path.join(this.virtualPaths[0].localPath, joinedPath)
      : path.join(this.root as string, joinedPath));
    
    return {
      clientPath: joinedPath.replace(/\\/g, '/'),
      fsPath: fsPath
    };
  }

  private mapPath(virtualPath: string): string {
    // Normalize path separators
    const normalizedPath = virtualPath.replace(/\\/g, '/');
    
    // If path is already absolute (Windows or Unix), check if it's within our allowed paths
    if (path.isAbsolute(virtualPath)) {
      // Check if the path is already within one of our virtual paths
      for (const vp of this.virtualPaths) {
        const normalizedLocalPath = vp.localPath.replace(/\\/g, '/');
        const normalizedVirtualPath = virtualPath.replace(/\\/g, '/');
        
        if (normalizedVirtualPath.startsWith(normalizedLocalPath) || 
            normalizedVirtualPath.startsWith(normalizedLocalPath.replace(/\//g, '\\'))) {
          // Already an absolute local path - only accept it if it stays inside the root
          return this.confine(virtualPath);
        }
      }
      
      // If root is set and path starts with it, also return as-is
      const rootPath = this.root as string;
      if (rootPath && (virtualPath.startsWith(rootPath) || virtualPath.startsWith(rootPath.replace(/\\/g, '/')))) {
        return this.confine(virtualPath);
      }
    }
    
    // Handle relative/virtual paths: resolve against the cwd and collapse ".."
    // so a client can never climb above the virtual root
    const virtual = path.posix.normalize(
      normalizedPath.startsWith('/') ? normalizedPath : path.posix.join('/', (this as any).cwd || '/', normalizedPath)
    );
    for (const vp of this.virtualPaths) {
      if (virtual.startsWith(vp.virtualPath)) {
        const relativePath = virtual.substring(vp.virtualPath.length);
        return this.confine(path.join(vp.localPath, relativePath));
      }
    }
    
    // Default mapping
    return this.confine(this.virtualPaths.length > 0
      ? path.join(this.virtualPaths[0].localPath, virtual)
      : path.join(this.root as string, virtual));
  }

  /** Throw unless fsPath lies inside one of the user's local roots. */
  private confine(fsPath: string): string {
    const resolved = path.resolve(fsPath);
    const roots = [...this.virtualPaths.map(vp => vp.localPath), this.root as string].filter(Boolean);
    for (const rootPath of roots) {
      const root = path.resolve(rootPath);
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return resolved;
      }
    }
    this.logCallback('PATH_ESCAPE_DENIED', fsPath, false);
    throw new Error('Permission denied');
  }

  private findVirtualPath(virtualPath: string) {
    for (const vp of this.virtualPaths) {
      if (virtualPath.startsWith(vp.virtualPath) || vp.virtualPath === '/') {
        return vp;
      }
    }
    return this.virtualPaths.length > 0 ? this.virtualPaths[0] : null;
  }

  private checkVpPermission(action: keyof Permission, virtualPath: string): boolean {
    // First check listener-level permissions
    if (!this.permissions[action]) return false;
    
    // Then check virtual path permissions
    const vp = this.findVirtualPath(virtualPath);
    if (!vp) return false;
    
    // Map Permission keys to VirtualPath permission keys
    const vpPermMap: Record<string, string> = {
      'canRead': 'canRead',
      'canCreate': 'canWrite',
      'canEdit': 'canWrite',
      'canAppend': 'canAppend',
      'canDelete': 'canDelete',
      'canList': 'canList',
      'canCreateDir': 'canCreateDir',
      'canRename': 'canRename'
    };
    
    const vpPermKey = vpPermMap[action];
    if (!vpPermKey || !vp.hasOwnProperty(vpPermKey)) return false;
    
    return vp[vpPermKey] !== false;
  }

  get(fileName: string): Promise<any> {
    if (!this.checkVpPermission('canRead', fileName)) {
      this.logCallback('GET_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realPath = this.mapPath(fileName);
    this.logCallback('GET', fileName, true);
    return super.get(realPath);
  }

  list(dirPath: string = '.'): Promise<any> {
    if (!this.checkVpPermission('canList', dirPath)) {
      this.logCallback('LIST_DENIED', dirPath, false);
      return Promise.reject(new Error('Permission denied'));
    }

    this.logCallback('LIST', dirPath, true);
    
    // Use parent's list method which properly returns stat objects with methods
    return super.list(dirPath).catch((err: Error) => {
      this.logCallback('LIST_FAILED', dirPath, false);
      throw err;
    });
  }

  write(fileName: string, options?: any): Promise<any> {
    if (!this.checkVpPermission('canCreate', fileName) && !this.checkVpPermission('canEdit', fileName)) {
      this.logCallback('WRITE_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realPath = this.mapPath(fileName);
    this.logCallback('WRITE', fileName, true);

    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(realPath, options);
      writeStream.on('error', (err) => {
        this.logCallback('WRITE_FAILED', fileName, false);
        reject(err);
      });
      writeStream.on('finish', () => {
        resolve({ stream: writeStream });
      });
      resolve({ stream: writeStream });
    });
  }

  read(fileName: string, options?: any): Promise<any> {
    if (!this.checkVpPermission('canRead', fileName)) {
      this.logCallback('READ_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realPath = this.mapPath(fileName);
    this.logCallback('READ', fileName, true);

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(realPath, options);
      readStream.on('error', (err) => {
        this.logCallback('READ_FAILED', fileName, false);
        reject(err);
      });
      resolve({ stream: readStream });
    });
  }

  delete(fileName: string): Promise<any> {
    if (!this.checkVpPermission('canDelete', fileName)) {
      this.logCallback('DELETE_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realPath = this.mapPath(fileName);
    this.logCallback('DELETE', fileName, true);

    return new Promise((resolve, reject) => {
      fs.stat(realPath, (err, stats) => {
        if (err) {
          this.logCallback('DELETE_FAILED', fileName, false);
          return reject(err);
        }

        if (stats.isDirectory()) {
          fs.rmdir(realPath, (err) => {
            if (err) {
              this.logCallback('DELETE_FAILED', fileName, false);
              return reject(err);
            }
            resolve(undefined);
          });
        } else {
          fs.unlink(realPath, (err) => {
            if (err) {
              this.logCallback('DELETE_FAILED', fileName, false);
              return reject(err);
            }
            resolve(undefined);
          });
        }
      });
    });
  }

  mkdir(dirPath: string): Promise<any> {
    if (!this.checkVpPermission('canCreateDir', dirPath)) {
      this.logCallback('MKDIR_DENIED', dirPath, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realPath = this.mapPath(dirPath);
    this.logCallback('MKDIR', dirPath, true);

    return new Promise((resolve, reject) => {
      fs.mkdir(realPath, { recursive: true }, (err) => {
        if (err) {
          this.logCallback('MKDIR_FAILED', dirPath, false);
          return reject(err);
        }
        resolve(undefined);
      });
    });
  }

  rename(fromPath: string, toPath: string): Promise<any> {
    if (!this.checkVpPermission('canRename', fromPath) || !this.checkVpPermission('canRename', toPath)) {
      this.logCallback('RENAME_DENIED', `${fromPath} -> ${toPath}`, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const realFromPath = this.mapPath(fromPath);
    const realToPath = this.mapPath(toPath);
    this.logCallback('RENAME', `${fromPath} -> ${toPath}`, true);

    return new Promise((resolve, reject) => {
      fs.rename(realFromPath, realToPath, (err) => {
        if (err) {
          this.logCallback('RENAME_FAILED', `${fromPath} -> ${toPath}`, false);
          return reject(err);
        }
        resolve(undefined);
      });
    });
  }

  chmod(fileName: string, mode: string): Promise<any> {
    // For simplicity, always allow chmod
    const realPath = this.mapPath(fileName);
    return new Promise((resolve, reject) => {
      fs.chmod(realPath, parseInt(mode, 8), (err) => {
        if (err) return reject(err);
        resolve(undefined);
      });
    });
  }
}
