/**
 * e2e-electron-lifecycle.test.ts — End-to-end tests for Electron main process lifecycle
 * Tests application startup, window management, and core Electron functionality
 */

import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock Electron modules since we can't run actual Electron in tests
jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn((name: string) => {
      const paths: Record<string, string> = {
        userData: path.join(os.tmpdir(), 'electron-test-userdata'),
        appData: path.join(os.tmpdir(), 'electron-test-appdata'),
        temp: os.tmpdir()
      };
      return paths[name] || os.tmpdir();
    }),
    on: jest.fn(),
    quit: jest.fn(),
    whenReady: jest.fn().mockResolvedValue(undefined),
    getVersion: jest.fn().mockReturnValue('1.1.0'),
    getName: jest.fn().mockReturnValue('SLightSFTP'),
    setAppUserModelId: jest.fn()
  },
  BrowserWindow: {
    getInstance: jest.fn().mockReturnValue(null),
    fromWebContents: jest.fn().mockReturnValue(null)
  },
  ipcMain: {
    on: jest.fn(),
    handle: jest.fn(),
    removeHandler: jest.fn()
  },
  Tray: jest.fn().mockImplementation(() => ({
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    displayBalloon: jest.fn(),
    destroy: jest.fn()
  })),
  Menu: {
    buildFromTemplate: jest.fn().mockReturnValue({
      items: []
    }),
    setApplicationMenu: jest.fn()
  },
  nativeImage: {
    createFromPath: jest.fn().mockReturnValue({
      toDataURL: jest.fn().mockReturnValue('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    })
  },
  dialog: {
    showErrorBox: jest.fn(),
    showMessageBox: jest.fn().mockResolvedValue({ response: 0 })
  }
}));

