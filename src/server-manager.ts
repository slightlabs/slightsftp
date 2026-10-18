import { EventEmitter } from 'events';
import { LiveTransfer } from './transfers';
import { DatabaseManager } from './database';
import { SFTPServer } from './sftp-server';
import { FTPServer } from './ftp-server';
import { Listener, ServerActivity } from './types';
import logger from './logger';

export interface ActiveSession {
  sessionId: string;
  listenerId: number;
  listenerName: string;
  protocol: string;
  username: string;
  ipAddress: string;
  connectedAt: Date;
  /** live transfer statistics (bytes moved, transfers in progress) */
  uploadedBytes?: number;
  downloadedBytes?: number;
  transfers?: LiveTransfer[];
}

export class ServerManager extends EventEmitter {
  private db: DatabaseManager;
  private servers: Map<number, SFTPServer | FTPServer> = new Map();

  constructor(db: DatabaseManager) {
    super();
    this.db = db;
  }

  async startListener(listenerId: number): Promise<void> {
    const listener = this.db.getListener(listenerId);
    if (!listener) {
      throw new Error(`Listener ${listenerId} not found`);
    }

    if (!listener.enabled) {
      throw new Error(`Listener ${listenerId} is disabled`);
    }

    if (this.servers.has(listenerId)) {
      throw new Error(`Listener ${listenerId} is already running`);
    }

    let server: SFTPServer | FTPServer;

    if (listener.protocol === 'SFTP') {
      server = new SFTPServer(listener, this.db);
    } else if (listener.protocol === 'FTP') {
      server = new FTPServer(listener, this.db);
    } else {
      throw new Error(`Unknown protocol: ${listener.protocol}`);
    }

    // Forward activity events
    server.on('activity', (activity: ServerActivity) => {
      this.db.logActivity(activity);
      this.emit('activity', activity);
    });

    server.on('started', () => {
      this.db.logActivity({
        listenerId: listenerId,
        username: 'system',
        action: 'SERVER_STARTED',
        path: `${listener.protocol} server on ${listener.bindingIp}:${listener.port}`,
        success: true
      });
      this.emit('listener-started', listenerId);
    });

    server.on('stopped', () => {
      this.db.logActivity({
        listenerId: listenerId,
        username: 'system',
        action: 'SERVER_STOPPED',
        path: `${listener.protocol} server`,
        success: true
      });
      this.servers.delete(listenerId);
      this.emit('listener-stopped', listenerId);
    });

    server.on('error', (err) => {
      this.emit('listener-error', listenerId, err);
    });

    await server.start();
    this.servers.set(listenerId, server);
  }

  async stopListener(listenerId: number): Promise<void> {
    const server = this.servers.get(listenerId);
    if (!server) {
      throw new Error(`Listener ${listenerId} is not running`);
    }

    await server.stop();
    this.servers.delete(listenerId);
  }

  async restartListener(listenerId: number): Promise<void> {
    if (this.servers.has(listenerId)) {
      await this.stopListener(listenerId);
    }
    await this.startListener(listenerId);
  }

  isListenerRunning(listenerId: number): boolean {
    return this.servers.has(listenerId);
  }

  getRunningListeners(): number[] {
    return Array.from(this.servers.keys());
  }

  async startAllEnabledListeners(): Promise<void> {
    const listeners = this.db.getAllListeners();
    const enabledListeners = listeners.filter(l => l.enabled);

    for (const listener of enabledListeners) {
      try {
        await this.startListener(listener.id!);
        logger.info(`Started listener: ${listener.name}`);
      } catch (err) {
        logger.error(`Failed to start listener ${listener.name}:`, err);
      }
    }
  }

  async stopAllListeners(): Promise<void> {
    const listenerIds = Array.from(this.servers.keys());
    
    for (const listenerId of listenerIds) {
      try {
        await this.stopListener(listenerId);
        logger.info(`Stopped listener: ${listenerId}`);
      } catch (err) {
        logger.error(`Failed to stop listener ${listenerId}:`, err);
      }
    }
  }

  getListenerStatus(listenerId: number): { running: boolean; listener?: Listener } {
    const listener = this.db.getListener(listenerId);
    return {
      running: this.servers.has(listenerId),
      listener
    };
  }

  getAllListenerStatuses(): Array<{ listener: Listener; running: boolean }> {
    const listeners = this.db.getAllListeners();
    return listeners.map(listener => ({
      listener,
      running: this.servers.has(listener.id!)
    }));
  }

  getActiveSessions(): ActiveSession[] {
    const sessions: ActiveSession[] = [];
    
    for (const [listenerId, server] of this.servers.entries()) {
      const listener = this.db.getListener(listenerId);
      if (!listener) continue;
      
      const serverSessions = server.getActiveSessions();
      sessions.push(...serverSessions.map(s => ({
        ...s,
        listenerId,
        listenerName: listener.name,
        protocol: listener.protocol
      })));
    }
    
    return sessions;
  }

  disconnectSession(sessionId: string): boolean {
    for (const server of this.servers.values()) {
      if (server.disconnectSession(sessionId)) {
        return true;
      }
    }
    return false;
  }
}
