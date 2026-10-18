import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { WebServer } from './web-server';
import logger from './logger';
import { resolveUserPath } from './path-utils';
import { requiresPasswordChange, validateNewPassword } from './password';
import { getServerCertificate, hostKeyFingerprint, setCertificateDir } from './tls';
import { describeShare } from './shares';
import { WebhookDispatcher, describeWebhook, validateWebhookInput } from './webhooks';
import { cleanAllowedIps, getLoginGuard, saveGuardSettings } from './login-guard';
import { beginTotpSetup, checkSecondFactor, confirmTotpSetup, disableTotp, publicUser } from './two-factor';
import { cleanAuthorizedKeys } from './authorized-keys';
import { SyslogForwarder, formatSyslog, readSyslogSettings, saveSyslogSettings } from './syslog';
import { checksumsEnabled } from './checksum';
import { getQuotaManager, quotaFromMegabytes } from './quota';

let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: DatabaseManager;
let serverManager: ServerManager;
let webServer: WebServer | null = null;
let isQuitting = false;
let isLoggingOut = false;
let authenticatedUser: any = null;
let pendingPasswordChangeUser: any = null;
let webhooks: WebhookDispatcher;
let syslog: SyslogForwarder;

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
    height: 630, // room for the two-factor code field
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
              detail: `Version ${app.getVersion()}\nMulti-user FTP/SFTP server with GUI management`,
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
      guiEnabled: true,
      mustChangePassword: true
    });
    
    // Create default SFTP listener
    const sftpListenerId = db.createListener({
      name: 'Default SFTP',
      protocol: 'SFTP',
      bindingIp: '0.0.0.0',
      port: 2222,
      enabled: true
    });
    
    // Create default FTP listener
    const ftpListenerId = db.createListener({
      name: 'Default FTP',
      protocol: 'FTP',
      bindingIp: '0.0.0.0',
      port: 2121,
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

  // Development convenience: migrate legacy default ports to non-privileged values
  // so local runs don't require sudo/root.
  if (!app.isPackaged) {
    for (const listener of db.getAllListeners()) {
      if (!listener.id) continue;

      const legacy =
        (listener.name === 'Default SFTP' && listener.protocol === 'SFTP' && listener.port === 22) ? 2222 :
        (listener.name === 'Default FTP' && listener.protocol === 'FTP' && listener.port === 21) ? 2121 :
        null;

      if (legacy) {
        db.updateListener(listener.id, {
          name: listener.name,
          bindingIp: listener.bindingIp,
          port: legacy,
          enabled: listener.enabled
        });
        logger.info(`Migrated ${listener.name} port from ${listener.port} to ${legacy} for development`);
      }
    }
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

/**
 * Start the web GUI server; HTTPS when the `webHttps` setting is on (using the
 * certificate from the tlsCertPath/tlsKeyPath settings, or a generated one).
 */
async function createWebServer(port: number): Promise<WebServer> {
  let tls: { key: string; cert: string } | undefined;
  if (db.getSetting('webHttps') === 'true') {
    tls = await getServerCertificate({
      certPath: db.getSetting('tlsCertPath'),
      keyPath: db.getSetting('tlsKeyPath')
    });
  }
  const server = new WebServer(db, serverManager, port, { tls, webhooks, syslog });
  await server.start();
  return server;
}

/** Successful GUI sign-in: swap the login window for the dashboard. */
function completeLogin(user: any): void {
  authenticatedUser = user;
  pendingPasswordChangeUser = null;
  logger.info('Authentication successful! User:', { username: user.username });

  db.logActivity({
    listenerId: null,
    username: user.username,
    action: 'GUI_LOGIN',
    path: '/',
    success: true
  });

  // destroy() rather than close(): the login window's close handler only hides it,
  // which would leak a hidden window
  if (loginWindow) {
    loginWindow.destroy();
    loginWindow = null;
  }

  // Never stack a second dashboard on top of an existing one
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }

  logger.info('Creating main window...');
  createWindow();
  if (!tray) {
    createTray();
  }
  updateTrayMenu();
}

function setupIpcHandlers(): void {
  // Authentication handler
  ipcMain.handle('authenticate-user', async (event, username, password, totpCode) => {
    try {
      const user = db.getUser(username);
      
      // Return generic error for all failure cases (security best practice)
      if (!user || !user.guiEnabled) {
        return { success: false, error: 'Invalid username or password' };
      }

      if (!db.checkPassword(username, password)) {
        return { success: false, error: 'Invalid username or password' };
      }

      // Second factor (TOTP) when the user has turned it on
      const second = checkSecondFactor(db, user, totpCode);
      if (second !== 'ok') {
        if (second === 'invalid') {
          db.logActivity({ listenerId: null, username: user.username, action: 'GUI_LOGIN_FAILED', path: 'Invalid two-factor code', success: false });
        }
        return {
          success: false,
          requireTotp: true,
          error: second === 'required' ? 'Enter the code from your authenticator app' : 'Invalid two-factor code'
        };
      }

      // First login with the default password, or the account was flagged by an admin
      if (requiresPasswordChange(user, password)) {
        pendingPasswordChangeUser = user;
        db.logActivity({
          listenerId: null,
          username: user.username,
          action: 'GUI_PASSWORD_CHANGE_REQUIRED',
          path: '/',
          success: true
        });
        return { success: true, requirePasswordChange: true };
      }

      completeLogin(user);
      return { success: true, user: { username: user.username, id: user.id } };
    } catch (error) {
      logger.error('Authentication error:', error);
      return { success: false, error: 'An error occurred during authentication' };
    }
  });

  // Forced password change after authenticate-user returned requirePasswordChange
  ipcMain.handle('set-first-login-password', async (event, newPassword) => {
    const user = pendingPasswordChangeUser;
    if (!user) {
      return { success: false, error: 'No password change is pending' };
    }

    const problem = validateNewPassword(newPassword);
    if (problem) {
      return { success: false, error: problem };
    }
    if (db.checkPassword(user.username, newPassword)) {
      return { success: false, error: 'The new password must be different from the current one' };
    }

    db.updateUser(user.username, { password: newPassword, mustChangePassword: false });
    db.logActivity({
      listenerId: null,
      username: user.username,
      action: 'GUI_PASSWORD_CHANGED',
      path: '/',
      success: true
    });

    completeLogin(db.getUser(user.username));
    return { success: true };
  });

  // Share links created in the web file portal
  ipcMain.handle('get-shares', async () => {
    return db.listShares().map(share => describeShare(share));
  });

  ipcMain.handle('revoke-share', async (event, id) => {
    const share = db.getShare(id);
    if (!share) throw new Error('Link not found');
    db.revokeShare(id);
    db.logActivity({
      listenerId: null,
      username: authenticatedUser?.username || 'system',
      action: 'SHARE_REVOKED',
      path: `${share.owner}:${share.virtualPath}`,
      success: true
    });
    return { success: true };
  });

  // Brute-force protection
  ipcMain.handle('get-ip-bans', async () => getLoginGuard(db).listBans());

  ipcMain.handle('unban-ip', async (event, ip) => {
    getLoginGuard(db).unban(ip);
    db.logActivity({ listenerId: null, username: authenticatedUser?.username || 'system', action: 'IP_UNBANNED', path: ip, success: true });
    return { success: true };
  });

  ipcMain.handle('get-security-settings', async () => getLoginGuard(db).settings());

  ipcMain.handle('set-security-settings', async (event, settings) => {
    saveGuardSettings(db, settings || {});
    return getLoginGuard(db).settings();
  });

  // Audit export
  ipcMain.handle('get-audit-settings', async () => ({ syslog: readSyslogSettings(db), checksumUploads: checksumsEnabled(db) }));

  ipcMain.handle('set-audit-settings', async (event, input) => {
    if (input?.syslog) saveSyslogSettings(db, input.syslog);
    if (input?.checksumUploads !== undefined) db.setSetting('checksumUploads', input.checksumUploads ? 'true' : 'false');
    return { syslog: readSyslogSettings(db), checksumUploads: checksumsEnabled(db) };
  });

  ipcMain.handle('test-syslog', async () => {
    try {
      await syslog.send(formatSyslog({ listenerId: null, username: authenticatedUser?.username || 'admin', action: 'SYSLOG_TEST', path: '/', success: true, timestamp: new Date().toISOString() }, readSyslogSettings(db).facility));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // Webhooks
  ipcMain.handle('get-webhooks', async () => db.listWebhooks().map(describeWebhook));

  ipcMain.handle('create-webhook', async (event, input) => {
    const clean = validateWebhookInput(input || {});
    const id = db.createWebhook({ format: 'json', enabled: true, ...clean } as any);
    db.logActivity({ listenerId: null, username: authenticatedUser?.username || 'system', action: 'WEBHOOK_CREATED', path: clean.name!, success: true });
    return describeWebhook(db.getWebhook(id)!);
  });

  ipcMain.handle('update-webhook', async (event, id, input) => {
    if (!db.getWebhook(id)) throw new Error('Webhook not found');
    db.updateWebhook(id, validateWebhookInput(input || {}, true));
    return describeWebhook(db.getWebhook(id)!);
  });

  ipcMain.handle('delete-webhook', async (event, id) => {
    const hook = db.getWebhook(id);
    if (!hook) throw new Error('Webhook not found');
    db.deleteWebhook(id);
    db.logActivity({ listenerId: null, username: authenticatedUser?.username || 'system', action: 'WEBHOOK_DELETED', path: hook.name, success: true });
    return { success: true };
  });

  ipcMain.handle('test-webhook', async (event, id) => {
    const hook = db.getWebhook(id);
    if (!hook) throw new Error('Webhook not found');
    return webhooks.test(hook, authenticatedUser?.username || 'admin');
  });

  // Server identity that admins can hand to users for verification
  ipcMain.handle('get-server-identity', async () => {
    return { sshHostKeyFingerprint: hostKeyFingerprint() };
  });

  // Two-factor sign-in for the signed-in user
  ipcMain.handle('totp-setup', async () => {
    if (!authenticatedUser) throw new Error('Not signed in');
    return beginTotpSetup(db, authenticatedUser.username);
  });

  ipcMain.handle('totp-enable', async (event, code) => {
    if (!authenticatedUser || !confirmTotpSetup(db, authenticatedUser.username, code)) {
      throw new Error('That code is not valid. Check the time on your phone and try again.');
    }
    db.logActivity({ listenerId: null, username: authenticatedUser.username, action: 'GUI_2FA_ENABLED', path: '/', success: true });
    return { success: true };
  });

  ipcMain.handle('totp-disable', async (event, code) => {
    if (!authenticatedUser || !disableTotp(db, authenticatedUser.username, code)) {
      throw new Error('Invalid two-factor code');
    }
    db.logActivity({ listenerId: null, username: authenticatedUser.username, action: 'GUI_2FA_DISABLED', path: '/', success: true });
    return { success: true };
  });

  // Get authenticated user info
  ipcMain.handle('get-authenticated-user', async () => {
    logger.debug('IPC: get-authenticated-user called');
    logger.debug('authenticatedUser:', authenticatedUser);
    const result = authenticatedUser ? { 
      username: authenticatedUser.username, 
      id: authenticatedUser.id,
      totpEnabled: !!db.getUser(authenticatedUser.username)?.totpEnabled
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
    pendingPasswordChangeUser = null;
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
    const { quotaMb, ...fields } = user || {};
    const userId = db.createUser({ ...fields, allowedIps: cleanAllowedIps(fields.allowedIps), publicKey: cleanAuthorizedKeys(fields.publicKey), quotaBytes: quotaFromMegabytes(quotaMb) });
    
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
  
  // Password hashes and TOTP secrets never leave the main process
  const withoutPassword = (user: any) => (user ? publicUser(user) : user);

  ipcMain.handle('get-user', async (event, username) => {
    return withoutPassword(db.getUser(username));
  });
  
  ipcMain.handle('get-all-users', async () => {
    return db.getAllUsers().map(withoutPassword);
  });
  
  ipcMain.handle('update-user', async (event, username, updates, listeners, virtualPaths, permissions) => {
    const user = db.getUser(username);
    if (!user) throw new Error('User not found');
    
    // Update user
    if (updates && updates.allowedIps !== undefined) {
      updates = { ...updates, allowedIps: cleanAllowedIps(updates.allowedIps) };
    }
    if (updates && updates.publicKey !== undefined) {
      updates = { ...updates, publicKey: cleanAuthorizedKeys(updates.publicKey) };
    }
    if (updates && updates.quotaMb !== undefined) {
      const { quotaMb, ...rest } = updates;
      updates = { ...rest, quotaBytes: quotaFromMegabytes(quotaMb) };
      getQuotaManager(db).invalidate(username);
    }
    if (updates) {
      // Admins may reset (turn off) two-factor sign-in, never set secrets or turn it on
      const { totpSecret: _s, totpPendingSecret: _p, totpEnabled, ...rest } = updates;
      updates = totpEnabled === false ? { ...rest, totpEnabled: false } : rest;
    }
    db.updateUser(username, updates);
    
    // Replace subscriptions / permissions / virtual paths as sent by the Edit User dialog
    if (Array.isArray(listeners) && Array.isArray(virtualPaths)) {
      db.replaceUserAccess(user.id!, listeners, virtualPaths, Array.isArray(permissions) ? permissions : []);
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
  
  ipcMain.handle('get-user-usage', async (event, username) => {
    const user = db.getUser(username);
    if (!user) throw new Error('User not found');
    return getQuotaManager(db).usage(user);
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

    // Apply the new settings (e.g. port) to a running listener
    if (serverManager.isListenerRunning(id)) {
      if (listener?.enabled) {
        await serverManager.restartListener(id);
      } else {
        await serverManager.stopListener(id);
      }
    }
    
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
        protocol: (webServer?.isHttps() ? 'HTTPS' : 'HTTP') as any,
        port: webServer ? webServer.getPort() : parseInt(process.env.WEB_PORT || '3000'),
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
    
    const resolved = resolveUserPath(virtualPaths, path);
    if (!resolved) throw new Error('No access to this path');
    const realPath = resolved.localPath;
    
    if (!fs.existsSync(realPath) || !fs.statSync(realPath).isDirectory()) {
      throw new Error('Path not found');
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
    
    const resolved = resolveUserPath(virtualPaths, filePath);
    if (!resolved) throw new Error('No access to this path');
    const realPath = resolved.localPath;
    
    if (!fs.existsSync(realPath) || fs.statSync(realPath).isDirectory()) {
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
      webServer = await createWebServer(webPort);
      
      db.logActivity({
        listenerId: 0,
        username: authenticatedUser?.username || 'system',
        action: 'WEB_SERVER_STARTED',
        path: `Web GUI server started on port ${webPort}`,
        success: true
      });
      
      return { success: true, port: webPort, https: webServer.isHttps(), url: webServer.getUrl() };
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
      port: webServer ? webServer.getPort() : null,
      https: webServer ? webServer.isHttps() : db.getSetting('webHttps') === 'true',
      url: webServer ? webServer.getUrl() : null
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
      webServer = await createWebServer(newPort);
      
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
  setCertificateDir(getAppDirectories().config);
  
  await initializeDatabase();
  webhooks = new WebhookDispatcher(db);
  syslog = new SyslogForwarder(db);
  
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
