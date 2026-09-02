import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { WebServer } from './web-server';
import * as crypto from 'crypto';
import logger from './logger';

let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: DatabaseManager;
let serverManager: ServerManager;
let webServer: WebServer | null = null;
let isQuitting = false;
let isLoggingOut = false;
let authenticatedUser: any = null;

// Get application directories
function getAppDirectories() {
  const isPackaged = app.isPackaged;
  
  if (isPackaged) {
    // Production: Use installation directory structure
    const installPath = path.dirname(app.getPath('exe'));
    
    return {
      config: path.join(installPath, 'config'),
      data: path.join(installPath, 'data'),
      logs: path.join(installPath, 'logs'),
      ftpRoot: path.join(installPath, 'data', 'ftp-root')
    };
  } else {
    // Development: Use current working directory
    return {
      config: process.cwd(),
      data: process.cwd(),
      logs: process.cwd(),
      ftpRoot: path.join(process.cwd(), 'ftp-root')
    };
  }
}

// Ensure directories exist
function ensureDirectories() {
  const dirs = getAppDirectories();
  
  for (const [key, dir] of Object.entries(dirs)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  }
}

function createLoginWindow(): void {
  loginWindow = new BrowserWindow({
    width: 450,
    height: 550,
    resizable: false,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, '../assets/icon.png')
  });

  loginWindow.loadFile(path.join(__dirname, 'login.html'));

  loginWindow.on('close', (event) => {
    // Don't close the window if we're not quitting, just hide it
    if (!isQuitting) {
      event.preventDefault();
      loginWindow?.hide();
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, '../assets/icon.png')
  });

  // Create application menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Minimize to Tray',
          click: () => {
            mainWindow?.hide();
          }
        },
        {
          type: 'separator'
        },
        {
          label: 'Quit',
          accelerator: 'Ctrl+Q',
          click: async () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            const iconPath = path.join(__dirname, '../assets/icon.png');
            let icon: Electron.NativeImage | undefined;
            
            if (fs.existsSync(iconPath)) {
              icon = nativeImage.createFromPath(iconPath);
              // Resize icon to 128x128 for larger display
              icon = icon.resize({ width: 128, height: 128 });
            }
            
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About SLightSFTP',
              message: 'SLightSFTP Server Manager',
              detail: 'Version 1.0.0\nMulti-user FTP/SFTP server with GUI management',
              icon: icon
            });
          }
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', async (event) => {
    // If logging out, allow the window to close without hiding
    if (isLoggingOut) {
      return;
    }
    
    if (!isQuitting) {
      event.preventDefault();
      // Always minimize to tray
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // Load application icon for tray
  let icon: Electron.NativeImage;
  const iconPath = path.join(__dirname, '../assets/icon.png');
  
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    // Resize for tray (16x16 or 32x32 depending on DPI)
    icon = icon.resize({ width: 16, height: 16 });
  } else {
    // Fallback to empty icon if file doesn't exist
    console.warn('Tray icon not found at:', iconPath);
    icon = nativeImage.createEmpty();
  }
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Login',
      click: () => {
        if (loginWindow) {
          loginWindow.show();
        } else {
          createLoginWindow();
        }
      }
    },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      },
      enabled: false // Will be enabled after login
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('SLightSFTP Server');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (authenticatedUser && mainWindow) {
      mainWindow.show();
    } else if (loginWindow) {
      loginWindow.show();
    }
  });
}

function updateTrayMenu(): void {
  if (!tray) return;
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Login',
      click: () => {
        if (loginWindow) {
          loginWindow.show();
        } else {
          createLoginWindow();
        }
      },
      visible: !authenticatedUser
    },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      },
      enabled: !!authenticatedUser
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
}

