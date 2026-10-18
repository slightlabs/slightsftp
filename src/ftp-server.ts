import { FtpSrv, FileSystem } from 'ftp-srv';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { Listener, User, Permission } from './types';
import { EventEmitter } from 'events';
import logger from './logger';
import { getServerCertificate } from './tls';
import { uploadChecksum } from './checksum';
import { QuotaExceededError, QuotaManager, getQuotaManager } from './quota';
import { RateLimiter, getLimiter } from './bandwidth';
import { deleteFile } from './recycle-bin';
import { verifyUserPassword } from './credentials';
import { getLoginGuard, TOO_MANY_ATTEMPTS, userIpAllowed } from './login-guard';
import { SessionTransferStats, TransferDirection, TransferHandle, TransferTracker } from './transfers';
import { Readable, Transform, Writable } from 'stream';
import { resolveUserPath } from './path-utils';
import { CloudEntry, CloudTarget, cloudTarget, entryMode, isCloudPath, stagingFile } from './cloud-storage';

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
  private transfers = new TransferTracker();

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
        // Behind NAT / in containers: FTP_PASV_URL is the address clients should connect
        // back to, FTP_PASV_MIN / FTP_PASV_MAX the published passive port range
        pasv_url: process.env.FTP_PASV_URL || this.listener.bindingIp,
        pasv_min: Number(process.env.FTP_PASV_MIN) || 1024,
        pasv_max: Number(process.env.FTP_PASV_MAX) || 65535,
        anonymous: false,
        tls,
        greeting: ['Welcome to SLightSFTP Server']
      });

      this.server.on('login', async ({ connection, username, password }, resolve, reject) => {
        logger.info(`FTP login attempt: ${username}`);
        const sessionId = `ftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const ipAddress = connection.ip || 'unknown';
        const remotePort = (connection as any).socket?.remotePort || 0;

        const guard = getLoginGuard(this.db);
        if (guard.isBanned(ipAddress)) {
          this.logActivity(`LOGIN_REFUSED (IP banned) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error(TOO_MANY_ATTEMPTS));
        }

        if (tlsMode === 'required' && !connection.secure) {
          this.logActivity(`LOGIN_FAILED (TLS required) [${ipAddress}:${remotePort}]`, username, '/', false);
          return reject(new Error('This server requires an encrypted connection (AUTH TLS)'));
        }

        const user = this.db.getUser(username);
        if (!user) {
          this.logActivity(`LOGIN_FAILED (User not found) [${ipAddress}:${remotePort}]`, username, '/', false);
          guard.recordFailure(ipAddress, 'FTP', username);
          return reject(new Error('Invalid credentials'));
        }

        const userListeners = this.db.getUserListeners(user.id!);
        if (!userListeners.includes(this.listener.id!)) {
          this.logActivity(`LOGIN_FAILED (Not authorized for this listener) [${ipAddress}:${remotePort}]`, username, '/', false);
          guard.recordFailure(ipAddress, 'FTP', username);
          return reject(new Error('User not subscribed to this listener'));
        }

        if (!userIpAllowed(user, ipAddress)) {
          this.logActivity(`LOGIN_FAILED (IP not allowed) [${ipAddress}:${remotePort}]`, username, '/', false);
          guard.recordFailure(ipAddress, 'FTP', username);
          return reject(new Error('Invalid credentials'));
        }

        // Verify password
        if (!user.passwordEnabled || !(await verifyUserPassword(this.db, user, password, true))) {
          this.logActivity(`LOGIN_FAILED (Invalid password) [${ipAddress}:${remotePort}]`, username, '/', false);
          guard.recordFailure(ipAddress, 'FTP', username);
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

        guard.recordSuccess(ipAddress);
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
          (action: string, filePath: string, success: boolean, bytes?: number, checksum?: string) => {
            this.logActivity(action, username, filePath, success, bytes, checksum);
          },
          (filePath, direction) => this.transfers.start(sessionId, filePath, direction)
        );

        connection.on('error', (err: any) => {
          logger.error('FTP connection error:', err);
        });

        // Completed transfers: one UPLOAD / DOWNLOAD entry with the file size
        const logTransfer = (action: 'UPLOAD' | 'DOWNLOAD') => async (err: any, localPath: string) => {
          if (err || !localPath || isCloudPath(localPath)) return;
          const virtual = toVirtualPath(virtualPaths, localPath);
          const size = await fs.promises.stat(localPath).then(st => st.size).catch(() => undefined);
          const checksum = action === 'UPLOAD' ? await uploadChecksum(this.db, localPath) : undefined;
          this.logActivity(action, username, virtual, true, size, checksum);
        };
        connection.on('STOR', logTransfer('UPLOAD'));
        connection.on('RETR', logTransfer('DOWNLOAD'));

        connection.on('close', () => {
          logger.info(`FTP user disconnected: ${username}`);
          this.activeSessions.delete(sessionId);
          this.transfers.endSession(sessionId);
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

  getActiveSessions(): Array<{ sessionId: string; username: string; ipAddress: string; connectedAt: Date } & SessionTransferStats> {
    return Array.from(this.activeSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      username: session.username,
      ipAddress: session.ipAddress,
      connectedAt: session.connectedAt,
      ...this.transfers.stats(sessionId)
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

  private logActivity(action: string, username: string, filePath: string, success: boolean, bytes?: number, checksum?: string): void {
    this.emit('activity', {
      listenerId: this.listener.id!,
      username: username,
      action,
      path: filePath,
      bytes,
      checksum,
      success
    });
  }
}

/**
 * Count bytes flowing through a file stream for the live transfers view without
 * changing how the stream flows: ftp-srv pipes into write streams and attaches
 * its own 'data' handler to read streams, so we wrap write() / push() instead.
 */
function countBytes(stream: any, handle: TransferHandle | undefined, method: 'write' | 'push'): void {
  if (!handle) return;
  const original = stream[method].bind(stream);
  stream[method] = (chunk: any, ...rest: any[]) => {
    if (chunk && typeof chunk.length === 'number') handle.add(chunk.length);
    return original(chunk, ...rest);
  };
  const end = () => handle.end();
  // Never listen for 'close' here: ftp-srv's STOR emits 'close' *instead of*
  // calling end() when a 'close' listener exists, which would hang the upload.
  stream.once(method === 'write' ? 'finish' : 'end', end);
  stream.once('error', end);
}

/**
 * Bandwidth limits for FTP without changing how ftp-srv drives the streams:
 * uploads report backpressure (write() returns false, 'drain' comes later) and
 * downloads delay the resume() ftp-srv calls after each chunk is sent.
 */
function paceStream(stream: any, limiter: RateLimiter | null, kind: 'upload' | 'download'): void {
  if (!limiter) return;
  if (kind === 'upload') {
    const original = stream.write.bind(stream);
    stream.write = (chunk: any, ...rest: any[]) => {
      const ok = original(chunk, ...rest);
      const wait = limiter.delayFor(chunk?.length || 0);
      if (wait <= 0) return ok;
      setTimeout(() => stream.emit('drain'), wait);
      return false;
    };
  } else {
    // count via push(): a 'data' listener here would start the stream flowing early
    let pending = 0;
    const push = stream.push.bind(stream);
    stream.push = (chunk: any, ...rest: any[]) => {
      if (chunk && typeof chunk.length === 'number') pending += chunk.length;
      return push(chunk, ...rest);
    };
    const resume = stream.resume.bind(stream);
    stream.resume = () => {
      const wait = limiter.delayFor(pending);
      pending = 0;
      if (wait > 0) setTimeout(resume, wait);
      else resume();
      return stream;
    };
  }
}

/** Abort an upload stream once it would take the user over their storage quota. */
function enforceQuota(stream: any, user: User, quota: QuotaManager, onExceeded: () => void): void {
  const original = stream.write.bind(stream);
  stream.write = (chunk: any, ...rest: any[]) => {
    const size = chunk && typeof chunk.length === 'number' ? chunk.length : 0;
    if (quota.wouldExceed(user, size)) {
      onExceeded();
      stream.destroy(new QuotaExceededError(user.quotaBytes!));
      return false;
    }
    quota.adjust(user.username, size);
    return original(chunk, ...rest);
  };
}

/** Map a local file path back to the user's virtual path (for activity entries). */
export function toVirtualPath(virtualPaths: Array<{ virtualPath: string; localPath: string }>, localPath: string): string {
  const resolved = path.resolve(localPath);
  const sorted = [...virtualPaths].sort((a, b) => b.localPath.length - a.localPath.length);
  for (const vp of sorted) {
    const root = path.resolve(vp.localPath);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      const rel = path.relative(root, resolved).split(path.sep).join('/');
      return path.posix.join(vp.virtualPath || '/', rel) || '/';
    }
  }
  return path.basename(localPath);
}

/** ftp-srv expects fs.Stats-like objects in listings. */
function cloudStat(entry: CloudEntry, name: string) {
  return {
    name,
    size: entry.size,
    mtime: entry.mtime,
    mode: entryMode(entry),
    uid: 0,
    gid: 0,
    isDirectory: () => entry.isDir,
    isFile: () => !entry.isDir,
  };
}

/**
 * An FTP upload into cloud storage: bytes go to a local staging file, and the
 * file is uploaded before 'finish' (so the client's 226 means it is stored).
 */
class CloudUploadStream extends Writable {
  private temp = stagingFile();
  private fd: number | null = null;
  private position = 0;
  private finished = false;
  bytes = 0;

  constructor(
    private db: DatabaseManager,
    private target: CloudTarget,
    /** what ftp-srv reports as the server path (kept as cloud:// so the STOR logger skips it) */
    public path: string,
    private keep: { from?: Readable; position?: number },
    private onStored: (bytes: number, checksum?: string) => void
  ) {
    super();
  }

  _construct(callback: (err?: Error | null) => void): void {
    this.fd = fs.openSync(this.temp, 'w+', 0o600);
    if (!this.keep.from) return callback();
    // append / resume: start from the existing object
    const out = fs.createWriteStream('', { fd: this.fd, autoClose: false });
    this.keep.from.pipe(out);
    out.once('finish', () => {
      this.position = this.keep.position ?? out.bytesWritten;
      fs.ftruncateSync(this.fd!, this.position);
      callback();
    });
    out.once('error', callback);
    this.keep.from.once('error', callback);
  }

  _write(chunk: Buffer, _enc: BufferEncoding, callback: (err?: Error | null) => void): void {
    fs.write(this.fd!, chunk, 0, chunk.length, this.position, err => {
      if (!err) {
        this.position += chunk.length;
        this.bytes += chunk.length;
      }
      callback(err);
    });
  }

  _final(callback: (err?: Error | null) => void): void {
    fs.closeSync(this.fd!);
    this.fd = null;
    uploadChecksum(this.db, this.temp)
      .then(sum => this.target.backend.write(this.target.key, fs.createReadStream(this.temp)).then(() => sum))
      .then(sum => {
        this.finished = true;
        fs.rmSync(this.temp, { force: true });
        this.onStored(this.bytes, sum);
        callback();
      }, err => callback(err));
  }

  _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    if (!this.finished) fs.rmSync(this.temp, { force: true });
    callback(err);
  }
}

export class CustomFileSystem extends FileSystem {
  private db: DatabaseManager;
  private user: User;
  private listener: Listener;
  private permissions: Permission;
  private virtualPaths: any[];
  private logCallback: (action: string, path: string, success: boolean, bytes?: number, checksum?: string) => void;
  private track?: (path: string, direction: TransferDirection) => TransferHandle;

  constructor(
    connection: any,
    options: any,
    db: DatabaseManager,
    user: User,
    listener: Listener,
    permissions: Permission,
    virtualPaths: any[],
    logCallback: (action: string, path: string, success: boolean, bytes?: number, checksum?: string) => void,
    track?: (path: string, direction: TransferDirection) => TransferHandle
  ) {
    super(connection, options);
    this.track = track;
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
    
    // Otherwise map the virtual path to local path (the most specific virtual path wins)
    const best = resolveUserPath(this.virtualPaths, joinedPath);
    if (best && !isCloudPath(best.localPath)) {
      return { clientPath: joinedPath.replace(/\\/g, '/'), fsPath: this.confine(best.localPath) };
    }
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
    const best = resolveUserPath(this.virtualPaths, virtual);
    if (best && !isCloudPath(best.localPath)) return this.confine(best.localPath);
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

  /** The absolute virtual path for a client path (which may be relative to the cwd). */
  private toVirtual(clientPath: string = '.'): string {
    const p = (clientPath || '.').replace(/\\/g, '/');
    return path.posix.normalize(p.startsWith('/') ? p : path.posix.join('/', (this as any).cwd || '/', p));
  }

  /** Where a path lives when it is inside a cloud virtual path (null for local paths). */
  private cloud(clientPath?: string): { target: CloudTarget; virtual: string; url: string } | null {
    const virtual = this.toVirtual(clientPath);
    const resolved = resolveUserPath(this.virtualPaths, virtual);
    if (!resolved || !isCloudPath(resolved.localPath)) return null;
    return { target: cloudTarget(this.db, resolved.localPath)!, virtual, url: resolved.localPath };
  }

  private findVirtualPath(virtualPath: string) {
    // relative names count against the folder they are in, and the most specific virtual path wins
    const resolved = resolveUserPath(this.virtualPaths, this.toVirtual(virtualPath));
    if (resolved) return resolved.virtualPath as any;
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

    const cloud = this.cloud(fileName);
    if (cloud) {
      return cloud.target.backend.stat(cloud.target.key).then(entry => {
        if (!entry) throw Object.assign(new Error('No such file or directory'), { code: 'ENOENT' });
        this.logCallback('GET', fileName, true);
        return cloudStat(entry, fileName);
      });
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

    const cloud = this.cloud(dirPath);
    if (cloud) {
      return cloud.target.backend.list(cloud.target.key)
        .then(entries => entries.map(e => cloudStat(e, e.name)))
        .catch((err: Error) => {
          this.logCallback('LIST_FAILED', dirPath, false);
          throw err;
        });
    }
    
    // Use parent's list method which properly returns stat objects with methods
    return super.list(dirPath).catch((err: Error) => {
      this.logCallback('LIST_FAILED', dirPath, false);
      throw err;
    });
  }

  chdir(dirPath: string = '.'): Promise<any> {
    const cloud = this.cloud(dirPath);
    if (!cloud) return super.chdir(dirPath);
    return cloud.target.backend.stat(cloud.target.key).then(entry => {
      if (!entry?.isDir) throw new Error('Not a valid directory');
      (this as any).cwd = cloud.virtual;
      return cloud.virtual;
    });
  }

  write(fileName: string, options?: any): Promise<any> {
    if (!this.checkVpPermission('canCreate', fileName) && !this.checkVpPermission('canEdit', fileName)) {
      this.logCallback('WRITE_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const cloud = this.cloud(fileName);
    if (cloud) return this.writeCloud(fileName, cloud, options);

    const realPath = this.mapPath(fileName);
    this.logCallback('WRITE', fileName, true);

    const quota = getQuotaManager(this.db);
    const hasQuota = !!this.user.quotaBytes;
    const prepare = hasQuota ? quota.usage(this.user).catch(() => undefined) : Promise.resolve();

    return prepare.then(() => new Promise((resolve, reject) => {
      // an overwrite (not append) frees the old file's space
      if (hasQuota && !options?.append && fs.existsSync(realPath)) {
        quota.adjust(this.user.username, -fs.statSync(realPath).size);
      }
      const writeStream = fs.createWriteStream(realPath, options);
      countBytes(writeStream, this.track?.(fileName, 'upload'), 'write');
      if (hasQuota) enforceQuota(writeStream, this.user, quota, () => this.logCallback('WRITE_DENIED (quota exceeded)', fileName, false));
      paceStream(writeStream, getLimiter(this.db, this.user, 'upload'), 'upload');
      writeStream.on('error', (err) => {
        this.logCallback('WRITE_FAILED', fileName, false);
        reject(err);
      });
      writeStream.on('finish', () => {
        resolve({ stream: writeStream });
      });
      resolve({ stream: writeStream });
    }));
  }

  read(fileName: string, options?: any): Promise<any> {
    if (!this.checkVpPermission('canRead', fileName)) {
      this.logCallback('READ_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const cloud = this.cloud(fileName);
    if (cloud) return this.readCloud(fileName, cloud, options);

    const realPath = this.mapPath(fileName);
    this.logCallback('READ', fileName, true);

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(realPath, options);
      countBytes(readStream, this.track?.(fileName, 'download'), 'push');
      paceStream(readStream, getLimiter(this.db, this.user, 'download'), 'download');
      readStream.on('error', (err) => {
        this.logCallback('READ_FAILED', fileName, false);
        reject(err);
      });
      resolve({ stream: readStream });
    });
  }

  delete(fileName: string): Promise<any> {
    getQuotaManager(this.db).invalidate(this.user.username);
    if (!this.checkVpPermission('canDelete', fileName)) {
      this.logCallback('DELETE_DENIED', fileName, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const cloud = this.cloud(fileName);
    if (cloud) {
      const { backend, key } = cloud.target;
      // cloud files are deleted directly (the recycle bin is for local folders)
      return backend.stat(key)
        .then(entry => (entry?.isDir ? backend.rmdir(key) : backend.remove(key)))
        .then(() => { this.logCallback('DELETE', fileName, true); })
        .catch((err: Error) => {
          this.logCallback('DELETE_FAILED', fileName, false);
          throw err;
        });
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
          try {
            const virtual = toVirtualPath(this.virtualPaths, realPath);
            if (deleteFile(this.db, this.user.username, virtual, realPath) === 'trashed') {
              this.logCallback('DELETE (to recycle bin)', fileName, true);
            }
            resolve(undefined);
          } catch (err) {
            this.logCallback('DELETE_FAILED', fileName, false);
            reject(err);
          }
        }
      });
    });
  }

  mkdir(dirPath: string): Promise<any> {
    if (!this.checkVpPermission('canCreateDir', dirPath)) {
      this.logCallback('MKDIR_DENIED', dirPath, false);
      return Promise.reject(new Error('Permission denied'));
    }

    const cloud = this.cloud(dirPath);
    if (cloud) {
      return cloud.target.backend.mkdir(cloud.target.key).then(() => {
        this.logCallback('MKDIR', dirPath, true);
        return cloud.virtual;
      }, (err: Error) => {
        this.logCallback('MKDIR_FAILED', dirPath, false);
        throw err;
      });
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

    const cloudFrom = this.cloud(fromPath);
    const cloudTo = this.cloud(toPath);
    if (cloudFrom || cloudTo) {
      if (!cloudFrom || !cloudTo || cloudFrom.target.connectionId !== cloudTo.target.connectionId) {
        this.logCallback('RENAME_FAILED', `${fromPath} -> ${toPath}`, false);
        return Promise.reject(new Error('Cannot move between different storage locations'));
      }
      return cloudFrom.target.backend.rename(cloudFrom.target.key, cloudTo.target.key).then(() => {
        this.logCallback('RENAME', `${fromPath} -> ${toPath}`, true);
      }, (err: Error) => {
        this.logCallback('RENAME_FAILED', `${fromPath} -> ${toPath}`, false);
        throw err;
      });
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
    // For simplicity, always allow chmod (cloud objects have no permissions to change)
    if (this.cloud(fileName)) return Promise.resolve(undefined);
    const realPath = this.mapPath(fileName);
    return new Promise((resolve, reject) => {
      fs.chmod(realPath, parseInt(mode, 8), (err) => {
        if (err) return reject(err);
        resolve(undefined);
      });
    });
  }

  private async writeCloud(fileName: string, cloud: { target: CloudTarget; virtual: string; url: string }, options?: any): Promise<any> {
    const { backend, key } = cloud.target;
    const quota = getQuotaManager(this.db);
    const hasQuota = !!this.user.quotaBytes;
    if (hasQuota) await quota.usage(this.user).catch(() => undefined);
    const existing = await backend.stat(key);
    if (existing?.isDir) throw new Error('Cannot overwrite a folder');
    // an overwrite (not append) frees the old file's space
    if (hasQuota && existing && !options?.append) quota.adjust(this.user.username, -existing.size);
    const keepExisting = !!existing && (options?.append || options?.start > 0);
    const from = keepExisting ? await backend.read(key) : undefined;
    this.logCallback('WRITE', fileName, true);

    const stream = new CloudUploadStream(this.db, cloud.target, cloud.url,
      { from, position: options?.append ? undefined : options?.start },
      (bytes, checksum) => this.logCallback('UPLOAD', cloud.virtual, true, bytes, checksum));
    countBytes(stream, this.track?.(fileName, 'upload'), 'write');
    if (hasQuota) enforceQuota(stream, this.user, quota, () => this.logCallback('WRITE_DENIED (quota exceeded)', fileName, false));
    paceStream(stream, getLimiter(this.db, this.user, 'upload'), 'upload');
    stream.on('error', () => this.logCallback('WRITE_FAILED', fileName, false));
    return { stream, clientPath: cloud.virtual };
  }

  private async readCloud(fileName: string, cloud: { target: CloudTarget; virtual: string; url: string }, options?: any): Promise<any> {
    const { backend, key } = cloud.target;
    const entry = await backend.stat(key);
    if (!entry) throw Object.assign(new Error('No such file or directory'), { code: 'ENOENT' });
    if (entry.isDir) throw new Error('Cannot read a directory');
    const source = await backend.read(key, options?.start || 0);
    this.logCallback('READ', fileName, true);

    // ftp-srv drives this stream (pause / resume per chunk); the source is piped in
    let bytes = 0;
    const stream: any = new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    stream.path = cloud.url;
    source.once('error', (err: Error) => stream.destroy(err));
    source.pipe(stream);
    countBytes(stream, this.track?.(fileName, 'download'), 'push');
    paceStream(stream, getLimiter(this.db, this.user, 'download'), 'download');
    stream.once('end', () => this.logCallback('DOWNLOAD', cloud.virtual, true, bytes));
    stream.once('error', () => this.logCallback('READ_FAILED', fileName, false));
    return { stream, clientPath: cloud.virtual };
  }

}
