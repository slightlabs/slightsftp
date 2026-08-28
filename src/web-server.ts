import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { User, Listener } from './types';
import logger from './logger';

// Get __dirname for CommonJS compatibility
declare const __dirname: string;

interface WebSession {
  username: string;
  loginTime: Date;
}

export class WebServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocket.Server;
  private db: DatabaseManager;
  private serverManager: ServerManager;
  private sessions: Map<string, WebSession> = new Map();
  private port: number;

  constructor(db: DatabaseManager, serverManager: ServerManager, port: number = 3000) {
    this.db = db;
    this.serverManager = serverManager;
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
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

  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
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
    
    // Broadcast activity to all connected WebSocket clients
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'activity', data: activity }));
      }
    });
  }

  private setupRoutes(): void {
    // Serve renderer.js
    this.app.get('/renderer.js', (req: Request, res: Response) => {
      const rendererPath = path.join(__dirname, 'renderer.js');
      let rendererJs = fs.readFileSync(rendererPath, 'utf-8');
      
      // Remove Electron IPC bootstrap line (replaced by window.ipcRenderer mock below)
      rendererJs = rendererJs.replace(/const ipcRenderer = window\.api \|\| window\.ipcRenderer;?\s*/g, '');
      
      res.type('application/javascript');
      res.send(rendererJs);
    });

    // Login page
    this.app.get('/login', (req: Request, res: Response) => {
      let loginHtml = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf-8');
      
      // Remove Electron IPC bootstrap line from login.html
      loginHtml = loginHtml.replace(/const ipcRenderer = window\.api \|\| window\.ipcRenderer;?\s*/g, '');
      
      // Replace window.close() calls
      loginHtml = loginHtml.replace(/window\.close\(\);?/g, 'window.location.href = \'/\';');
      
      res.send(this.injectWebAPI(loginHtml, false));
    });

    // Main GUI page
    this.app.get('/', (req: Request, res: Response) => {
      const session = this.authenticateSession(req);
      if (!session) {
        res.redirect('/login');
        return;
      }
      
      const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.send(this.injectWebAPI(indexHtml, true));
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
        if (!user.password || !password) {
          logger.info('Password check failed:', { hasUserPassword: !!user.password, hasProvidedPassword: !!password });
          this.logActivity(username, 'WEB_LOGIN_FAILED', 'Invalid credentials', false);
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }
        
        const hashedPassword = this.hashPassword(password);
        logger.info('Password hash comparison:', { 
          provided: hashedPassword,
          stored: user.password,
          match: user.password === hashedPassword
        });
        
        if (user.password !== hashedPassword) {
          this.logActivity(username, 'WEB_LOGIN_FAILED', 'Invalid password', false);
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        // Create session
        const sessionId = this.generateSessionId();
        this.sessions.set(sessionId, {
          username: user.username,
          loginTime: new Date()
        });

        res.cookie('sessionId', sessionId, {
          httpOnly: true,
          secure: false, // Set to true in production with HTTPS
          maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        this.logActivity(username, 'WEB_LOGIN_SUCCESS', 'User logged in via web interface', true);
        logger.info('Login successful for user:', username);
        res.json({ success: true, username: user.username });
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
        const { name, protocol, bindingIp, port, enabled } = req.body;
        const listener: Listener = {
          name,
          protocol,
          bindingIp,
          port,
          enabled
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
        const { name, bindingIp, port, enabled } = req.body;
        
        const listener = this.db.getListener(id);
        if (!listener) {
          res.status(404).json({ error: 'Listener not found' });
          return;
        }

        this.db.updateListener(id, { name, bindingIp, port, enabled });
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
          protocol: 'HTTP',
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
      const users = this.db.getAllUsers();
      res.json(users);
    });

    this.app.get('/api/users/:username', (req: Request, res: Response) => {
      const username = req.params.username;
      const user = this.db.getUser(username);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json(user);
    });

    this.app.get('/api/users/id/:userId/listeners', (req: Request, res: Response) => {
      const userId = parseInt(req.params.userId);
      const listenerIds = this.db.getUserListeners(userId);
      res.json(listenerIds);
    });

    this.app.post('/api/users', (req: Request, res: Response) => {
      try {
        const session = (req as any).session as WebSession;
        const { username, password, passwordEnabled, publicKey, guiEnabled } = req.body;
        const hashedPassword = password ? this.hashPassword(password) : '';
        
        const user: User = {
          username,
          password: hashedPassword,
          passwordEnabled,
          publicKey: publicKey || '',
          guiEnabled
        };
        
        const id = this.db.createUser(user);
        this.logActivity(session.username, 'WEB_USER_CREATED', `Created user '${username}'`, true);
        
        res.json({ ...user, id });
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
        const { password, passwordEnabled, publicKey, guiEnabled } = req.body;
        
        const updates: any = { passwordEnabled, publicKey, guiEnabled };
        if (password) {
          updates.password = this.hashPassword(password);
        }
        
        this.db.updateUser(username, updates);
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
        const { beforeDate } = req.body;
        if (beforeDate) {
          this.db.clearActivitiesByDate(beforeDate);
        } else {
          this.db.clearAllActivities();
        }
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error.message });
      }
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

        const virtualPaths = this.db.getVirtualPaths(user.id);
        
        // Find matching virtual path - need to match from root
        const matchingVPath = virtualPaths.find(vp => {
          // Normalize paths for comparison
          const vpNorm = vp.virtualPath.endsWith('/') ? vp.virtualPath : vp.virtualPath + '/';
          const pathNorm = virtualPath.endsWith('/') ? virtualPath : virtualPath + '/';
          
          // Match if exact or if virtual path is a prefix
          return virtualPath === vp.virtualPath || 
                 pathNorm.startsWith(vpNorm) ||
                 (vp.virtualPath === '/' && virtualPath.startsWith('/'));
        });

        if (!matchingVPath) {
          logger.error(`No matching virtual path for ${username} accessing ${virtualPath}. Available paths:`, virtualPaths.map(vp => vp.virtualPath));
          res.status(403).json({ error: 'No access to this path' });
          return;
        }

        // Map virtual path to local path
        const relativePath = virtualPath.substring(matchingVPath.virtualPath.length);
        const localPath = path.join(matchingVPath.localPath, relativePath);

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
  }

  private setupWebSocket(): void {
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
              return response.json();
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
            'update-listener': async (data) => {
              const response = await fetch(\`/api/listeners/\${data.id}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
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
            'update-user': async (data) => {
              const response = await fetch(\`/api/users/\${data.username}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
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
              return { running: true, port: window.location.port || 3000 };
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
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.info(`🌐 Web GUI server started on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
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