async function initializeDatabase(): Promise<void> {
  const dirs = getAppDirectories();
  const dbPath = path.join(dirs.config, 'config.db');
  
  db = new DatabaseManager(dbPath);
  await db.init();
  
  // Check if admin user exists, if not create it
  const adminUser = db.getUser('admin');
  if (!adminUser) {
    logger.info('Creating default admin user...');
    const userId = db.createUser({
      username: 'admin',
      password: 'admin123',
      passwordEnabled: true,
      guiEnabled: true
    });
    
    // Create default SFTP listener
    const sftpListenerId = db.createListener({
      name: 'Default SFTP',
      protocol: 'SFTP',
      bindingIp: '0.0.0.0',
      port: 22,
      enabled: true
    });
    
    // Create default FTP listener
    const ftpListenerId = db.createListener({
      name: 'Default FTP',
      protocol: 'FTP',
      bindingIp: '0.0.0.0',
      port: 21,
      enabled: true
    });
    
    // Subscribe admin to both listeners
    db.subscribeUserToListener(userId, sftpListenerId);
    db.subscribeUserToListener(userId, ftpListenerId);
    
    // Set full permissions
    db.setPermission({
      userId,
      listenerId: sftpListenerId,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true
    });
    
    db.setPermission({
      userId,
      listenerId: ftpListenerId,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true
    });
    
    // Add a default virtual path with full permissions
    const dirs = getAppDirectories();
    db.addVirtualPath({
      userId,
      virtualPath: '/',
      localPath: dirs.ftpRoot,
      canRead: true,
      canWrite: true,
      canAppend: true,
      canDelete: true,
      canList: true,
      canCreateDir: true,
      canRename: true
    });

    logger.info('Default configuration created');
  }
}

function setupServerManager(): void {
  serverManager = new ServerManager(db);
  
  serverManager.on('activity', (activity) => {
    // Forward activity to renderer
    if (mainWindow) {
      mainWindow.webContents.send('activity-update', activity);
    }
  });
  
  serverManager.on('listener-started', (listenerId) => {
    logger.info(`Listener ${listenerId} started`);
  });
  
  serverManager.on('listener-stopped', (listenerId) => {
    logger.info(`Listener ${listenerId} stopped`);
  });
  
  serverManager.on('listener-error', (listenerId, error) => {
    console.error(`Listener ${listenerId} error:`, error);
  });
  
  // Start all enabled listeners
  serverManager.startAllEnabledListeners();
}

