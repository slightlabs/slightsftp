import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { Listener, User, Permission } from './types';
import { EventEmitter } from 'events';import logger from './logger';
import { loadOrCreateHostKey } from './tls';
import { SessionTransferStats, TransferHandle, TransferTracker } from './transfers';
// SFTP constants (from ssh2-streams)
const SFTP_STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
};

const SFTP_OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020
};

interface ClientSession {
  client: any;
  username: string;
  ipAddress: string;
  connectedAt: Date;
}

export class SFTPServer extends EventEmitter {
  private server: ssh2.Server | null = null;
  private listener: Listener;
  private db: DatabaseManager;
  private hostKeys: Buffer[] = [];
  private dirHandles: Map<string, { path: string; files: string[]; sentAll: boolean; client: any }> | null = null;
  private idleTimeoutMs: number = 300000; // 5 minutes default
  private clientTimeouts: Map<any, NodeJS.Timeout> = new Map();
  private activeSessions: Map<string, ClientSession> = new Map();
  private transfers = new TransferTracker();

  constructor(listener: Listener, db: DatabaseManager, idleTimeoutMs?: number) {
    super();
    this.listener = listener;
    this.db = db;
    if (idleTimeoutMs !== undefined) {
      this.idleTimeoutMs = idleTimeoutMs;
    }
    this.generateHostKeys();
  }

