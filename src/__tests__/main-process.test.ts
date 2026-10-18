/**
 * main-process.test.ts — exercises the real Electron main process (main.ts).
 *
 * Only the `electron` module is replaced by a lightweight fake; the database,
 * ServerManager, FTP/SFTP servers and WebServer are all real. Every IPC handler
 * registered by main.ts is invoked exactly the way the renderer would call it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');

jest.setTimeout(30000);

// ─── fake electron ──────────────────────────────────────────────────────────
const handlers = new Map<string, (...args: any[]) => any>();
const appEvents = new Map<string, Array<(...args: any[]) => any>>();
const windows: any[] = [];
const trays: any[] = [];
const menuTemplates: any[] = [];
let installDir = '';

jest.mock('electron', () => {
  const { EventEmitter } = require('events');

  class FakeBrowserWindow extends EventEmitter {
    options: any;
    loadedFile = '';
    visible = true;
    destroyed = false;
    webContents = { send: jest.fn() };
    constructor(options: any) {
      super();
      this.options = options;
      windows.push(this);
    }
    loadFile(file: string) { this.loadedFile = file; return Promise.resolve(); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    isDestroyed() { return this.destroyed; }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
  }

  class FakeTray extends EventEmitter {
    menu: any;
    tooltip = '';
    constructor() { super(); trays.push(this); }
    setToolTip(t: string) { this.tooltip = t; }
    setContextMenu(m: any) { this.menu = m; }
    destroy() {}
  }

  const image = { resize: () => image, toDataURL: () => '' };

  return {
    app: {
      get isPackaged() { return true; },
      getPath: (name: string) => (name === 'exe' ? require('path').join(installDir, 'SLightSFTP') : installDir),
      getVersion: () => require('../../package.json').version,
      whenReady: () => Promise.resolve(),
      on: (event: string, cb: (...args: any[]) => any) => {
        if (!appEvents.has(event)) appEvents.set(event, []);
        appEvents.get(event)!.push(cb);
      },
      quit: jest.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    ipcMain: {
      handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn),
      on: jest.fn(),
    },
    Menu: {
      buildFromTemplate: (template: any) => { menuTemplates.push(template); return { template }; },
      setApplicationMenu: jest.fn(),
    },
    nativeImage: { createFromPath: () => image, createEmpty: () => image },
    dialog: {
      showOpenDialog: jest.fn(),
      showSaveDialog: jest.fn(),
      showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
      showErrorBox: jest.fn(),
    },
  };
});

const electron = require('electron');

/** Invoke an IPC handler the way ipcRenderer.invoke would. */
const invoke = (channel: string, ...args: any[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for '${channel}'`);
  return fn({ sender: {} }, ...args);
};

/** Windows that still exist (open or hidden) for a given page. */
const ADMIN_PW = 'N3w-Admin-Pass';

const visibleWindows = (file: string) => windows.filter(w => !w.destroyed && w.loadedFile.endsWith(file));

describe('Electron main process (main.ts) with real backend', () => {
  let ftpRoot: string;

  beforeAll(async () => {
    installDir = makeTempDir('main');
    // Keep the default listeners (2222/2121) from binding during the test run
    const { ServerManager } = require('../server-manager');
    jest.spyOn(ServerManager.prototype, 'startAllEnabledListeners').mockResolvedValue(undefined);

    jest.isolateModules(() => { require('../main'); });
    await waitFor(() => handlers.has('authenticate-user') && windows.length > 0);

    ftpRoot = path.join(installDir, 'data', 'ftp-root');
  });

  afterAll(async () => {
    for (const cb of appEvents.get('before-quit') || []) await cb();
    removeDir(installDir);
  });

  describe('first start', () => {
    test('creates the installation directory layout', () => {
      for (const dir of ['config', 'data', 'logs', path.join('data', 'ftp-root')]) {
        expect(fs.statSync(path.join(installDir, dir)).isDirectory()).toBe(true);
      }
      expect(fs.existsSync(path.join(installDir, 'config', 'config.db'))).toBe(true);
    });

    test('shows only the frameless login window, with the login page loaded', () => {
      const login = visibleWindows('login.html');
      expect(login).toHaveLength(1);
      expect(login[0].options.frame).toBe(false);
      expect(visibleWindows('index.html')).toHaveLength(0);
    });

    test('seeds the default admin and non-privileged default listeners', async () => {
      const users = await invoke('get-all-users');
      expect(users.map((u: any) => u.username)).toEqual(['admin']);

      const listeners = await invoke('get-all-listeners');
      expect(listeners.map((l: any) => [l.name, l.protocol, l.port])).toEqual([
        ['Default SFTP', 'SFTP', 2222],
        ['Default FTP', 'FTP', 2121],
      ]);

      const admin = await invoke('get-user', 'admin');
      expect(await invoke('get-user-listeners', admin.id)).toEqual(listeners.map((l: any) => l.id));
      const vps = await invoke('get-virtual-paths', admin.id);
      expect(vps[0]).toMatchObject({ virtualPath: '/', localPath: ftpRoot });
    });
  });

  describe('IPC contract with the GUI', () => {
    const channelsUsedBy = (file: string) => {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      return [...new Set([...src.matchAll(/ipcRenderer\.invoke\(\s*'([a-z-]+)'/g)].map(m => m[1]))];
    };

    test.each(['renderer.js', 'login.html'])('every channel invoked by %s has a main-process handler', file => {
      const missing = channelsUsedBy(file).filter(c => !handlers.has(c));
      expect(missing).toEqual([]);
    });
  });

  describe('desktop login', () => {
    test('rejects unknown users and wrong passwords with the same generic message', async () => {
      const unknown = await invoke('authenticate-user', 'ghost', 'x');
      const wrong = await invoke('authenticate-user', 'admin', 'wrong');
      expect(unknown).toEqual({ success: false, error: 'Invalid username or password' });
      expect(wrong).toEqual(unknown);
      expect(await invoke('get-authenticated-user')).toBeNull();
    });

    test('rejects users without GUI access', async () => {
      await invoke('create-user', { username: 'nogui', password: 'pw', passwordEnabled: true, guiEnabled: false });
      expect((await invoke('authenticate-user', 'nogui', 'pw')).success).toBe(false);
    });

    test('the default admin password forces a new password before the dashboard opens', async () => {
      expect(await invoke('set-first-login-password', 'Whatever123')).toEqual({ success: false, error: 'No password change is pending' });

      const result = await invoke('authenticate-user', 'admin', 'admin123');
      expect(result).toEqual({ success: true, requirePasswordChange: true });
      expect(await invoke('get-authenticated-user')).toBeNull();
      expect(visibleWindows('login.html')).toHaveLength(1);
      expect(visibleWindows('index.html')).toHaveLength(0);

      expect(await invoke('set-first-login-password', 'short')).toMatchObject({ success: false, error: expect.stringMatching(/at least 8/) });
      expect(await invoke('set-first-login-password', 'admin123')).toMatchObject({ success: false, error: expect.stringMatching(/other than the default/) });
      expect(visibleWindows('index.html')).toHaveLength(0);
    });

    test('choosing a valid new password signs in and opens the dashboard and tray', async () => {
      expect(await invoke('set-first-login-password', ADMIN_PW)).toEqual({ success: true });
      expect(await invoke('get-authenticated-user')).toMatchObject({ username: 'admin' });
      expect((await invoke('get-user', 'admin')).mustChangePassword).toBe(false);
      expect((await invoke('get-user', 'admin')).password).toBeUndefined();

      // the old default password no longer works
      expect((await invoke('authenticate-user', 'admin', 'admin123')).success).toBe(false);

      expect(visibleWindows('login.html')).toHaveLength(0);
      const main = visibleWindows('index.html');
      expect(main).toHaveLength(1);
      expect(main[0].options.webPreferences).toMatchObject({ nodeIntegration: true });
      expect(trays).toHaveLength(1);
      expect(trays[0].tooltip).toBe('SLightSFTP Server');

      const recent = await invoke('get-recent-activities', undefined, 10);
      expect(recent.some((a: any) => a.action === 'GUI_LOGIN' && a.username === 'admin')).toBe(true);
    });

    test('closing the dashboard window minimises to tray instead of quitting', () => {
      const [main] = visibleWindows('index.html');
      main.close();
      expect(main.destroyed).toBe(false);
      expect(main.visible).toBe(false);
      trays[0].emit('click');
      expect(main.visible).toBe(true);
    });

    test('Help → About reports the real application version', async () => {
      const appMenu = menuTemplates.find(t => Array.isArray(t) && t.some((m: any) => m.label === 'Help'));
      const about = appMenu.find((m: any) => m.label === 'Help').submenu.find((i: any) => i.label === 'About');
      about.click();
      const opts = electron.dialog.showMessageBox.mock.calls.at(-1)[1];
      expect(opts.detail).toContain(`Version ${require('../../package.json').version}`);
    });
  });

  describe('user management handlers', () => {
    let listenerIds: number[];

    beforeAll(async () => {
      listenerIds = (await invoke('get-all-listeners')).map((l: any) => l.id);
    });

    test('create-user creates a user that can sign in; the hash is never exposed', async () => {
      const id = await invoke('create-user', { username: 'bob', password: 'bob-pass', passwordEnabled: true, guiEnabled: true });
      expect(typeof id).toBe('number');
      const bob = await invoke('get-user', 'bob');
      expect(bob.password).toBeUndefined(); // hashes never reach the renderer
      expect((await invoke('authenticate-user', 'bob', 'bob-pass')).success).toBe(true);
      // re-login as admin for the rest of the suite
      await invoke('logout');
      await invoke('authenticate-user', 'admin', ADMIN_PW);
    });

    test('update-user replaces subscriptions, permissions and virtual paths', async () => {
      const bob = await invoke('get-user', 'bob');
      await invoke('update-user', 'bob', { passwordEnabled: true, guiEnabled: false }, [listenerIds[0]], [
        { virtualPath: '/', localPath: ftpRoot, ...FULL_VPATH_PERMS },
        { virtualPath: '/docs', localPath: path.join(installDir, 'docs'), canRead: true, canList: true, canWrite: false },
      ], [
        { userId: bob.id, listenerId: listenerIds[0], canRead: true, canList: true, canCreate: true, canEdit: false, canAppend: false, canDelete: false, canCreateDir: false, canRename: false },
      ]);

      expect(await invoke('get-user-listeners', bob.id)).toEqual([listenerIds[0]]);
      const vps = await invoke('get-virtual-paths', bob.id);
      expect(vps.map((v: any) => v.virtualPath)).toEqual(['/', '/docs']);
      expect(vps[1]).toMatchObject({ canWrite: false, canRead: true });
      expect(await invoke('get-permission', bob.id, listenerIds[0])).toMatchObject({ canCreate: true, canEdit: false });
      expect((await invoke('get-user', 'bob')).guiEnabled).toBe(false);

      // a second update removes the subscription and the /docs path again
      await invoke('update-user', 'bob', {}, [], [{ virtualPath: '/', localPath: ftpRoot }], []);
      expect(await invoke('get-user-listeners', bob.id)).toEqual([]);
      expect((await invoke('get-virtual-paths', bob.id)).map((v: any) => v.virtualPath)).toEqual(['/']);
    });

    test('update-user with a new password re-hashes exactly once', async () => {
      await invoke('update-user', 'bob', { password: 'changed', guiEnabled: true }, [], [], []);
      expect((await invoke('authenticate-user', 'bob', 'changed')).success).toBe(true);
      await invoke('logout');
      await invoke('authenticate-user', 'admin', ADMIN_PW);
    });

    test('update-user for an unknown user throws', async () => {
      await expect(invoke('update-user', 'ghost', {}, [], [], [])).rejects.toThrow('User not found');
    });

    test('delete-user removes the user and records who did it', async () => {
      await invoke('delete-user', 'bob');
      expect(await invoke('get-user', 'bob')).toBeUndefined();
      const recent = await invoke('get-recent-activities', undefined, 20);
      expect(recent.find((a: any) => a.action === 'USER_DELETED')).toMatchObject({ username: 'admin', path: '/users/bob' });
    });
  });

  describe('listener handlers drive real servers', () => {
    let sftpId: number;
    let port: number;

    beforeAll(async () => {
      port = await getFreePort();
      sftpId = await invoke('create-listener', { name: 'IPC SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port, enabled: true });
      const admin = await invoke('get-user', 'admin');
      const subs = await invoke('get-user-listeners', admin.id);
      await invoke('update-user', 'admin', {}, [...subs, sftpId], await invoke('get-virtual-paths', admin.id), []);
    });

    afterAll(async () => {
      if ((await invoke('get-listener-status', sftpId)).running) await invoke('stop-listener', sftpId);
    });

    test('start-listener accepts real SFTP connections; status reflects it', async () => {
      await invoke('start-listener', sftpId);
      expect((await invoke('get-listener-status', sftpId)).running).toBe(true);

      const client = new SftpClient();
      await client.connect({ host: '127.0.0.1', port, username: 'admin', password: ADMIN_PW, readyTimeout: 5000 });
      try {
        const sessions = await waitFor(async () => {
          const s = await invoke('get-active-sessions');
          return s.length ? s : null;
        });
        expect(sessions[0]).toMatchObject({ username: 'admin', protocol: 'SFTP', listenerName: 'IPC SFTP' });

        // the dashboard window is notified of server activity
        const [main] = visibleWindows('index.html');
        await waitFor(() => main.webContents.send.mock.calls.some(([ch]: any[]) => ch === 'activity-update'));

        expect(await invoke('disconnect-session', sessions[0].sessionId)).toBe(true);
      } finally {
        await client.end().catch(() => undefined);
      }
    });

    test('get-all-listener-statuses always includes the Web GUI pseudo-listener', async () => {
      const statuses = await invoke('get-all-listener-statuses');
      expect(statuses.find((s: any) => s.listener.id === sftpId).running).toBe(true);
      expect(statuses.find((s: any) => s.listener.id === -1)).toMatchObject({ running: false, listener: { protocol: 'HTTP' } });
    });

    test('update-listener moves a running listener to its new port', async () => {
      const newPort = await getFreePort();
      await invoke('update-listener', sftpId, { name: 'IPC SFTP', bindingIp: '127.0.0.1', port: newPort, enabled: true });
      expect((await invoke('get-listener', sftpId)).port).toBe(newPort);
      expect((await invoke('get-listener-status', sftpId)).running).toBe(true);

      await expect(new Promise((resolve, reject) => {
        const sock = net.connect(newPort, '127.0.0.1', () => { sock.end(); resolve(true); });
        sock.on('error', reject);
      })).resolves.toBe(true);
      port = newPort;
    });

    test('stop-listener closes the port', async () => {
      await invoke('stop-listener', sftpId);
      expect((await invoke('get-listener-status', sftpId)).running).toBe(false);
      await expect(new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => { sock.end(); resolve(true); });
        sock.on('error', reject);
      })).rejects.toThrow();
    });

    test('starting an unknown listener fails', async () => {
      await expect(invoke('start-listener', 99999)).rejects.toThrow(/not found/);
    });

    test('delete-listener removes it', async () => {
      const id = await invoke('create-listener', { name: 'Temp FTP', protocol: 'FTP', bindingIp: '127.0.0.1', port: await getFreePort(), enabled: false });
      await invoke('delete-listener', id);
      expect(await invoke('get-listener', id)).toBeUndefined();
    });
  });

  describe('activity log and settings handlers', () => {
    test('count, settings and old-log stats', async () => {
      expect(await invoke('get-activity-count')).toBeGreaterThan(0);
      await invoke('set-setting', 'logRetentionDays', '7');
      expect(await invoke('get-setting', 'logRetentionDays')).toBe('7');
      expect((await invoke('get-all-settings')).logRetentionDays).toBe('7');
      expect(await invoke('get-old-logs-stats', 7)).toEqual({ count: expect.any(Number) });
      expect(await invoke('cleanup-old-activities')).toEqual({ count: expect.any(Number) });
    });

    test('save-activity-log writes the CSV to the chosen file, or reports cancellation', async () => {
      const target = path.join(installDir, 'export.csv');
      electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
      expect(await invoke('save-activity-log', 'a,b\n1,2')).toEqual({ success: true });
      expect(fs.readFileSync(target, 'utf8')).toBe('a,b\n1,2');

      electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
      expect(await invoke('save-activity-log', 'x')).toEqual({ success: false, cancelled: true });
    });

    test('clear-activities-by-date and clear-all-activities report counts', async () => {
      const byDate = await invoke('clear-activities-by-date', new Date(Date.now() + 60_000).toISOString());
      expect(byDate.count).toBeGreaterThan(0);
      await invoke('set-setting', 'probe', '1'); // no activity
      expect(await invoke('clear-all-activities')).toEqual({ count: expect.any(Number) });
      expect(await invoke('get-activity-count')).toBe(0);
    });
  });

  describe('file browser handlers', () => {
    beforeAll(() => {
      fs.mkdirSync(path.join(ftpRoot, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(ftpRoot, 'hello.txt'), 'hi');
      fs.writeFileSync(path.join(installDir, 'config', 'outside.txt'), 'nope');
    });

    test('browse-files lists directories and files with metadata', async () => {
      const { files } = await invoke('browse-files', 'admin', '/');
      const byName = Object.fromEntries(files.map((f: any) => [f.name, f]));
      expect(byName['hello.txt']).toMatchObject({ isDirectory: false, size: 2 });
      expect(byName.sub).toMatchObject({ isDirectory: true });
    });

    test('browse-files refuses to leave the virtual root', async () => {
      await expect(invoke('browse-files', 'admin', '/../../config')).rejects.toThrow(/No access/);
      expect(fs.existsSync(path.join(installDir, 'config', 'outside.txt'))).toBe(true);
    });

    test('download-file copies via the save dialog; refuses traversal and directories', async () => {
      const target = path.join(installDir, 'saved.txt');
      electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
      expect(await invoke('download-file', 'admin', '/hello.txt')).toEqual({ success: true, savedPath: target });
      expect(fs.readFileSync(target, 'utf8')).toBe('hi');

      await expect(invoke('download-file', 'admin', '/../../config/outside.txt')).rejects.toThrow(/No access/);
      await expect(invoke('download-file', 'admin', '/sub')).rejects.toThrow(/not found/);
    });

    test('select-directory returns the chosen folder or null', async () => {
      electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/srv/data'] });
      expect(await invoke('select-directory')).toBe('/srv/data');
      electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await invoke('select-directory')).toBeNull();
    });
  });

  describe('embedded web GUI server handlers', () => {
    const get = (port: number, p: string) => new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, res => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
    });

    test('start → reachable over HTTP → status → stop', async () => {
      const port = await getFreePort();
      expect(await invoke('start-web-server', port)).toEqual({ success: true, port });
      expect(await get(port, '/login')).toBe(200);
      expect(await invoke('get-web-server-status')).toEqual({ running: true, port });
      expect(await invoke('start-web-server', port)).toMatchObject({ success: false, error: expect.stringMatching(/already running/) });

      expect(await invoke('stop-web-server')).toEqual({ success: true });
      expect(await invoke('get-web-server-status')).toEqual({ running: false, port: null });
      expect(await invoke('stop-web-server')).toMatchObject({ success: false });
    });

    test('starting on a port that is already in use fails cleanly instead of hanging', async () => {
      const blocker = net.createServer();
      const port = await new Promise<number>(r => blocker.listen(0, () => r((blocker.address() as net.AddressInfo).port)));
      try {
        const result = await invoke('start-web-server', port);
        expect(result).toMatchObject({ success: false, error: expect.stringMatching(/EADDRINUSE/) });
        expect(await invoke('get-web-server-status')).toEqual({ running: false, port: null });
      } finally {
        blocker.close();
      }
    });
  });

  describe('logout', () => {
    test('logout closes the dashboard, shows the login window and keeps a single tray icon', async () => {
      await invoke('logout');
      expect(await invoke('get-authenticated-user')).toBeNull();
      expect(visibleWindows('index.html')).toHaveLength(0);
      expect(visibleWindows('login.html')).toHaveLength(1);

      await invoke('authenticate-user', 'admin', ADMIN_PW);
      expect(trays).toHaveLength(1);
      const recent = await invoke('get-recent-activities', undefined, 20);
      expect(recent.some((a: any) => a.action === 'GUI_LOGOUT')).toBe(true);
    });
  });
});