function setupIpcHandlers(): void {
  // Authentication handler
  ipcMain.handle('authenticate-user', async (event, username, password) => {
    try {
      const user = db.getUser(username);
      
      // Return generic error for all failure cases (security best practice)
      if (!user || !user.guiEnabled) {
        return { success: false, error: 'Invalid username or password' };
      }

      // Hash the provided password
      const hashedPassword = crypto
        .createHash('sha256')
        .update(password)
        .digest('hex');

      if (user.password !== hashedPassword) {
        return { success: false, error: 'Invalid username or password' };
      }

      // Authentication successful
      authenticatedUser = user;
      logger.info('Authentication successful! User:', { username: authenticatedUser.username });
      
      // Update tray menu to enable dashboard option
      updateTrayMenu();
      
      // Log successful login
      db.logActivity({
        listenerId: null,
        username: user.username,
        action: 'GUI_LOGIN',
        path: '/',
        success: true
      });
      
      // Close login window and open main window
      if (loginWindow) {
        loginWindow.close();
        loginWindow = null;
      }
      
      logger.info('Creating main window...');
      createWindow();
      createTray();
      
      return { success: true, user: { username: user.username, id: user.id } };
    } catch (error) {
      logger.error('Authentication error:', error);
      return { success: false, error: 'An error occurred during authentication' };
    }
  });

  // Get authenticated user info
  ipcMain.handle('get-authenticated-user', async () => {
    logger.debug('IPC: get-authenticated-user called');
    logger.debug('authenticatedUser:', authenticatedUser);
    const result = authenticatedUser ? { 
      username: authenticatedUser.username, 
      id: authenticatedUser.id 
    } : null;
    logger.debug('Returning:', result);
    return result;
  });

  // Logout handler
  ipcMain.handle('logout', async () => {
    const logoutUsername = authenticatedUser?.username || 'unknown';
    
    // Log logout activity
    db.logActivity({
      listenerId: null,
      username: logoutUsername,
      action: 'GUI_LOGOUT',
      path: '/',
      success: true
    });
    
    authenticatedUser = null;
    isLoggingOut = true;
    
    // Update tray menu to disable dashboard option
    updateTrayMenu();
    
    // Close main window
    if (mainWindow) {
      mainWindow.close();
      mainWindow = null;
    }
    
    // Reset logout flag
    isLoggingOut = false;
    
    // Show login window again
    createLoginWindow();
    
    return { success: true };
  });

  // User operations
  ipcMain.handle('create-user', async (event, user) => {
    const userId = db.createUser(user);
    
    // Log user creation
    db.logActivity({
      listenerId: null,
      username: authenticatedUser?.username || 'system',
      action: 'USER_CREATED',
      path: `/users/${user.username}`,
      success: true
    });
    
    return userId;
  });
  
  ipcMain.handle('get-user', async (event, username) => {
    return db.getUser(username);
  });
  
  ipcMain.handle('get-all-users', async () => {
    return db.getAllUsers();
  });
  
  ipcMain.handle('update-user', async (event, username, updates, listeners, virtualPaths, permissions) => {
    const user = db.getUser(username);
    if (!user) throw new Error('User not found');
    
    // Update user
    db.updateUser(username, updates);
    
    // Update listener subscriptions
    const currentListeners = db.getUserListeners(user.id!);
    
    // Unsubscribe from removed listeners
    for (const listenerId of currentListeners) {
      if (!listeners.includes(listenerId)) {
        db.unsubscribeUserFromListener(user.id!, listenerId);
      }
    }
    
    // Subscribe to new listeners
    for (const listenerId of listeners) {
      if (!currentListeners.includes(listenerId)) {
        db.subscribeUserToListener(user.id!, listenerId);
      }
    }
    
    // Update permissions
    if (permissions && permissions.length > 0) {
      for (const perm of permissions) {
        db.setPermission(perm);
      }
    }
    
    // Update virtual paths
    const currentPaths = db.getVirtualPaths(user.id!);
    for (const vp of currentPaths) {
      db.deleteVirtualPath(vp.id!);
    }
    for (const vp of virtualPaths) {
      db.addVirtualPath({
        userId: user.id!,
        virtualPath: vp.virtualPath,
        localPath: vp.localPath,
        canRead: vp.canRead,
        canWrite: vp.canWrite,
        canAppend: vp.canAppend,
        canDelete: vp.canDelete,
        canList: vp.canList,
        canCreateDir: vp.canCreateDir,
        canRename: vp.canRename,
        applyToSubdirs: vp.applyToSubdirs
      });
    }
    
    // Log user update
    db.logActivity({
      listenerId: null,
      username: authenticatedUser?.username || 'system',
      action: 'USER_UPDATED',
      path: `/users/${username}`,
      success: true
    });
  });
  
  ipcMain.handle('delete-user', async (event, username) => {
    db.deleteUser(username);
    
    // Log user deletion
    db.logActivity({
      listenerId: null,
      username: authenticatedUser?.username || 'system',
      action: 'USER_DELETED',
      path: `/users/${username}`,
      success: true
    });
  });
  
  ipcMain.handle('get-user-listeners', async (event, userId) => {
    return db.getUserListeners(userId);
  });
  
  ipcMain.handle('get-virtual-paths', async (event, userId) => {
    return db.getVirtualPaths(userId);
  });
  
  ipcMain.handle('get-permission', async (event, userId, listenerId) => {
    return db.getPermission(userId, listenerId);
  });
  
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  
  // Listener operations
  ipcMain.handle('create-listener', async (event, listener) => {
    const listenerId = db.createListener(listener);
    
    // Log listener creation
    db.logActivity({
      listenerId: listenerId,
      username: authenticatedUser?.username || 'system',
      action: 'LISTENER_CREATED',
      path: `/listeners/${listener.name}`,
      success: true
    });
    
    return listenerId;
  });
  
  ipcMain.handle('get-listener', async (event, id) => {
    return db.getListener(id);
  });
  
  ipcMain.handle('get-all-listeners', async () => {
    return db.getAllListeners();
  });
  
  ipcMain.handle('update-listener', async (event, id, updates) => {
    db.updateListener(id, updates);
    
    const listener = db.getListener(id);
    
    // Log listener update
    db.logActivity({
      listenerId: id,
      username: authenticatedUser?.username || 'system',
      action: 'LISTENER_UPDATED',
      path: `/listeners/${listener?.name || id}`,
      success: true
    });
  });
  
  ipcMain.handle('delete-listener', async (event, id) => {
    const listener = db.getListener(id);
    
    if (serverManager.isListenerRunning(id)) {
      await serverManager.stopListener(id);
    }
    db.deleteListener(id);
    
    // Log listener deletion
    db.logActivity({
      listenerId: id,
      username: authenticatedUser?.username || 'system',
      action: 'LISTENER_DELETED',
      path: `/listeners/${listener?.name || id}`,
      success: true
    });
  });
  
  // Server management
  ipcMain.handle('start-listener', async (event, id) => {
    await serverManager.startListener(id);
    
    const listener = db.getListener(id);
    
    // Log listener start
    db.logActivity({
      listenerId: id,
      username: authenticatedUser?.username || 'system',
      action: 'LISTENER_STARTED',
      path: `/listeners/${listener?.name || id}`,
      success: true
    });
  });
  
  ipcMain.handle('stop-listener', async (event, id) => {
    await serverManager.stopListener(id);
    
    const listener = db.getListener(id);
    
    // Log listener stop
    db.logActivity({
      listenerId: id,
      username: authenticatedUser?.username || 'system',
      action: 'LISTENER_STOPPED',
      path: `/listeners/${listener?.name || id}`,
      success: true
    });
  });
  
  ipcMain.handle('get-listener-status', async (event, id) => {
    return serverManager.getListenerStatus(id);
  });
  
  ipcMain.handle('get-all-listener-statuses', async () => {
    const statuses = serverManager.getAllListenerStatuses();
    
    // Always add Web GUI Server to the list
    statuses.push({
      listener: {
        id: -1,
        name: 'Web GUI Server',
        protocol: 'HTTP' as any,
        port: webServer ? (webServer as any).port : parseInt(process.env.WEB_PORT || '3000'),
        bindingIp: '0.0.0.0',
        enabled: true,
        maxConnections: 100
      },
      running: webServer !== null
    });
    
    return statuses;
  });
  
  // Active sessions
  ipcMain.handle('get-active-sessions', async () => {
    return serverManager.getActiveSessions();
  });

  ipcMain.handle('disconnect-session', async (event, sessionId) => {
    const result = serverManager.disconnectSession(sessionId);
    
    // Log session disconnect
    db.logActivity({
      listenerId: null,
      username: authenticatedUser?.username || 'system',
      action: 'SESSION_DISCONNECTED',
      path: `/sessions/${sessionId}`,
      success: result
    });
    
    return result;
  });
  
  // Activity log
  ipcMain.handle('get-recent-activities', async (event, listenerId, limit) => {
    return db.getRecentActivities(listenerId, limit);
  });

  ipcMain.handle('get-activity-count', async () => {
    return db.getActivityCount();
  });

  ipcMain.handle('clear-activities-by-date', async (event, beforeDate) => {
    const count = db.clearActivitiesByDate(beforeDate);
    return { count };
  });

  ipcMain.handle('clear-all-activities', async () => {
    const count = db.clearAllActivities();
    return { count };
  });

  ipcMain.handle('cleanup-old-activities', async () => {
    const count = db.cleanupOldActivities();
    return { count };
  });

  ipcMain.handle('get-old-logs-stats', async (event, retentionDays) => {
    const count = db.getOldLogsStats(retentionDays);
    return { count };
  });

  ipcMain.handle('save-activity-log', async (event, csvContent) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save Activity Log',
        defaultPath: `activity-log-${new Date().toISOString().split('T')[0]}.csv`,
        filters: [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, cancelled: true };
      }

      fs.writeFileSync(result.filePath, csvContent, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Settings
  ipcMain.handle('get-setting', async (event, key) => {
    return db.getSetting(key);
  });

  ipcMain.handle('set-setting', async (event, key, value) => {
    db.setSetting(key, value);
  });

  ipcMain.handle('get-all-settings', async () => {
    return db.getAllSettings();
  });

  // File browsing
  ipcMain.handle('browse-files', async (event, username, path) => {
    const fs = require('fs');
    const pathModule = require('path');
    
    const user = db.getUser(username);
    if (!user) throw new Error('User not found');
    
    const virtualPaths = db.getVirtualPaths(user.id!);
    if (virtualPaths.length === 0) {
      throw new Error('User has no virtual paths configured');
    }
    
    // Map virtual path to real path
    let realPath = '';
    for (const vp of virtualPaths) {
      if (path === vp.virtualPath || path.startsWith(vp.virtualPath + '/')) {
        const relativePath = path.substring(vp.virtualPath.length);
        realPath = pathModule.join(vp.localPath, relativePath);
        break;
      }
    }
    
    if (!realPath && virtualPaths.length > 0) {
      realPath = pathModule.join(virtualPaths[0].localPath, path);
    }
    
    // Ensure directory exists
    if (!fs.existsSync(realPath)) {
      fs.mkdirSync(realPath, { recursive: true });
    }
    
    const files = fs.readdirSync(realPath);
    const fileList = files.map((file: string) => {
      const filePath = pathModule.join(realPath, file);
      const stats = fs.statSync(filePath);
      return {
        name: file,
        size: stats.size,
        mtime: stats.mtime,
        isDirectory: stats.isDirectory()
      };
    });
    
    return { files: fileList };
  });

  ipcMain.handle('download-file', async (event, username, filePath) => {
    const fs = require('fs');
    const pathModule = require('path');
    
    const user = db.getUser(username);
    if (!user) throw new Error('User not found');
    
    const virtualPaths = db.getVirtualPaths(user.id!);
    if (virtualPaths.length === 0) {
      throw new Error('User has no virtual paths configured');
    }
    
    // Map virtual path to real path
    let realPath = '';
    for (const vp of virtualPaths) {
      if (filePath === vp.virtualPath || filePath.startsWith(vp.virtualPath + '/')) {
        const relativePath = filePath.substring(vp.virtualPath.length);
        realPath = pathModule.join(vp.localPath, relativePath);
        break;
      }
    }
    
    if (!realPath && virtualPaths.length > 0) {
      realPath = pathModule.join(virtualPaths[0].localPath, filePath);
    }
    
    if (!fs.existsSync(realPath)) {
      throw new Error('File not found');
    }
    
    // Show save dialog
    const result = await dialog.showSaveDialog({
      defaultPath: pathModule.basename(realPath),
      filters: [
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    
    if (!result.canceled && result.filePath) {
      fs.copyFileSync(realPath, result.filePath);
      return { success: true, savedPath: result.filePath };
    }
    
    return { success: false };
  });

  // Web Server control
  ipcMain.handle('start-web-server', async (event, port?: number) => {
    try {
      if (webServer) {
        return { success: false, error: 'Web server is already running' };
      }
      
      const webPort = port || parseInt(process.env.WEB_PORT || '3000');
      webServer = new WebServer(db, serverManager, webPort);
      await webServer.start();
      
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_STARTED',
        path: `Web GUI server started on port ${webPort}`,
        success: true
      });
      
      return { success: true, port: webPort };
    } catch (err: any) {
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_START_FAILED',
        path: err.message,
        success: false
      });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-web-server', async () => {
    try {
      if (!webServer) {
        return { success: false, error: 'Web server is not running' };
      }
      
      await webServer.stop();
      webServer = null;
      
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_STOPPED',
        path: 'Web GUI server stopped',
        success: true
      });
      
      return { success: true };
    } catch (err: any) {
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_STOP_FAILED',
        path: err.message,
        success: false
      });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-web-server-status', async () => {
    return { 
      running: webServer !== null,
      port: webServer ? (webServer as any).port : null
    };
  });

  ipcMain.handle('update-web-server-port', async (event, newPort: number) => {
    try {
      // Stop existing web server if running
      if (webServer) {
        await webServer.stop();
        webServer = null;
      }
      
      // Start web server on new port
      webServer = new WebServer(db, serverManager, newPort);
      await webServer.start();
      
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_PORT_CHANGED',
        path: `Web server port changed to ${newPort}`,
        success: true
      });
      
      return { success: true, port: newPort };
    } catch (err: any) {
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_PORT_CHANGE_FAILED',
        path: err.message,
        success: false
      });
      return { success: false, error: err.message };
    }
  });
}