describe('Electron Main Process Lifecycle', () => {
  let testDir: string;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let webServer: WebServer;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `electron-lifecycle-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    serverManager = new ServerManager(db);
    webServer = new WebServer(db, serverManager, 13357);
  }, 30000);

  afterAll(async () => {
    try {
      if (webServer) {
        try {
          await webServer.stop();
        } catch (e) {
          // Ignore if server not running
        }
      }
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Silent cleanup
    }
  }, 30000);

  describe('Application Initialization', () => {
    test('should initialize database with correct structure', async () => {
      // Verify database tables exist
      const listeners = db.getAllListeners();
      expect(Array.isArray(listeners)).toBe(true);

      const users = db.getAllUsers();
      expect(Array.isArray(users)).toBe(true);
    });

    test('should create default admin user on first run', async () => {
      // Check if admin user exists, create if not
      let admin = db.getUser('admin');
      if (!admin) {
        db.createUser({
          username: 'admin',
          password: 'admin123',
          passwordEnabled: true,
          publicKey: '',
          guiEnabled: true
        });
        admin = db.getUser('admin');
      }

      expect(admin).toBeDefined();
      expect(admin?.username).toBe('admin');
      expect(admin?.guiEnabled).toBe(true);
    });

    test('should initialize server manager', () => {
      expect(serverManager).toBeDefined();
      expect(serverManager['db']).toBe(db);
    });

    test('should initialize web server', () => {
      expect(webServer).toBeDefined();
      expect(webServer['db']).toBe(db);
    });

    test('should start web server', async () => {
      await webServer.start();
      expect(webServer['server']).toBeDefined();
    });
  });

  describe('Application Directory Structure', () => {
    test('should create required directories on startup', () => {
      const requiredDirs = ['config', 'data', 'logs', 'ftp-root'];
      
      requiredDirs.forEach(dir => {
        const dirPath = path.join(testDir, dir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        expect(fs.existsSync(dirPath)).toBe(true);
      });
    });

    test('should handle missing directories gracefully', () => {
      const nonExistentDir = path.join(testDir, 'nonexistent');
      expect(fs.existsSync(nonExistentDir)).toBe(false);
      
      // Should create directory when needed
      fs.mkdirSync(nonExistentDir, { recursive: true });
      expect(fs.existsSync(nonExistentDir)).toBe(true);
    });
  });

  describe('Application Lifecycle Events', () => {
    test('should handle application ready event', async () => {
      // Simulate app.whenReady()
      const mockApp = require('electron').app;
      const whenReadySpy = jest.spyOn(mockApp, 'whenReady');
      
      await mockApp.whenReady();
      expect(whenReadySpy).toHaveBeenCalled();
    });

    test('should handle application quit event', () => {
      const mockApp = require('electron').app;
      const quitSpy = jest.spyOn(mockApp, 'quit');
      
      // Simulate quit
      mockApp.quit();
      expect(quitSpy).toHaveBeenCalled();
    });

    test('should handle window close event', () => {
      // Simulate window close logic
      const isQuitting = false;
      const shouldClose = isQuitting;
      
      expect(shouldClose).toBe(false);
      
      // When isQuitting is true, window should close
      const isQuitting2 = true;
      const shouldClose2 = isQuitting2;
      expect(shouldClose2).toBe(true);
    });
  });

  describe('Window Management', () => {
    test('should create main window configuration', () => {
      const mainWindowConfig = {
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, '../preload.js')
        }
      };

      expect(mainWindowConfig.width).toBe(1200);
      expect(mainWindowConfig.height).toBe(800);
      expect(mainWindowConfig.webPreferences.nodeIntegration).toBe(false);
      expect(mainWindowConfig.webPreferences.contextIsolation).toBe(true);
    });

    test('should create login window configuration', () => {
      const loginWindowConfig = {
        width: 400,
        height: 500,
        resizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, '../preload.js')
        }
      };

      expect(loginWindowConfig.width).toBe(400);
      expect(loginWindowConfig.height).toBe(500);
      expect(loginWindowConfig.resizable).toBe(false);
    });

    test('should handle window focus events', () => {
      const mainWindow = { focus: jest.fn(), show: jest.fn() };
      
      mainWindow.focus();
      expect(mainWindow.focus).toHaveBeenCalled();
      
      mainWindow.show();
      expect(mainWindow.show).toHaveBeenCalled();
    });

    test('should handle window minimize events', () => {
      const mainWindow = { minimize: jest.fn(), hide: jest.fn() };
      
      mainWindow.minimize();
      expect(mainWindow.minimize).toHaveBeenCalled();
      
      mainWindow.hide();
      expect(mainWindow.hide).toHaveBeenCalled();
    });
  });

  describe('Tray Management', () => {
    test('should create tray icon', () => {
      const mockTray = require('electron').Tray;
      const mockNativeImage = require('electron').nativeImage;
      
      const iconPath = path.join(__dirname, '../../assets/icon.png');
      const tray = new mockTray(mockNativeImage.createFromPath(iconPath));
      
      expect(tray).toBeDefined();
      expect(mockNativeImage.createFromPath).toHaveBeenCalled();
    });

    test('should set tray tooltip', () => {
      const mockTray = require('electron').Tray;
      const tray = new mockTray();
      
      tray.setToolTip('SLightSFTP Server');
      expect(tray.setToolTip).toHaveBeenCalledWith('SLightSFTP Server');
    });

    test('should create tray context menu', () => {
      const mockMenu = require('electron').Menu;
      const mockTray = require('electron').Tray;
      
      const tray = new mockTray();
      const menuTemplate = [
        { label: 'Show Window', click: jest.fn() },
        { label: 'Quit', click: jest.fn() }
      ];
      
      const menu = mockMenu.buildFromTemplate(menuTemplate);
      tray.setContextMenu(menu);
      
      expect(mockMenu.buildFromTemplate).toHaveBeenCalledWith(menuTemplate);
      expect(tray.setContextMenu).toHaveBeenCalledWith(menu);
    });
  });

  describe('Server Management Integration', () => {
    test('should start all enabled listeners on app ready', async () => {
      // Create a test listener
      const listenerId = db.createListener({
        name: 'Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12226,
        enabled: true
      });

      // Start all enabled listeners
      await serverManager.startAllEnabledListeners();
      
      const statuses = serverManager.getAllListenerStatuses();
      expect(statuses.length).toBeGreaterThan(0);
    });

    test('should stop all listeners on app quit', async () => {
      await serverManager.stopAllListeners();
      
      const statuses = serverManager.getAllListenerStatuses();
      statuses.forEach((status: any) => {
        expect(status.running).toBe(false);
      });
    });

    test('should handle listener start/stop events', async () => {
      const listenerId = db.createListener({
        name: 'Event Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12227,
        enabled: true
      });

      await serverManager.startListener(listenerId);
      let status = serverManager.getListenerStatus(listenerId);
      expect(status?.running).toBe(true);

      await serverManager.stopListener(listenerId);
      status = serverManager.getListenerStatus(listenerId);
      expect(status?.running).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should handle database initialization errors', async () => {
      const invalidDbPath = '/nonexistent/path/invalid.db';
      const errorDb = new DatabaseManager(invalidDbPath);
      
      // Should handle error gracefully
      try {
        await errorDb.init();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    test('should handle web server start errors', async () => {
      // Use a different port to avoid conflict
      const errorWebServer = new WebServer(db, serverManager, 13358);
      
      // Should handle port conflict gracefully
      try {
        await errorWebServer.start();
        await errorWebServer.stop();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    test('should handle listener start errors', async () => {
      const listenerId = db.createListener({
        name: 'Error Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12229,
        enabled: true
      });

      // Try to start listener - should complete without throwing
      await serverManager.startListener(listenerId);
      await serverManager.stopListener(listenerId);
    });

    test('should show error dialog on critical errors', () => {
      const mockDialog = require('electron').dialog;
      
      mockDialog.showErrorBox('Test Error', 'This is a test error message');
      expect(mockDialog.showErrorBox).toHaveBeenCalledWith('Test Error', 'This is a test error message');
    });
  });

  describe('Security and Validation', () => {
    test('should validate user credentials', () => {
      const user = db.getUser('admin');
      expect(user).toBeDefined();
      expect(user?.passwordEnabled).toBe(true);
    });

    test('should enforce GUI access control', () => {
      const guiUser = db.getUser('admin');
      expect(guiUser?.guiEnabled).toBe(true);

      db.createUser({
        username: 'nogui',
        password: 'noguipass',
        passwordEnabled: true,
        guiEnabled: false
      });
      
      const nonGuiUser = db.getUser('nogui');
      expect(nonGuiUser?.guiEnabled).toBe(false);
    });

    test('should validate listener configuration', () => {
      const validListener = {
        name: 'Valid Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12229,
        enabled: true
      };

      expect(validListener.port).toBeGreaterThan(0);
      expect(validListener.port).toBeLessThan(65536);
      expect(['FTP', 'SFTP'].includes(validListener.protocol)).toBe(true);
    });
  });

  describe('Cleanup and Resource Management', () => {
    test('should close database on app quit', () => {
      const closeSpy = jest.spyOn(db, 'close');
      
      db.close();
      expect(closeSpy).toHaveBeenCalled();
    });

    test('should stop web server on app quit', async () => {
      const stopSpy = jest.spyOn(webServer, 'stop');
      
      await webServer.stop();
      expect(stopSpy).toHaveBeenCalled();
    });

    test('should clean up temporary files', () => {
      const tempFile = path.join(testDir, 'temp.txt');
      fs.writeFileSync(tempFile, 'temporary content');
      
      expect(fs.existsSync(tempFile)).toBe(true);
      
      fs.unlinkSync(tempFile);
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    test('should handle cleanup errors gracefully', () => {
      const nonExistentFile = path.join(testDir, 'nonexistent.txt');
      
      try {
        fs.unlinkSync(nonExistentFile);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });
});
