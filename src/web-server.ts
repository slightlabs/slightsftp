import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as https from 'https';
import * as WebSocket from 'ws';
import * as path from 'path';
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { User, Listener } from './types';
import logger from './logger';
import { resolveUserPath } from './path-utils';
import { requiresPasswordChange, validateNewPassword } from './password';
import { hostKeyFingerprint } from './tls';
import { registerPortalRoutes } from './portal';

// Get __dirname for CommonJS compatibility
declare const __dirname: string;

interface WebSession {
  username: string;
  loginTime: Date;
  /** set until the user replaces the default / admin-reset password */
  mustChangePassword?: boolean;
}

/** Never send password hashes to a client. */
function withoutPassword(user: User): Omit<User, 'password'> {
  const { password: _hash, ...rest } = user;
  return rest;
}

// API paths a session may use while a password change is still required
const PASSWORD_CHANGE_ALLOWED = new Set(['/change-password', '/user', '/logout']);

export interface WebServerOptions {
  /** serve the GUI over HTTPS with this key / certificate (PEM) */
  tls?: { key: string; cert: string };
}

export class WebServer {
  private app: express.Application;
  private server: http.Server | https.Server;
  private wss: WebSocket.Server;
  private db: DatabaseManager;
  private serverManager: ServerManager;
  private sessions: Map<string, WebSession> = new Map();
  private port: number;
  private tls?: { key: string; cert: string };

  constructor(db: DatabaseManager, serverManager: ServerManager, port: number = 3000, options: WebServerOptions = {}) {
    this.db = db;
    this.serverManager = serverManager;
    this.port = port;
    this.tls = options.tls;
    this.app = express();
    this.server = this.tls
      ? https.createServer({ key: this.tls.key, cert: this.tls.cert }, this.app)
      : http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();

    // Push FTP/SFTP server activity (already persisted by ServerManager) to GUI clients
    if (typeof (serverManager as any)?.on === 'function') {
      serverManager.on('activity', this.onServerActivity);
    }
  }

  private onServerActivity = (activity: any): void => {
    this.broadcast({ type: 'activity', data: { ...activity, timestamp: activity.timestamp || new Date().toISOString() } });
  };