app.whenReady().then(async () => {
  // Ensure all required directories exist
  ensureDirectories();
  
  await initializeDatabase();
  
  // Cleanup old activity logs based on retention settings
  const deletedCount = db.cleanupOldActivities();
  if (deletedCount > 0) {
    logger.info(`Cleaned up ${deletedCount} old activity log entries`);
  }
  
  setupServerManager();
  setupIpcHandlers();
  
  // Show login window instead of main window
  createLoginWindow();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On Windows/Linux, quit when all windows are closed
  // On macOS, apps typically stay open even when windows are closed
  if (process.platform !== 'darwin') {
    if (!isQuitting) {
      // If the window was minimized to tray, don't quit
      return;
    }
    app.quit();
  }
});

app.on('before-quit', async () => {
  logger.info('Application quitting - shutting down servers...');
  isQuitting = true;
  
  try {
    if (webServer) {
      await webServer.stop();
      logger.info('Web server stopped');
    }
  } catch (err) {
    logger.error('Error stopping web server:', err);
  }
  
  try {
    await serverManager.stopAllListeners();
    logger.info('All servers stopped');
  } catch (err) {
    logger.error('Error stopping servers:', err);
  }
  
  try {
    db.close();
    logger.info('Database closed');
  } catch (err) {
    logger.error('Error closing database:', err);
  }
});
