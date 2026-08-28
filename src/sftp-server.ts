import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { Listener, User, Permission } from './types';
import { EventEmitter } from 'events';import logger from './logger';
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
  private idleTimeoutMs: number = 300000; // 5 minutes default
  private clientTimeouts: Map<any, NodeJS.Timeout> = new Map();
  private activeSessions: Map<string, ClientSession> = new Map();

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
    // Generate RSA host key
    const { generateKeyPairSync } = require('crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      }
    });
    this.hostKeys.push(Buffer.from(privateKey));
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

        // Per-connection directory handles — isolated so one client's disconnect
        // never clears another client's active directory listings
        const dirHandles = new Map<string, { path: string; files: string[]; sentAll: boolean }>();

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
              logger.debug(`[SESSION] Added active session: ${sessionId} for user ${username} from ${ipAddress}`);
              logger.debug(`[SESSION] Total active sessions: ${this.activeSessions.size}`);
              
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
                  logger.debug(`[SESSION] Added active session: ${sessionId} for user ${username} from ${ipAddress}`);
                  logger.debug(`[SESSION] Total active sessions: ${this.activeSessions.size}`);
                  
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
                    
                    const realPath = path.join(vp.localPath, relativePath);
                    
                    logger.debug(`Path mapping: ${virtualPath} -> ${normalizedVPath} -> ${realPath}`);
                    
                    // Ensure the directory exists
                    const dirPath = fs.existsSync(realPath) && fs.statSync(realPath).isDirectory() 
                      ? realPath 
                      : path.dirname(realPath);
                    
                    if (!fs.existsSync(dirPath)) {
                      try {
                        fs.mkdirSync(dirPath, { recursive: true });
                        logger.debug(`Created directory: ${dirPath}`);
                      } catch (err) {
                        logger.error('Error creating directory:', err);
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
                      logger.debug(`Created base directory: ${virtualPaths[0].localPath}`);
                    } catch (err) {
                      logger.error('Error creating base directory:', err);
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
                logger.debug(`[PERMISSION CHECK] Action: ${action}, Path: ${virtualPath}`);
                
                // Find the matching virtual path
                const vp = findVirtualPath(virtualPath);
                if (!vp) {
                  logger.debug(`[PERMISSION CHECK] No virtual path found for: ${virtualPath}`);
                  return false;
                }
                logger.debug(`[PERMISSION CHECK] Found virtual path: ${vp.virtualPath} -> ${vp.localPath}`);
                
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
                  logger.debug(`[PERMISSION CHECK] No permission mapping for action: ${action}`);
                  return false;
                }
                
                // Check virtual path permissions first
                const hasVPathPerm = vp[vpPermKey] !== false;
                logger.debug(`[PERMISSION CHECK] VPath permission ${vpPermKey}: ${hasVPathPerm}`);
                
                // If user has listener-level permissions, check those too (AND condition)
                // If no listener permissions, virtual path permissions alone are sufficient
                if (userPermissions) {
                  const listenerPerm = Boolean(userPermissions[action]);
                  logger.debug(`[PERMISSION CHECK] Listener permission ${action}: ${listenerPerm}`);
                  const result = listenerPerm && hasVPathPerm;
                  logger.debug(`[PERMISSION CHECK] Final result (listener AND vpath): ${result}`);
                  return result;
                }
                
                // No listener permissions - rely solely on virtual path permissions
                logger.debug(`[PERMISSION CHECK] No listener permissions, using vpath only: ${hasVPathPerm}`);
                return hasVPathPerm;
              };

              const logActivity = (action: string, filePath: string, success: boolean) => {
                this.emit('activity', {
                  listenerId: this.listener.id!,
                  username: username!,
                  action,
                  path: filePath,
                  success
                });
              };

              // SFTP command handlers
              sftp.on('OPEN', (reqId, filename, flags, attrs) => {
                const realPath = pathMapper(filename);
                logger.debug(`SFTP OPEN: ${filename} -> ${realPath}`);

                // Check permissions based on flags
                const writeFlag = flags & (SFTP_OPEN_MODE.WRITE | SFTP_OPEN_MODE.APPEND | SFTP_OPEN_MODE.CREAT);
                const readFlag = flags & SFTP_OPEN_MODE.READ;

                if (writeFlag && !checkPermission('canCreate', filename) && !checkPermission('canEdit', filename)) {
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
                  const handleBuffer = Buffer.alloc(4);
                  handleBuffer.writeUInt32BE(handle, 0);
                  logActivity('OPEN', filename, true);
                  sftp.handle(reqId, handleBuffer);
                } catch (err: any) {
                  logger.error('SFTP OPEN error:', err);
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
                  if (bytesRead === 0) {
                    sftp.status(reqId, SFTP_STATUS_CODE.EOF);
                  } else {
                    sftp.data(reqId, buffer.slice(0, bytesRead));
                  }
                } catch (err) {
                  logger.error('SFTP READ error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('WRITE', (reqId, handle, offset, data) => {
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                // We don't have the filename in WRITE, so we skip path-level check here
                // Permissions were already checked in OPEN
                if (!userPermissions || (!userPermissions.canCreate && !userPermissions.canEdit && !userPermissions.canAppend)) {
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const handleNum = handle.readUInt32BE(0);
                try {
                  fs.writeSync(handleNum, data, 0, data.length, offset);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logger.error('SFTP WRITE error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('CLOSE', (reqId, handle) => {
                // Try to parse as a directory handle first
                const handleStr = handle.toString();
                if (dirHandles.has(handleStr)) {
                  logger.debug(`[CLOSE] Closing directory handle: ${handleStr}`);
                  dirHandles.delete(handleStr);
                  return sftp.status(reqId, SFTP_STATUS_CODE.OK);
                }
                
                // Otherwise treat as file handle
                const handleNum = handle.readUInt32BE(0);
                try {
                  fs.closeSync(handleNum);
                  sftp.status(reqId, SFTP_STATUS_CODE.OK);
                } catch (err) {
                  logger.error('SFTP CLOSE error:', err);
                  sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                }
              });

              sftp.on('OPENDIR', (reqId, dirPath) => {
                logger.debug(`[OPENDIR] Request ${reqId} for path: ${dirPath}`);
                
                // Reset idle timeout on activity
                this.resetIdleTimeout(client, username!);
                
                const permResult = checkPermission('canList', dirPath);
                logger.debug(`[OPENDIR] Permission check result: ${permResult}`);
                
                if (!permResult) {
                  logger.debug(`[OPENDIR] DENIED - No permission for: ${dirPath}`);
                  logActivity('OPENDIR_DENIED', dirPath, false);
                  return sftp.status(reqId, SFTP_STATUS_CODE.PERMISSION_DENIED);
                }

                const realPath = pathMapper(dirPath);
                logger.debug(`[OPENDIR] Mapping: ${dirPath} -> ${realPath}`);

                try {
                  logger.debug(`[OPENDIR] Reading directory: ${realPath}`);
                  const files = fs.readdirSync(realPath);
                  logger.debug(`[OPENDIR] Found ${files.length} files`);
                  
                  // Create a unique handle for this directory read operation
                  const handleId = `dir_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                  const handleBuffer = Buffer.from(handleId);
                  
                  // Store the directory listing state
                  dirHandles.set(handleId, { path: realPath, files, sentAll: false });
                  
                  logger.debug(`[OPENDIR] Created handle ${handleId} for ${files.length} files`);
                  
                  logActivity('OPENDIR', dirPath, true);
                  sftp.handle(reqId, handleBuffer);
                  logger.debug(`[OPENDIR] Handle sent successfully`);
                } catch (err: any) {
                  logger.error('[OPENDIR] Error:', err);
                  logActivity('OPENDIR_FAILED', dirPath, false);
                  sftp.status(reqId, SFTP_STATUS_CODE.NO_SUCH_FILE);
                }
              });

              sftp.on('READDIR', (reqId, handle) => {
                logger.debug(`[READDIR] Request ${reqId}`);
                try {
                  const handleId = handle.toString();
                  logger.debug(`[READDIR] Handle ID: ${handleId}`);
                  
                  if (!dirHandles.has(handleId)) {
                    logger.debug(`[READDIR] Invalid or expired handle`);
                    return sftp.status(reqId, SFTP_STATUS_CODE.FAILURE);
                  }
                  
                  const handleData = dirHandles.get(handleId)!;
                  const { path: dirPath, files, sentAll } = handleData;
                  logger.debug(`[READDIR] Path: ${dirPath}, Files: ${files.length}, SentAll: ${sentAll}`);

                  if (sentAll) {
                    logger.debug(`[READDIR] EOF - all files already sent`);
                    return sftp.status(reqId, SFTP_STATUS_CODE.EOF);
                  }

                  const fileList: any[] = [];
                  logger.debug(`[READDIR] Processing ${files.length} files`);

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
                      logger.error(`[READDIR] Error stating file ${file}:`, err);
                    }
                  }

                  // Mark as sent so next READDIR returns EOF
                  handleData.sentAll = true;

                  logger.debug(`[READDIR] Sending ${fileList.length} file entries`);
                  sftp.name(reqId, fileList);
                  logger.debug(`[READDIR] Response sent`);
                } catch (err) {
                  logger.error('[READDIR] Error:', err);
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
                this.resetIdleTimeout(client, username!);
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
                this.resetIdleTimeout(client, username!);
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
                this.resetIdleTimeout(client, username!);
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
                this.resetIdleTimeout(client, username!);
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
                this.resetIdleTimeout(client, username!);
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
          logger.error('SFTP client error:', err);
        });

        client.on('end', () => {
          logger.debug('[CLIENT] End event - client disconnecting');
          logger.debug(`[SESSION] Removing session ${sessionId} for user ${username}`);
          logger.debug(`[SESSION] Sessions before delete: ${this.activeSessions.size}`);
          
          // Remove from active sessions
          this.activeSessions.delete(sessionId);
          logger.debug(`[SESSION] Sessions after delete: ${this.activeSessions.size}`);
          
          // Clear idle timeout for this client
          this.clearIdleTimeout(client);
          
          // Clean up all directory handles for this client
          const handleCount = dirHandles.size;
          if (handleCount > 0) {
              logger.debug(`[DISCONNECT] Cleaning up ${handleCount} directory handles`);
              dirHandles.clear();
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
          this.clearIdleTimeout(client);
        });
      });

      this.server.listen(this.listener.port, this.listener.bindingIp, () => {
        logger.debug(`SFTP server listening on ${this.listener.bindingIp}:${this.listener.port}`);
        this.emit('started');
        resolve();
      });

      this.server.on('error', (err: Error) => {
        logger.error('SFTP server error:', err);
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
          logger.debug('SFTP server stopped');
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getActiveSessions(): Array<{ sessionId: string; username: string; ipAddress: string; connectedAt: Date }> {
    logger.debug(`[SESSION] getActiveSessions called - Total: ${this.activeSessions.size}`);
    const sessions = Array.from(this.activeSessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      username: session.username,
      ipAddress: session.ipAddress,
      connectedAt: session.connectedAt
    }));
    logger.debug(`[SESSION] Returning sessions:`, sessions);
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
      logger.debug(`[IDLE TIMEOUT] Force disconnecting idle client: ${username}`);
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