  private broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // Serve static files from src directory (HTML, CSS, JS)
    this.app.use('/assets', express.static(path.join(__dirname, '../assets')));
  }

  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private authenticateSession(req: Request): WebSession | null {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) {
      return null;
    }
    return this.sessions.get(sessionId) || null;
  }

  private requireAuth(req: Request, res: Response, next: NextFunction): void {
    const session = this.authenticateSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (session.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
      res.status(403).json({ error: 'Password change required', requirePasswordChange: true });
      return;
    }
    (req as any).session = session;
    next();
  }

  private logActivity(username: string, action: string, path: string, success: boolean, listenerId?: number): void {
    const activity = {
      listenerId: listenerId || 0,
      username,
      action,
      path,
      success,
      timestamp: new Date().toISOString()
    };
    this.db.logActivity(activity);
    this.broadcast({ type: 'activity', data: activity });
  }

  private setupRoutes(): void {
    // Serve renderer.js
    this.app.get('/renderer.js', (req: Request, res: Response) => {
      const rendererPath = path.join(__dirname, 'renderer.js');
      let rendererJs = fs.readFileSync(rendererPath, 'utf-8');
      
      // Remove require('electron') statements for browser compatibility
      rendererJs = rendererJs.replace(/const\s*{\s*ipcRenderer\s*}\s*=\s*require\('electron'\);?\s*/g, '');
      rendererJs = rendererJs.replace(/const\s+\w+\s*=\s*require\('electron'\);?\s*/g, '');
      
      res.type('application/javascript');
      res.send(rendererJs);
    });

    // Login page
    this.app.get('/login', (req: Request, res: Response) => {
      let loginHtml = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf-8');
      
      // Remove the require('electron') line and replace ipcRenderer usage
      loginHtml = loginHtml.replace(/const\s*{\s*ipcRenderer\s*}\s*=\s*require\('electron'\);?\s*/g, '');
      
      // Replace window.close() calls
      loginHtml = loginHtml.replace(/window\.close\(\);?/g, 'window.location.href = \'/\';');
      
      res.send(this.injectWebAPI(loginHtml, false));
    });

    // Main GUI page
    this.app.get('/', (req: Request, res: Response) => {
      const session = this.authenticateSession(req);
      if (!session || session.mustChangePassword) {
        res.redirect('/login');
        return;
      }
      
      const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.send(this.injectWebAPI(indexHtml, true));
    });

    // End-user file portal (separate sessions; never reaches the admin API)
    this.app.get('/files', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'portal.html'));
    });
    registerPortalRoutes(this.app, this.db, {
      logActivity: (username, action, filePath, success) => this.logActivity(username, action, filePath, success),
      secureCookies: () => this.isHttps(),
    });

    // Authentication endpoints
    this.app.post('/api/login', async (req: Request, res: Response) => {
      const { username, password } = req.body;
      
      logger.info('Login attempt:', { username, hasPassword: !!password });
      
      try {
        const user = this.db.getUser(username);
        logger.info('User found:', { username, exists: !!user, guiEnabled: user?.guiEnabled });
        
        if (!user) {
          this.logActivity(username, 'WEB_LOGIN_FAILED', 'User not found', false);
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        // Check if user has GUI access
        if (!user.guiEnabled) {
          this.logActivity(username, 'WEB_LOGIN_FAILED', 'GUI access not enabled', false);
          res.status(403).json({ error: 'GUI access not enabled for this user' });
          return;
        }

        // Verify password
        if (!password || !this.db.checkPassword(username, password)) {
          this.logActivity(username, 'WEB_LOGIN_FAILED', 'Invalid credentials', false);
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        // Create session
        const sessionId = this.generateSessionId();
        const mustChangePassword = requiresPasswordChange(user, password);
        this.sessions.set(sessionId, {
          username: user.username,
          loginTime: new Date(),
          mustChangePassword
        });

        res.cookie('sessionId', sessionId, {
          httpOnly: true,
          secure: this.isHttps(),
          sameSite: 'lax',
          maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        this.logActivity(username, 'WEB_LOGIN_SUCCESS', 'User logged in via web interface', true);
        logger.info('Login successful for user:', username);
        res.json(mustChangePassword
          ? { success: true, username: user.username, requirePasswordChange: true }
          : { success: true, username: user.username });
      } catch (error: any) {
        logger.error('Login error:', error);
        this.logActivity(username || 'unknown', 'WEB_LOGIN_ERROR', error.message, false);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.post('/api/logout', (req: Request, res: Response) => {
      const sessionId = req.cookies.sessionId;
      const session = this.authenticateSession(req);
      if (sessionId) {
        if (session) {
          this.logActivity(session.username, 'WEB_LOGOUT', 'User logged out from web interface', true);
        }
        this.sessions.delete(sessionId);
      }
      res.clearCookie('sessionId');
      res.json({ success: true });
    });

    // API endpoints (all require authentication)
    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => this.requireAuth(req, res, next));

    // Change the signed-in user's password. While a change is forced the current
    // password was just verified at login; otherwise it must be supplied.
    this.app.post('/api/change-password', (req: Request, res: Response) => {
      const session = (req as any).session as WebSession;
      const { newPassword, currentPassword } = req.body || {};

      if (!session.mustChangePassword && !this.db.checkPassword(session.username, currentPassword || '')) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
      }
      const problem = validateNewPassword(newPassword);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      if (this.db.checkPassword(session.username, newPassword)) {
        res.status(400).json({ error: 'The new password must be different from the current one' });
        return;
      }

      this.db.updateUser(session.username, { password: newPassword, mustChangePassword: false });
      session.mustChangePassword = false;
      this.logActivity(session.username, 'WEB_PASSWORD_CHANGED', 'Password changed via web interface', true);
      res.json({ success: true });
    });

    this.app.get('/api/server-identity', (req: Request, res: Response) => {
      res.json({ sshHostKeyFingerprint: hostKeyFingerprint() });
    });

    // Get authenticated user
    this.app.get('/api/user', (req: Request, res: Response) => {
      const session = (req as any).session as WebSession;
      const user = this.db.getUser(session.username);
      res.json({ username: user?.username });
    });

    // Listeners
    this.app.get('/api/listeners', (req: Request, res: Response) => {
      const listeners = this.db.getAllListeners();
      res.json(listeners);
    });

    this.app.post('/api/listeners', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const { name, protocol, bindingIp, port, enabled, tlsMode } = req.body;
        const listener: Listener = {
          name,
          protocol,
          bindingIp,
          port,
          enabled,
          tlsMode
        };
        const id = this.db.createListener(listener);
        
        this.logActivity(session.username, 'WEB_LISTENER_CREATED', `Created ${protocol} listener '${name}' on ${bindingIp}:${port}`, true, id);
        
        if (enabled) {
          await this.serverManager.startListener(id);
        }
        
        res.json({ ...listener, id });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_CREATE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.put('/api/listeners/:id', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const id = parseInt(req.params.id);
        const { name, bindingIp, port, enabled, tlsMode } = req.body;
        
        const listener = this.db.getListener(id);
        if (!listener) {
          res.status(404).json({ error: 'Listener not found' });
          return;
        }

        this.db.updateListener(id, { name, bindingIp, port, enabled, tlsMode });
        this.logActivity(session.username, 'WEB_LISTENER_UPDATED', `Updated listener '${listener.name}'`, true, id);
        
        // Restart listener if running
        if (this.serverManager.isListenerRunning(id)) {
          await this.serverManager.restartListener(id);
        } else if (enabled) {
          await this.serverManager.startListener(id);
        }
        
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_UPDATE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.delete('/api/listeners/:id', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const id = parseInt(req.params.id);
        const listener = this.db.getListener(id);
        
        if (this.serverManager.isListenerRunning(id)) {
          await this.serverManager.stopListener(id);
        }
        
        this.db.deleteListener(id);
        this.logActivity(session.username, 'WEB_LISTENER_DELETED', `Deleted listener '${listener?.name}'`, true, id);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_DELETE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/listeners/:id/start', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const id = parseInt(req.params.id);
        const listener = this.db.getListener(id);
        await this.serverManager.startListener(id);
        this.logActivity(session.username, 'WEB_LISTENER_STARTED', `Started listener '${listener?.name}'`, true, id);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_START_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/listeners/:id/stop', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const id = parseInt(req.params.id);
        const listener = this.db.getListener(id);
        await this.serverManager.stopListener(id);
        this.logActivity(session.username, 'WEB_LISTENER_STOPPED', `Stopped listener '${listener?.name}'`, true, id);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_STOP_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.post('/api/listeners/:id/restart', async (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const id = parseInt(req.params.id);
        const listener = this.db.getListener(id);
        await this.serverManager.restartListener(id);
        this.logActivity(session.username, 'WEB_LISTENER_RESTARTED', `Restarted listener '${listener?.name}'`, true, id);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_LISTENER_RESTART_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    // Get listener statuses
    this.app.get('/api/listener-statuses', (req: Request, res: Response) => {
      const listeners = this.db.getAllListeners();
      const statuses = listeners.map(listener => ({
        listener: listener,
        running: this.serverManager.isListenerRunning(listener.id!)
      }));
      
      // Add Web GUI Server as a special listener
      statuses.push({
        listener: {
          id: -1,
          name: 'Web GUI Server',
          protocol: this.isHttps() ? 'HTTPS' : 'HTTP',
          port: this.port,
          bindingIp: '0.0.0.0',
          enabled: true,
          maxConnections: 100
        },
        running: true
      });
      
      res.json(statuses);
    });

    // Get specific listener
    this.app.get('/api/listeners/:id', (req: Request, res: Response) => {
      const id = parseInt(req.params.id);
      const listener = this.db.getListener(id);
      if (!listener) {
        res.status(404).json({ error: 'Listener not found' });
        return;
      }
      res.json(listener);
    });

    // Users
    this.app.get('/api/users', (req: Request, res: Response) => {
      res.json(this.db.getAllUsers().map(withoutPassword));
    });

    this.app.get('/api/users/:username', (req: Request, res: Response) => {
      const username = req.params.username;
      const user = this.db.getUser(username);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json(withoutPassword(user));
    });

    this.app.get('/api/users/id/:userId/listeners', (req: Request, res: Response) => {
      const userId = parseInt(req.params.userId);
      const listenerIds = this.db.getUserListeners(userId);
      res.json(listenerIds);
    });

    this.app.post('/api/users', (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const { username, password, passwordEnabled, publicKey, guiEnabled, mustChangePassword, portalEnabled } = req.body;

        // DatabaseManager.createUser hashes the password itself
        const user: User = {
          username,
          password: password || '',
          passwordEnabled,
          publicKey: publicKey || '',
          guiEnabled,
          mustChangePassword: !!mustChangePassword,
          portalEnabled: !!portalEnabled
        };
        
        const id = this.db.createUser(user);
        this.logActivity(session.username, 'WEB_USER_CREATED', `Created user '${username}'`, true);
        
        const { password: _omit, ...safeUser } = user;
        res.json({ ...safeUser, id });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_USER_CREATE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.put('/api/users/:username', (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const username = req.params.username;
        const { password, passwordEnabled, publicKey, guiEnabled, mustChangePassword, portalEnabled, listeners, virtualPaths, permissions } = req.body;

        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        
        const updates: any = { passwordEnabled, publicKey, guiEnabled, mustChangePassword, portalEnabled };
        if (password) {
          // DatabaseManager.updateUser hashes the password itself
          updates.password = password;
        }
        
        this.db.updateUser(username, updates);

        // Optional: full access replacement, as sent by the GUI "Edit User" dialog
        if (Array.isArray(listeners) && Array.isArray(virtualPaths)) {
          this.db.replaceUserAccess(user.id, listeners, virtualPaths, Array.isArray(permissions) ? permissions : []);
        }
        this.logActivity(session.username, 'WEB_USER_UPDATED', `Updated user '${username}'`, true);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_USER_UPDATE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    this.app.delete('/api/users/:username', (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const username = req.params.username;
        this.db.deleteUser(username);
        this.logActivity(session.username, 'WEB_USER_DELETED', `Deleted user '${username}'`, true);
        res.json({ success: true });
      } catch (error: any) {
        const session = (req as any).session as WebSession;
        this.logActivity(session.username, 'WEB_USER_DELETE_FAILED', error.message, false);
        res.status(400).json({ error: error.message });
      }
    });

    // User subscriptions
    this.app.get('/api/users/:username/subscriptions', (req: Request, res: Response) => {
      const username = req.params.username;
      const user = this.db.getUser(username);
      if (!user || !user.id) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const listenerIds = this.db.getUserListeners(user.id);
      res.json(listenerIds);
    });

    this.app.post('/api/users/:username/subscriptions', (req: Request, res: Response) => {
      try {
        const username = req.params.username;
        const { listenerId } = req.body;
        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        this.db.subscribeUserToListener(user.id, listenerId);
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.delete('/api/users/:username/subscriptions/:listenerId', (req: Request, res: Response) => {
      try {
        const username = req.params.username;
        const listenerId = parseInt(req.params.listenerId);
        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        this.db.unsubscribeUserFromListener(user.id, listenerId);
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Virtual paths
    this.app.get('/api/users/:username/virtual-paths', (req: Request, res: Response) => {
      const username = req.params.username;
      const user = this.db.getUser(username);
      if (!user || !user.id) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const virtualPaths = this.db.getVirtualPaths(user.id);
      res.json(virtualPaths);
    });

    this.app.post('/api/users/:username/virtual-paths', (req: Request, res: Response) => {
      try {
        const username = req.params.username;
        const virtualPath = req.body;
        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
        virtualPath.userId = user.id;
        this.db.addVirtualPath(virtualPath);
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.delete('/api/users/:username/virtual-paths/:id', (req: Request, res: Response) => {
      try {
        const id = parseInt(req.params.id);
        this.db.deleteVirtualPath(id);
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // Activity logs
    this.app.get('/api/activity', (req: Request, res: Response) => {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const activities = this.db.getRecentActivities(undefined, limit);
      res.json(activities);
    });

    this.app.delete('/api/activity', (req: Request, res: Response) => {
      try {
        const { beforeDate } = req.body || {};
        const count = beforeDate
          ? this.db.clearActivitiesByDate(beforeDate)
          : this.db.clearAllActivities();
        res.json({ success: true, count });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    this.app.get('/api/activity/count', (req: Request, res: Response) => {
      res.json({ count: this.db.getActivityCount() });
    });

    this.app.get('/api/activity/old-stats', (req: Request, res: Response) => {
      const settings = this.db.getAllSettings();
      const retentionDays = parseInt((req.query.retentionDays as string) || settings.logRetentionDays || '30');
      res.json({ count: this.db.getOldLogsStats(retentionDays) });
    });

    this.app.post('/api/activity/cleanup', (req: Request, res: Response) => {
      res.json({ success: true, count: this.db.cleanupOldActivities() });
    });

    // Settings
    this.app.get('/api/settings', (req: Request, res: Response) => {
      res.json(this.db.getAllSettings());
    });

    this.app.get('/api/settings/:key', (req: Request, res: Response) => {
      res.json({ key: req.params.key, value: this.db.getSetting(req.params.key) ?? null });
    });

    this.app.put('/api/settings/:key', (req: Request, res: Response) => {
      const session = (req as any).session as WebSession;
      const value = req.body?.value;
      if (value === undefined || value === null) {
        res.status(400).json({ error: 'value is required' });
        return;
      }
      this.db.setSetting(req.params.key, String(value));
      this.logActivity(session.username, 'WEB_SETTING_UPDATED', `${req.params.key}=${value}`, true);
      res.json({ success: true });
    });

    // Lookups by user id (used by the GUI "Edit User" dialog)
    this.app.get('/api/users/id/:userId/virtual-paths', (req: Request, res: Response) => {
      res.json(this.db.getVirtualPaths(parseInt(req.params.userId)));
    });

    this.app.get('/api/users/id/:userId/permissions/:listenerId', (req: Request, res: Response) => {
      const permission = this.db.getPermission(parseInt(req.params.userId), parseInt(req.params.listenerId));
      res.json(permission ?? null);
    });

    // Active sessions
    this.app.get('/api/sessions', (req: Request, res: Response) => {
      const sessions = this.serverManager.getActiveSessions();
      res.json(sessions);
    });

    this.app.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
      try {
        const sessionId = req.params.sessionId;
        const success = this.serverManager.disconnectSession(sessionId);
        if (!success) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
    });

    // File browsing
    this.app.get('/api/files/browse', (req: Request, res: Response) => {
      try {
        const username = req.query.username as string;
        const virtualPath = req.query.path as string || '/';
        
        if (!username) {
          res.status(400).json({ error: 'Username is required' });
          return;
        }

        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        const resolved = resolveUserPath(this.db.getVirtualPaths(user.id), virtualPath);
        if (!resolved) {
          logger.warn(`File browse denied for ${username}: ${virtualPath}`);
          res.status(403).json({ error: 'No access to this path' });
          return;
        }
        const localPath = resolved.localPath;

        // Check if path exists and list files
        if (!fs.existsSync(localPath)) {
          res.status(404).json({ error: 'Path not found' });
          return;
        }

        const stat = fs.statSync(localPath);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: 'Path is not a directory' });
          return;
        }

        const files = fs.readdirSync(localPath).map((name: string) => {
          const filePath = path.join(localPath, name);
          const fileStat = fs.statSync(filePath);
          return {
            name,
            type: fileStat.isDirectory() ? 'directory' : 'file',
            size: fileStat.size,
            modified: fileStat.mtime
          };
        });

        res.json({ files, currentPath: virtualPath });
      } catch (error: any) {
        logger.error('File browse error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/files/download', (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const username = req.query.username as string;
        const filePath = req.query.path as string;
        if (!username || !filePath) {
          res.status(400).json({ error: 'username and path are required' });
          return;
        }

        const user = this.db.getUser(username);
        if (!user || !user.id) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        const resolved = resolveUserPath(this.db.getVirtualPaths(user.id), filePath);
        if (!resolved) {
          res.status(403).json({ error: 'No access to this path' });
          return;
        }
        if (!fs.existsSync(resolved.localPath)) {
          res.status(404).json({ error: 'File not found' });
          return;
        }
        if (fs.statSync(resolved.localPath).isDirectory()) {
          res.status(400).json({ error: 'Path is a directory' });
          return;
        }

        this.logActivity(session.username, 'WEB_FILE_DOWNLOAD', `${username}:${filePath}`, true);
        res.download(resolved.localPath, path.basename(resolved.localPath));
      } catch (error: any) {
        logger.error('File download error:', error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  private setupWebSocket(): void {
    // The WebSocket server re-emits HTTP server errors (e.g. EADDRINUSE); without a
    // listener that would crash the process instead of rejecting start()
    this.wss.on('error', (error) => logger.error('WebSocket server error:', error));

    this.wss.on('connection', (ws: WebSocket) => {
      logger.info('WebSocket client connected');

      // Forward activity events to connected clients
      const activityHandler = (activity: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'activity', data: activity }));
        }
      };

      const listenerStartedHandler = (listenerId: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'listener-started', data: listenerId }));
        }
      };

      const listenerStoppedHandler = (listenerId: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'listener-stopped', data: listenerId }));
        }
      };

      (this.serverManager as any).on('activity', activityHandler);
      (this.serverManager as any).on('listener-started', listenerStartedHandler);
      (this.serverManager as any).on('listener-stopped', listenerStoppedHandler);

      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
        (this.serverManager as any).off('activity', activityHandler);
        (this.serverManager as any).off('listener-started', listenerStartedHandler);
        (this.serverManager as any).off('listener-stopped', listenerStoppedHandler);
      });

      ws.on('error', (error: any) => {
        logger.error('WebSocket error:', error);
      });
    });
  }

  private injectWebAPI(html: string, includeRenderer: boolean): string {
    // Inject web API compatibility layer
    const webAPIScript = `
    <script>
      // Web API compatibility layer for Electron IPC
      async function api(method, url, body) {
        const response = await fetch(url, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: 'same-origin'
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error((data && data.error) || \`Request failed: \${method} \${url}\`);
        return data;
      }

      window.ipcRenderer = {
        async invoke(channel, ...args) {
          // Map Electron IPC channels to web API endpoints
          const channelMap = {
            'authenticate-user': async (username, password) => {
              const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
                credentials: 'same-origin'
              });
              if (!response.ok) {
                const error = await response.json();
                return { success: false, error: error.error || 'Login failed' };
              }
              const result = await response.json();
              // Don't redirect here - return success and let the login page handle it
              return { success: true, ...result };
            },
            'login': async (data) => {
              const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Login failed');
              }
              return response.json();
            },
            'logout': async () => {
              const response = await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              if (!response.ok) throw new Error('Logout failed');
              const result = await response.json();
              // Electron closes the window on logout; in a browser go back to the login page
              window.location.href = '/login';
              return result;
            },
            'set-first-login-password': async (newPassword) => {
              const response = await fetch('/api/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword }),
                credentials: 'same-origin'
              });
              const result = await response.json().catch(() => ({}));
              return response.ok ? { success: true } : { success: false, error: result.error || 'Password change failed' };
            },
            'get-authenticated-user': async () => {
              const response = await fetch('/api/user');
              if (!response.ok) throw new Error('Failed to get user');
              return response.json();
            },
            'get-listeners': async () => {
              const response = await fetch('/api/listeners');
              if (!response.ok) throw new Error('Failed to get listeners');
              return response.json();
            },
            'create-listener': async (data) => {
              const response = await fetch('/api/listeners', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to create listener');
              }
              return response.json();
            },
            'update-listener': async (idOrData, updates) => {
              // Electron signature is (id, updates); also accept a single object with an id
              const id = typeof idOrData === 'object' ? idOrData.id : idOrData;
              const body = typeof idOrData === 'object' ? idOrData : updates;
              const response = await fetch(\`/api/listeners/\${id}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to update listener');
              }
              return response.json();
            },
            'delete-listener': async (id) => {
              const response = await fetch(\`/api/listeners/\${id}\`, {
                method: 'DELETE'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to delete listener');
              }
              return response.json();
            },
            'start-listener': async (id) => {
              const response = await fetch(\`/api/listeners/\${id}/start\`, {
                method: 'POST'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to start listener');
              }
              return response.json();
            },
            'stop-listener': async (id) => {
              const response = await fetch(\`/api/listeners/\${id}/stop\`, {
                method: 'POST'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to stop listener');
              }
              return response.json();
            },
            'restart-listener': async (id) => {
              const response = await fetch(\`/api/listeners/\${id}/restart\`, {
                method: 'POST'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to restart listener');
              }
              return response.json();
            },
            'get-users': async () => {
              const response = await fetch('/api/users');
              if (!response.ok) throw new Error('Failed to get users');
              return response.json();
            },
            'create-user': async (data) => {
              const response = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to create user');
              }
              return response.json();
            },
            'update-user': async (usernameOrData, updates, listeners, virtualPaths, permissions) => {
              // Electron signature is (username, updates, listeners, virtualPaths, permissions)
              const isObject = typeof usernameOrData === 'object';
              const username = isObject ? usernameOrData.username : usernameOrData;
              const body = isObject ? usernameOrData : { ...updates, listeners, virtualPaths, permissions };
              const response = await fetch(\`/api/users/\${encodeURIComponent(username)}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to update user');
              }
              return response.json();
            },
            'delete-user': async (username) => {
              const response = await fetch(\`/api/users/\${username}\`, {
                method: 'DELETE'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to delete user');
              }
              return response.json();
            },
            'get-user-subscriptions': async (username) => {
              const response = await fetch(\`/api/users/\${username}/subscriptions\`);
              if (!response.ok) throw new Error('Failed to get subscriptions');
              return response.json();
            },
            'subscribe-user': async (data) => {
              const response = await fetch(\`/api/users/\${data.username}/subscriptions\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listenerId: data.listenerId })
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to subscribe user');
              }
              return response.json();
            },
            'unsubscribe-user': async (data) => {
              const response = await fetch(\`/api/users/\${data.username}/subscriptions/\${data.listenerId}\`, {
                method: 'DELETE'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to unsubscribe user');
              }
              return response.json();
            },
            'get-user-virtual-paths': async (username) => {
              const response = await fetch(\`/api/users/\${username}/virtual-paths\`);
              if (!response.ok) throw new Error('Failed to get virtual paths');
              return response.json();
            },
            'add-virtual-path': async (data) => {
              const response = await fetch(\`/api/users/\${data.username}/virtual-paths\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data.virtualPath)
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to add virtual path');
              }
              return response.json();
            },
            'remove-virtual-path': async (data) => {
              const response = await fetch(\`/api/users/\${data.username}/virtual-paths/\${data.index}\`, {
                method: 'DELETE'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to remove virtual path');
              }
              return response.json();
            },
            'get-activities': async (limit) => {
              const url = limit ? \`/api/activity?limit=\${limit}\` : '/api/activity';
              const response = await fetch(url);
              if (!response.ok) throw new Error('Failed to get activities');
              return response.json();
            },
            'clear-activities': async (beforeDate) => {
              const response = await fetch('/api/activity', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ beforeDate })
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to clear activities');
              }
              return response.json();
            },
            'get-active-sessions': async () => {
              const response = await fetch('/api/sessions');
              if (!response.ok) throw new Error('Failed to get sessions');
              return response.json();
            },
            'disconnect-session': async (sessionId) => {
              const response = await fetch(\`/api/sessions/\${sessionId}\`, {
                method: 'DELETE'
              });
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to disconnect session');
              }
              return response.json();
            },
            'get-all-listener-statuses': async () => {
              const response = await fetch('/api/listener-statuses');
              if (!response.ok) throw new Error('Failed to get listener statuses');
              return response.json();
            },
            'get-recent-activities': async (listenerId, limit) => {
              const params = new URLSearchParams();
              if (limit) params.append('limit', limit.toString());
              const url = '/api/activity' + (params.toString() ? '?' + params.toString() : '');
              const response = await fetch(url);
              if (!response.ok) throw new Error('Failed to get activities');
              return response.json();
            },
            'get-all-users': async () => {
              const response = await fetch('/api/users');
              if (!response.ok) throw new Error('Failed to get users');
              return response.json();
            },
            'get-all-listeners': async () => {
              const response = await fetch('/api/listeners');
              if (!response.ok) throw new Error('Failed to get listeners');
              return response.json();
            },
            'get-listener': async (id) => {
              const response = await fetch(\`/api/listeners/\${id}\`);
              if (!response.ok) throw new Error('Failed to get listener');
              return response.json();
            },
            'get-user': async (username) => {
              const response = await fetch(\`/api/users/\${username}\`);
              if (!response.ok) throw new Error('Failed to get user');
              return response.json();
            },
            'get-user-listeners': async (userId) => {
              const response = await fetch(\`/api/users/id/\${userId}/listeners\`);
              if (!response.ok) throw new Error('Failed to get user listeners');
              return response.json();
            },
            'get-web-server-status': async () => {
              // In web mode, the server is always running
              return { running: true, port: window.location.port || 3000, https: window.location.protocol === 'https:' };
            },
            'start-web-server': async () => {
              // Already running in web mode
              return { success: true, message: 'Already running' };
            },
            'stop-web-server': async () => {
              // Can't stop from web interface
              return { success: false, error: 'Cannot stop web server from web interface' };
            },
            'browse-files': async (username, path) => {
              const response = await fetch(\`/api/files/browse?username=\${encodeURIComponent(username)}&path=\${encodeURIComponent(path)}\`);
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to browse files');
              }
              return response.json();
            },
            'download-file': async (username, filePath) => {
              const url = \`/api/files/download?username=\${encodeURIComponent(username)}&path=\${encodeURIComponent(filePath)}\`;
              const response = await fetch(url, { method: 'HEAD' });
              if (!response.ok) throw new Error('Failed to download file');
              const link = document.createElement('a');
              link.href = url;
              link.download = filePath.split('/').pop();
              document.body.appendChild(link);
              link.click();
              link.remove();
              return { success: true, savedPath: 'your browser downloads folder' };
            },
            'get-server-identity': () => api('GET', '/api/server-identity'),
            'get-virtual-paths': (userId) => api('GET', \`/api/users/id/\${userId}/virtual-paths\`),
            'get-permission': (userId, listenerId) => api('GET', \`/api/users/id/\${userId}/permissions/\${listenerId}\`),
            'get-listener-status': async (id) => {
              const statuses = await api('GET', '/api/listener-statuses');
              const status = statuses.find(s => s.listener.id === id);
              return { running: !!(status && status.running), listener: status && status.listener };
            },
            'get-activity-count': async () => (await api('GET', '/api/activity/count')).count,
            'clear-all-activities': () => api('DELETE', '/api/activity', {}),
            'clear-activities-by-date': (beforeDate) => api('DELETE', '/api/activity', { beforeDate }),
            'get-old-logs-stats': (retentionDays) => api('GET', \`/api/activity/old-stats?retentionDays=\${encodeURIComponent(retentionDays)}\`),
            'cleanup-old-activities': () => api('POST', '/api/activity/cleanup'),
            'get-all-settings': () => api('GET', '/api/settings'),
            'get-setting': async (key) => (await api('GET', \`/api/settings/\${encodeURIComponent(key)}\`)).value,
            'set-setting': (key, value) => api('PUT', \`/api/settings/\${encodeURIComponent(key)}\`, { value }),
            'save-activity-log': async (csvContent) => {
              const blob = new Blob([csvContent], { type: 'text/csv' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = \`activity-log-\${new Date().toISOString().split('T')[0]}.csv\`;
              document.body.appendChild(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(link.href), 1000);
              return { success: true };
            },
            'select-directory': async () => {
              // No native folder picker in a browser: ask for a server-side path instead
              const value = window.prompt('Enter the server-side folder path:');
              return value ? value.trim() : null;
            }
          };
          
          if (channelMap[channel]) {
            return channelMap[channel](...args);
          }
          
          throw new Error(\`Unknown IPC channel: \${channel}\`);
        },
        
        on(channel, callback) {
          // WebSocket connection for real-time events
          if (!window.wsConnection) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            window.wsConnection = new WebSocket(protocol + '//' + window.location.host);
            
            window.wsConnection.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (window.wsHandlers && window.wsHandlers[message.type]) {
                window.wsHandlers[message.type].forEach(handler => handler(null, message.data));
              }
            };
            
            window.wsConnection.onerror = (error) => {
              console.error('WebSocket error:', error);
            };
            
            window.wsConnection.onclose = () => {
              console.log('WebSocket connection closed');
              // Attempt to reconnect after 5 seconds
              setTimeout(() => {
                window.wsConnection = null;
                if (window.wsHandlers) {
                  // Re-register handlers
                  Object.keys(window.wsHandlers).forEach(ch => {
                    window.ipcRenderer.on(ch, window.wsHandlers[ch][0]);
                  });
                }
              }, 5000);
            };
          }
          
          if (!window.wsHandlers) {
            window.wsHandlers = {};
          }
          if (!window.wsHandlers[channel]) {
            window.wsHandlers[channel] = [];
          }
          window.wsHandlers[channel].push(callback);
        }
      };
      
      // Mock dialog for web - browser dialogs don't need electron
      if (typeof window.electron === 'undefined') {
        window.electron = {
          dialog: {
            showOpenDialog: async (options) => {
              alert('File browser not available in web version. Please type the path manually.');
              return { canceled: true, filePaths: [] };
            }
          }
        };
      }
    </script>
    `;

    // Replace renderer.js script tag if needed
    if (includeRenderer) {
      html = html.replace('<script src="renderer.js"></script>', 
        webAPIScript + '<script src="/renderer.js"></script>');
    } else {
      html = html.replace('</head>', webAPIScript + '</head>');
    }

    return html;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        logger.error(`Web GUI server failed to start on port ${this.port}:`, err);
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, () => {
        this.server.off('error', onError);
        logger.info(`🌐 Web GUI server started on ${this.getUrl()}`);
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  isHttps(): boolean {
    return !!this.tls;
  }

  getUrl(host = 'localhost'): string {
    return `${this.isHttps() ? 'https' : 'http'}://${host}:${this.port}`;
  }

  getApp(): express.Application {
    return this.app;
  }

  async stop(): Promise<void> {
    if (typeof (this.serverManager as any)?.off === 'function') {
      this.serverManager.off('activity', this.onServerActivity);
    }
    for (const client of this.wss.clients) {
      client.terminate();
    }
    return new Promise((resolve, reject) => {
      this.wss.close(() => {
        this.server.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            logger.info('Web GUI server stopped');
            resolve();
          }
        });
      });
    });
  }
}