  private generateHostKeys(): void {
    // A stable, persisted host key: regenerating it would make every client
    // warn that the server identity changed after each restart
    this.hostKeys.push(loadOrCreateHostKey());
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = new ssh2.Server({
        hostKeys: this.hostKeys
      }, (client) => {
        logger.debug('SFTP client connected');
        const sessionId = `sftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const ipAddress = (client as any)._sock?.remoteAddress || 'unknown';
        const remotePort = (client as any)._sock?.remotePort || 0;

        let username: string | undefined;
        let authenticatedUser: User | undefined;
        let userPermissions: Permission | undefined;

        client.on('authentication', (ctx) => {
          username = ctx.username;
          const user = this.db.getUser(username);

          if (!user) {
            this.emit('activity', {
              listenerId: this.listener.id!,
              username: username,
              action: `LOGIN_FAILED (User not found) [${ipAddress}:${remotePort}]`,
              path: '/',
              success: false
            });
            return ctx.reject();
          }

          const userListeners = this.db.getUserListeners(user.id!);
          if (!userListeners.includes(this.listener.id!)) {
            this.emit('activity', {
              listenerId: this.listener.id!,
              username: username,
              action: `LOGIN_FAILED (Not authorized for this listener) [${ipAddress}:${remotePort}]`,
              path: '/',
              success: false
            });
            return ctx.reject();
          }

          if (ctx.method === 'password' && user.passwordEnabled) {
            if (this.db.verifyPassword(username, ctx.password)) {
              
              // Track active session
              this.activeSessions.set(sessionId, {
                client,
                username: username,
                ipAddress,
                connectedAt: new Date()
              });
              console.log(`[SESSION] Added active session: ${sessionId} for user ${username} from ${ipAddress}`);
              console.log(`[SESSION] Total active sessions: ${this.activeSessions.size}`);
              
              authenticatedUser = user;
              userPermissions = this.db.getPermission(user.id!, this.listener.id!);
              this.emit('activity', {
                listenerId: this.listener.id!,
                username: username,
                action: `LOGIN (password) [${ipAddress}:${remotePort}]`,
                path: '/',
                success: true
              });
              return ctx.accept();
            } else {
              this.emit('activity', {
                listenerId: this.listener.id!,
                username: username,
                action: `LOGIN_FAILED (Invalid password) [${ipAddress}:${remotePort}]`,
                path: '/',
                success: false
              });
              return ctx.reject();
            }
          } else if (ctx.method === 'publickey' && user.publicKey) {
            // Simple public key verification
            if (ctx.key.algo === 'ssh-rsa' || ctx.key.algo === 'ssh-ed25519') {
              const providedKey = ctx.key.data.toString('base64');
              const storedKey = user.publicKey;
              
              if (providedKey === storedKey || storedKey.includes(providedKey)) {
                if (ctx.signature) {
                  // Track active session
                  this.activeSessions.set(sessionId, {
                    client,
                    username: username,
                    ipAddress,
                    connectedAt: new Date()
                  });
                  console.log(`[SESSION] Added active session: ${sessionId} for user ${username} from ${ipAddress}`);
                  console.log(`[SESSION] Total active sessions: ${this.activeSessions.size}`);
                  
                  authenticatedUser = user;
                  userPermissions = this.db.getPermission(user.id!, this.listener.id!);
                  this.emit('activity', {
                    listenerId: this.listener.id!,
                    username: username,
                    action: `LOGIN (publickey) [${ipAddress}:${remotePort}]`,
                    path: '/',
                    success: true
                  });
                  return ctx.accept();
                } else {
                  return ctx.accept();
                }
              }
            }
          }

          this.emit('activity', {
            listenerId: this.listener.id!,
            username: username,
            action: `LOGIN_FAILED (Invalid public key or auth method) [${ipAddress}:${remotePort}]`,
            path: '/',
            success: false
          });
          ctx.reject();
        });

        client.on('ready', () => {
          logger.info(`SFTP client authenticated: ${username}`);

          // Set up idle timeout for this client
          this.resetIdleTimeout(client, username!);

          client.on('session', (accept) => {
            const session = accept();

            session.on('sftp', (accept) => {
              const sftp = accept();
              const virtualPaths = this.db.getVirtualPaths(authenticatedUser!.id!);

              // File handles opened with write access (checked in OPEN)
              const writableHandles = new Set<number>();
              // Open files: logged as one UPLOAD / DOWNLOAD (with size) when closed
              const openFiles = new Map<number, { path: string; write: boolean; bytes: number; live: TransferHandle }>();

              // Map virtual paths to real paths
              const pathMapper = (virtualPath: string): string => {
                // Normalize path and ensure it starts with /
                let normalizedVPath = virtualPath.replace(/\\/g, '/');
                
                // If path is an absolute Windows or local path, extract just the relative part
                if (normalizedVPath.match(/^[A-Za-z]:/)) {
                  // It's a Windows absolute path - this shouldn't happen normally
                  // Extract everything after the last occurrence of the base path
                  if (virtualPaths.length > 0) {
                    const basePath = virtualPaths[0].localPath.replace(/\\/g, '/');
                    const idx = normalizedVPath.indexOf(basePath);
                    if (idx !== -1) {
                      normalizedVPath = normalizedVPath.substring(idx + basePath.length);
                    }
                  }
                }
                
                // Ensure path starts with /
                if (!normalizedVPath.startsWith('/')) {
                  normalizedVPath = '/' + normalizedVPath;
                }

                // Resolve "." and ".." so clients can never climb above the virtual root
                normalizedVPath = path.posix.normalize(normalizedVPath);
                
                // Find matching virtual path (try longest match first)
                const sortedPaths = [...virtualPaths].sort((a, b) => b.virtualPath.length - a.virtualPath.length);
                
                for (const vp of sortedPaths) {
                  const normalizedVpPath = vp.virtualPath.replace(/\\/g, '/');
                  
                  // Handle exact match or path starting with virtual path
                  if (normalizedVPath === normalizedVpPath || normalizedVPath.startsWith(normalizedVpPath + '/') || normalizedVpPath === '/') {
                    let relativePath = normalizedVPath.substring(normalizedVpPath.length);
                    
                    // Remove leading slash from relative path if virtual path is not root
                    if (normalizedVpPath !== '/' && relativePath.startsWith('/')) {
                      relativePath = relativePath.substring(1);
                    } else if (normalizedVpPath === '/' && relativePath.startsWith('/')) {
                      relativePath = relativePath.substring(1);
                    }
                    
                    let realPath = path.join(vp.localPath, relativePath);

                    // Defence in depth: never resolve outside the virtual path's local root
                    const root = path.resolve(vp.localPath);
                    const resolved = path.resolve(realPath);
                    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
                      realPath = root;
                    }
                    
                    console.log(`Path mapping: ${virtualPath} -> ${normalizedVPath} -> ${realPath}`);
                    
                    // Ensure the directory exists
                    const dirPath = fs.existsSync(realPath) && fs.statSync(realPath).isDirectory() 
                      ? realPath 
                      : path.dirname(realPath);
                    
                    if (!fs.existsSync(dirPath)) {
                      try {
                        fs.mkdirSync(dirPath, { recursive: true });
                        console.log(`Created directory: ${dirPath}`);
                      } catch (err) {
                        console.error('Error creating directory:', err);
                      }
                    }
                    
                    return realPath;
                  }
                }
                
                // Default to first virtual path if available
                if (virtualPaths.length > 0) {
                  const defaultPath = path.join(virtualPaths[0].localPath, normalizedVPath);
                  
                  // Ensure base directory exists
                  if (!fs.existsSync(virtualPaths[0].localPath)) {
                    try {
                      fs.mkdirSync(virtualPaths[0].localPath, { recursive: true });
                      console.log(`Created base directory: ${virtualPaths[0].localPath}`);
                    } catch (err) {
                      console.error('Error creating base directory:', err);
                    }
                  }
                  
                  return defaultPath;
                }
                
                // Fallback
                return virtualPath;
              };

              // Helper to find the matching virtual path for a given path
              const findVirtualPath = (virtualPath: string) => {
                let normalizedVPath = virtualPath.replace(/\\/g, '/');
                if (!normalizedVPath.startsWith('/')) normalizedVPath = '/' + normalizedVPath;
                normalizedVPath = path.posix.normalize(normalizedVPath);
                
                const sortedPaths = [...virtualPaths].sort((a, b) => b.virtualPath.length - a.virtualPath.length);
                for (const vp of sortedPaths) {
                  const normalizedVpPath = vp.virtualPath.replace(/\\/g, '/');
                  if (normalizedVPath === normalizedVpPath || normalizedVPath.startsWith(normalizedVpPath + '/') || normalizedVpPath === '/') {
                    return vp;
                  }
                }
                return virtualPaths.length > 0 ? virtualPaths[0] : null;
              };

              // Check both listener-level and virtual path-level permissions
              const checkPermission = (action: keyof Permission, virtualPath: string = '/'): boolean => {
                console.log(`[PERMISSION CHECK] Action: ${action}, Path: ${virtualPath}`);
                
                // Find the matching virtual path
                const vp = findVirtualPath(virtualPath);
                if (!vp) {
                  console.log(`[PERMISSION CHECK] No virtual path found for: ${virtualPath}`);
                  return false;
                }
                console.log(`[PERMISSION CHECK] Found virtual path: ${vp.virtualPath} -> ${vp.localPath}`);
                
                // Map Permission keys to VirtualPath permission keys
                const vpPermMap: Record<string, keyof typeof vp> = {
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
                if (!vpPermKey) {
                  console.log(`[PERMISSION CHECK] No permission mapping for action: ${action}`);
                  return false;
                }
                
                // Check virtual path permissions first
                const hasVPathPerm = vp[vpPermKey] !== false;
                console.log(`[PERMISSION CHECK] VPath permission ${vpPermKey}: ${hasVPathPerm}`);
                
                // If user has listener-level permissions, check those too (AND condition)
                // If no listener permissions, virtual path permissions alone are sufficient
                if (userPermissions) {
                  const listenerPerm = Boolean(userPermissions[action]);
                  console.log(`[PERMISSION CHECK] Listener permission ${action}: ${listenerPerm}`);
                  const result = listenerPerm && hasVPathPerm;
                  console.log(`[PERMISSION CHECK] Final result (listener AND vpath): ${result}`);
                  return result;
                }
                
                // No listener permissions - rely solely on virtual path permissions
                console.log(`[PERMISSION CHECK] No listener permissions, using vpath only: ${hasVPathPerm}`);
                return hasVPathPerm;
              };

              const logActivity = (action: string, filePath: string, success: boolean, bytes?: number) => {
                this.emit('activity', {
                  listenerId: this.listener.id!,
                  username: username!,
                  action,
                  path: filePath,
                  bytes,
                  success
                });
              };

              // SFTP command handlers
              sftp.on('OPEN', (reqId, filename, flags, attrs) => {
                const realPath = pathMapper(filename);
                console.log(`SFTP OPEN: ${filename} -> ${realPath}`);

                // Check permissions based on flags
                const writeFlag = flags & (SFTP_OPEN_MODE.WRITE | SFTP_OPEN_MODE.APPEND | SFTP_OPEN_MODE.CREAT);
                const readFlag = flags & SFTP_OPEN_MODE.READ;

                const appendOnly = (flags & SFTP_OPEN_MODE.APPEND) && !(flags & SFTP_OPEN_MODE.TRUNC);
                const canWrite = checkPermission('canCreate', filename) || checkPermission('canEdit', filename) ||
                  (appendOnly && checkPermission('canAppend', filename));
                if (writeFlag && !canWrite) {
                  logActivity('OPEN_DENIED', filename, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                // Check canRead for read operations, canList for listing directories
                if (readFlag && !checkPermission('canRead', filename)) {
                  logActivity('OPEN_DENIED', filename, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                try {
                  const openFlags = this.convertSFTPFlags(flags);
                  const handle = fs.openSync(realPath, openFlags);
                  if (writeFlag) {
                    writableHandles.add(handle);
                  }
                  openFiles.set(handle, {
                    path: filename,
                    write: !!writeFlag,
                    bytes: 0,
                    live: this.transfers.start(sessionId, filename, writeFlag ? 'upload' : 'download')
                  });
                  const handleBuffer = Buffer.alloc(4);
                  handleBuffer.writeUInt32BE(handle, 0);
                  logActivity('OPEN', filename, true);
                  sftp.handle(reqId, handleBuffer);
                } catch (err: any) {
                  console.error('SFTP OPEN error:', err);
                  logActivity('OPEN_FAILED', filename, false);
                  
                  // Return appropriate error status codes
                  if (err.code === 'ENOENT') {
                    sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                  } else if (err.code === 'EACCES' || err.code === 'EPERM') {
                    sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                  } else {
                    sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                  }
                }
              });

              sftp.on('READ', (reqId, handle, offset, length) => {
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                const handleNum = handle.readUInt32BE(0);
                try {
                  const buffer = Buffer.alloc(length);
                  const bytesRead = fs.readSync(handleNum, buffer, 0, length, offset);
                  const transfer = openFiles.get(handleNum);
                  if (transfer) {
                    transfer.bytes += bytesRead;
                    transfer.live.add(bytesRead);
                  }
                  if (bytesRead === 0) {
                    sftp.status(reqId, SFTP_STATUS_CODE.EOF);
                  } else {
                    sftp.data(reqId, buffer.slice(0, bytesRead));
                  }
                } catch (err) {
                  console.error('SFTP READ error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('WRITE', (reqId, handle, offset, data) => {
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                // We don't have the filename in WRITE: write permission (listener AND
                // virtual path) was checked in OPEN, which records writable handles
                const handleNum = handle.readUInt32BE(0);
                if (!writableHandles.has(handleNum)) {
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                try {
                  fs.writeSync(handleNum, data, 0, data.length, offset);
                  const transfer = openFiles.get(handleNum);
                  if (transfer) {
                    transfer.bytes += data.length;
                    transfer.live.add(data.length);
                  }
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  console.error('SFTP WRITE error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('CLOSE', (reqId, handle) => {
                // Try to parse as a directory handle first
                const handleStr = handle.toString();
                if (this.dirHandles && this.dirHandles.has(handleStr)) {
                  console.log(`[CLOSE] Closing directory handle: ${handleStr}`);
                  this.dirHandles.delete(handleStr);
                  return sftp.status(reqId, SFTP_STATUS_CODE.OK);
                }
                
                // Otherwise treat as file handle
                const handleNum = handle.readUInt32BE(0);
                writableHandles.delete(handleNum);
                const transfer = openFiles.get(handleNum);
                openFiles.delete(handleNum);
                transfer?.live.end();
                try {
                  fs.closeSync(handleNum);
                  if (transfer) {
                    logActivity(transfer.write ? 'UPLOAD' : 'DOWNLOAD', transfer.path, true, transfer.bytes);
                  }
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  console.error('SFTP CLOSE error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('OPENDIR', (reqId, dirPath) => {
                console.log(`[OPENDIR] Request ${reqId} for path: ${dirPath}`);
                
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                const permResult = checkPermission('canList', dirPath);
                console.log(`[OPENDIR] Permission check result: ${permResult}`);
                
                if (!permResult) {
                  console.log(`[OPENDIR] DENIED - No permission for: ${dirPath}`);
                  logActivity('OPENDIR_DENIED', dirPath, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realPath = pathMapper(dirPath);
                console.log(`[OPENDIR] Mapping: ${dirPath} -> ${realPath}`);

                try {
                  console.log(`[OPENDIR] Reading directory: ${realPath}`);
                  const files = fs.readdirSync(realPath);
                  console.log(`[OPENDIR] Found ${files.length} files`);
                  
                  // Create a unique handle for this directory read operation
                  const handleId = `dir_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                  const handleBuffer = Buffer.from(handleId);
                  
                  // Store the directory listing state
                  if (!this.dirHandles) {
                    this.dirHandles = new Map();
                  }
                  this.dirHandles.set(handleId, { path: realPath, files, sentAll: false, client });
                  
                  console.log(`[OPENDIR] Created handle ${handleId} for ${files.length} files`);
                  
                  logActivity('OPENDIR', dirPath, true);
                  sftp.handle(reqId, handleBuffer);
                  console.log(`[OPENDIR] Handle sent successfully`);
                } catch (err: any) {
                  console.error('[OPENDIR] Error:', err);
                  logActivity('OPENDIR_FAILED', dirPath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                }
              });

              sftp.on('READDIR', (reqId, handle) => {
                console.log(`[READDIR] Request ${reqId}`);
                try {
                  const handleId = handle.toString();
                  console.log(`[READDIR] Handle ID: ${handleId}`);
                  
                  if (!this.dirHandles || !this.dirHandles.has(handleId)) {
                    console.log(`[READDIR] Invalid or expired handle`);
                    return sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                  }
                  
                  const handleData = this.dirHandles.get(handleId)!;
                  const { path: dirPath, files, sentAll } = handleData;
                  console.log(`[READDIR] Path: ${dirPath}, Files: ${files.length}, SentAll: ${sentAll}`);

                  if (sentAll) {
                    console.log(`[READDIR] EOF - all files already sent`);
                    return sftp.status(reqId, SFTP_STATUS_CODE.EOF);
                  }

                  const fileList: any[] = [];
                  console.log(`[READDIR] Processing ${files.length} files`);

                  for (const file of files) {
                    try {
                      const filePath = path.join(dirPath, file);
                      const stats = fs.statSync(filePath);
                      fileList.push({
                        filename: file,
                        longname: this.formatLongname(file, stats),
                        attrs: {
                          mode: stats.mode,
                          uid: stats.uid,
                          gid: stats.gid,
                          size: stats.size,
                          atime: Math.floor(stats.atimeMs / 1000),
                          mtime: Math.floor(stats.mtimeMs / 1000)
                        }
                      });
                    } catch (err) {
                      console.error(`[READDIR] Error stating file ${file}:`, err);
                    }
                  }

                  // Mark as sent so next READDIR returns EOF
                  handleData.sentAll = true;

                  console.log(`[READDIR] Sending ${fileList.length} file entries`);
                  sftp.name(reqId, fileList);
                  console.log(`[READDIR] Response sent`);
                } catch (err) {
                  console.error('[READDIR] Error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('STAT', (reqId, filePath) => {
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                const realPath = pathMapper(filePath);
                try {
                  const stats = fs.statSync(realPath);
                  logActivity('STAT', filePath, true);
                  sftp.attrs(reqId, {
                    mode: stats.mode,
                    uid: stats.uid,
                    gid: stats.gid,
                    size: stats.size,
                    atime: Math.floor(stats.atimeMs / 1000),
                    mtime: Math.floor(stats.mtimeMs / 1000)
                  });
                } catch (err) {
                  logActivity('STAT_FAILED', filePath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                }
              });

              sftp.on('LSTAT', (reqId, filePath) => {
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                const realPath = pathMapper(filePath);
                try {
                  const stats = fs.lstatSync(realPath);
                  logActivity('LSTAT', filePath, true);
                  sftp.attrs(reqId, {
                    mode: stats.mode,
                    uid: stats.uid,
                    gid: stats.gid,
                    size: stats.size,
                    atime: Math.floor(stats.atimeMs / 1000),
                    mtime: Math.floor(stats.mtimeMs / 1000)
                  });
                } catch (err) {
                  logActivity('LSTAT_FAILED', filePath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                }
              });

              sftp.on('REMOVE', (reqId, filePath) => {
                if (!checkPermission('canDelete', filePath)) {
                  logActivity('REMOVE_DENIED', filePath, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realPath = pathMapper(filePath);
                try {
                  fs.unlinkSync(realPath);
                  logActivity('REMOVE', filePath, true);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logActivity('REMOVE_FAILED', filePath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('RMDIR', (reqId, dirPath) => {
                if (!checkPermission('canDelete', dirPath)) {
                  logActivity('RMDIR_DENIED', dirPath, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realPath = pathMapper(dirPath);
                try {
                  fs.rmdirSync(realPath);
                  logActivity('RMDIR', dirPath, true);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logActivity('RMDIR_FAILED', dirPath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('MKDIR', (reqId, dirPath, attrs) => {
                if (!checkPermission('canCreateDir', dirPath)) {
                  logActivity('MKDIR_DENIED', dirPath, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realPath = pathMapper(dirPath);
                try {
                  fs.mkdirSync(realPath, { recursive: true });
                  logActivity('MKDIR', dirPath, true);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logActivity('MKDIR_FAILED', dirPath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('RENAME', (reqId, oldPath, newPath) => {
                if (!checkPermission('canRename', oldPath) || !checkPermission('canRename', newPath)) {
                  logActivity('RENAME_DENIED', `${oldPath} -> ${newPath}`, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realOldPath = pathMapper(oldPath);
                const realNewPath = pathMapper(newPath);
                try {
                  fs.renameSync(realOldPath, realNewPath);
                  logActivity('RENAME', `${oldPath} -> ${newPath}`, true);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logActivity('RENAME_FAILED', `${oldPath} -> ${newPath}`, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('REALPATH', (reqId, filePath) => {
                // REALPATH should return the normalized VIRTUAL path, not the local filesystem path
                // The client will use this path in subsequent operations, so it must remain virtual
                
                // Normalize the virtual path to POSIX format
                let normalizedPath = (filePath || '/').replace(/\\/g, '/');
                
                // Ensure it starts with /
                if (!normalizedPath.startsWith('/')) {
                  normalizedPath = '/' + normalizedPath;
                }
                
                // Resolve any .. or . in the path
                normalizedPath = path.posix.normalize(normalizedPath);
                
                // Verify the path exists by mapping to local and checking
                try {
                  const localPath = pathMapper(normalizedPath);
                  const stats = fs.statSync(localPath);
                  
                  // Return the VIRTUAL path, not the local path
                  sftp.name(reqId, [{
                    filename: normalizedPath,
                    longname: normalizedPath,
                    attrs: {
                      mode: stats.mode,
                      uid: stats.uid,
                      gid: stats.gid,
                      size: stats.size,
                      atime: Math.floor(stats.atimeMs / 1000),
                      mtime: Math.floor(stats.mtimeMs / 1000)
                    }
                  }]);
                } catch (err) {
                  // Path doesn't exist
                  sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                }
              });
            });
          });
        });

        client.on('error', (err) => {
          console.error('SFTP client error:', err);
        });

        client.on('end', () => {
          console.log('[CLIENT] End event - client disconnecting');
          console.log(`[SESSION] Removing session ${sessionId} for user ${username}`);
          console.log(`[SESSION] Sessions before delete: ${this.activeSessions.size}`);
          
          // Remove from active sessions
          this.activeSessions.delete(sessionId);
          this.transfers.endSession(sessionId);
          console.log(`[SESSION] Sessions after delete: ${this.activeSessions.size}`);
          
          // Clear idle timeout for this client
          this.clearIdleTimeout(client);
          
          // Clean up only this client's directory handles
          if (this.dirHandles) {
            let removed = 0;
            for (const [handleId, handleData] of this.dirHandles.entries()) {
              if (handleData.client === client) {
                this.dirHandles.delete(handleId);
                removed += 1;
              }
            }
            if (removed > 0) {
              console.log(`[DISCONNECT] Cleaned up ${removed} directory handles for disconnected client`);
            }
          }
          
          if (username) {
            this.emit('activity', {
              listenerId: this.listener.id!,
              username: username,
              action: 'LOGOUT',
              path: '/',
              success: true
            });
          }
        });

        client.on('close', () => {
          console.log('[CLIENT] Close event - connection closed');
          this.clearIdleTimeout(client);
          this.activeSessions.delete(sessionId);
          this.transfers.endSession(sessionId);
        });
      });

      this.server.listen(this.listener.port, this.listener.bindingIp, () => {
        console.log(`SFTP server listening on ${this.listener.bindingIp}:${this.listener.port}`);
        this.emit('started');
        resolve();
      });

      this.server.on('error', (err: Error) => {
        console.error('SFTP server error:', err);
        this.emit('error', err);
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Clear all idle timeouts
      for (const timeout of this.clientTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.clientTimeouts.clear();
      
      // Clear all active sessions
      this.activeSessions.clear();
      
      if (this.server) {
        this.server.close(() => {
          console.log('SFTP server stopped');
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getActiveSessions(): Array<{ sessionId: string; username: string; ipAddress: string; connectedAt: Date } & SessionTransferStats> {
    console.log(`[SESSION] getActiveSessions called - Total: ${this.activeSessions.size}`);
    const sessions = Array.from(this.activeSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      username: session.username,
      ipAddress: session.ipAddress,
      connectedAt: session.connectedAt,
      ...this.transfers.stats(sessionId)
    }));
    console.log(`[SESSION] Returning sessions:`, sessions);
    return sessions;
  }

  disconnectSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.client.end();
      this.activeSessions.delete(sessionId);
      return true;
    }
    return false;
  }

  private resetIdleTimeout(client: any, username: string): void {
    // Clear existing timeout
    if (this.clientTimeouts.has(client)) {
      clearTimeout(this.clientTimeouts.get(client)!);
    }
    
    // Set new timeout
    const timeout = setTimeout(() => {
      console.log(`[IDLE TIMEOUT] Force disconnecting idle client: ${username}`);
      client.end();
      this.clientTimeouts.delete(client);
    }, this.idleTimeoutMs);
    
    this.clientTimeouts.set(client, timeout);
  }

  private clearIdleTimeout(client: any): void {
    if (this.clientTimeouts.has(client)) {
      clearTimeout(this.clientTimeouts.get(client)!);
      this.clientTimeouts.delete(client);
    }
  }

  private convertSFTPFlags(flags: number): string {
    let nodeFlags = '';
    
    if (flags & SFTP_OPEN_MODE.READ) {
      nodeFlags += 'r';
    }
    if (flags & SFTP_OPEN_MODE.WRITE) {
      nodeFlags += 'w';
    }
    if (flags & SFTP_OPEN_MODE.APPEND) {
      nodeFlags = 'a';
    }
    if (flags & SFTP_OPEN_MODE.CREAT) {
      if (!nodeFlags.includes('w') && !nodeFlags.includes('a')) {
        nodeFlags = 'w';
      }
    }
    
    return nodeFlags || 'r';
  }

  private formatLongname(filename: string, stats: fs.Stats): string {
    const mode = this.formatMode(stats.mode);
    const nlink = 1;
    const uid = stats.uid || 0;
    const gid = stats.gid || 0;
    const size = stats.size;
    const date = stats.mtime.toISOString().substring(0, 10);
    return `${mode} ${nlink} ${uid} ${gid} ${size} ${date} ${filename}`;
  }

  private formatMode(mode: number): string {
    const typeChar = (mode & fs.constants.S_IFDIR) ? 'd' : '-';
    const owner = [
      (mode & fs.constants.S_IRUSR) ? 'r' : '-',
      (mode & fs.constants.S_IWUSR) ? 'w' : '-',
      (mode & fs.constants.S_IXUSR) ? 'x' : '-'
    ].join('');
    const group = [
      (mode & fs.constants.S_IRGRP) ? 'r' : '-',
      (mode & fs.constants.S_IWGRP) ? 'w' : '-',
      (mode & fs.constants.S_IXGRP) ? 'x' : '-'
    ].join('');
    const others = [
      (mode & fs.constants.S_IROTH) ? 'r' : '-',
      (mode & fs.constants.S_IWOTH) ? 'w' : '-',
      (mode & fs.constants.S_IXOTH) ? 'x' : '-'
    ].join('');
    return typeChar + owner + group + others;
  }
}
