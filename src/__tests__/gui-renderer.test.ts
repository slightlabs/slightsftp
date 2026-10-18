/**
 * @jest-environment jsdom
 *
 * gui-renderer.test.ts — drives the REAL dashboard GUI (src/index.html +
 * src/renderer.js) in jsdom. `require('electron')` is answered with a fake
 * ipcRenderer backed by an in-memory model, so every click / form submission
 * is verified by the exact IPC call it produces and the DOM it renders.
 */
import * as fs from 'fs';
import * as path from 'path';

type Handler = (...args: any[]) => any;

const SRC = path.join(__dirname, '..');
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const XSS = '<img src=x onerror="window.__pwned=true">';

// ─── in-memory backend model ───────────────────────────────────────────────
const model = {
  listeners: [
    { id: 1, name: 'Main SFTP', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 2222, enabled: true },
    { id: 2, name: 'Legacy FTP', protocol: 'FTP', bindingIp: '0.0.0.0', port: 2121, enabled: true },
  ],
  running: new Set<number>([1]),
  webRunning: false,
  users: [
    { id: 1, username: 'admin', passwordEnabled: true, publicKey: '', guiEnabled: true },
    { id: 2, username: 'carol', passwordEnabled: true, publicKey: 'AAAAB3Nza', guiEnabled: false },
  ],
  userListeners: { 2: [1] } as Record<number, number[]>,
  permissions: {
    '2:1': { userId: 2, listenerId: 1, canRead: true, canCreate: true, canEdit: true, canAppend: false, canDelete: false, canList: true, canCreateDir: false, canRename: false },
  } as Record<string, any>,
  virtualPaths: {
    2: [{ id: 10, userId: 2, virtualPath: '/', localPath: '/srv/carol', canRead: true, canWrite: true, canAppend: true, canDelete: false, canList: true, canCreateDir: false, canRename: false, applyToSubdirs: true }],
  } as Record<number, any[]>,
  sessions: [
    { sessionId: 's-1', username: 'carol', protocol: 'SFTP', listenerId: 1, listenerName: 'Main SFTP', ipAddress: '10.0.0.5', connectedAt: new Date(Date.now() - 65_000).toISOString(),
      uploadedBytes: 2 * 1024 * 1024, downloadedBytes: 512,
      transfers: [{ path: `/${XSS}.iso`, direction: 'upload', bytes: 1024 * 1024, startedAt: new Date().toISOString(), bytesPerSecond: 256 * 1024 }] },
  ],
  activities: [
    { id: 1, listenerId: 1, username: 'carol', action: 'UPLOAD', path: `/${XSS}.txt`, success: true, timestamp: nowSql(), bytes: 2048, checksum: 'a'.repeat(64) },
    { id: 2, listenerId: 1, username: 'carol', action: 'LOGIN_FAILED', path: '/', success: false, timestamp: nowSql() },
    { id: 3, listenerId: null, username: 'admin', action: 'GUI_LOGIN', path: '/', success: true, timestamp: nowSql() },
  ],
  settings: { logRetentionDays: '30' } as Record<string, string>,
  adminTotp: false,
  tokens: [] as any[],
  trashSettings: { enabled: true, retentionDays: 30 },
  trash: [
    { id: 1, username: 'carol', virtualPath: `/${XSS}.doc`, size: 4096, deletedAt: new Date().toISOString() },
    { id: 2, username: 'carol', virtualPath: '/old.txt', size: 10, deletedAt: new Date().toISOString() },
  ] as any[],
  webhooks: [] as any[],
  audit: { checksumUploads: true, syslog: { enabled: false, host: '', port: 514, protocol: 'udp', facility: 16 } } as any,
  security: { enabled: true, maxFailures: 5, windowMinutes: 10, banMinutes: 15, allowlist: '127.0.0.0/8, ::1' },
  bans: [{ ip: '203.0.113.9', reason: `5 failed logins in 10 min (last: SFTP as ${XSS})`, bannedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString() }] as any[],
  shares: [
    { id: 7, owner: 'carol', virtualPath: `/${XSS}.pdf`, type: 'download', status: 'active', downloadCount: 1, maxDownloads: 5, expiresAt: null, hasPassword: true },
    { id: 8, owner: 'carol', virtualPath: '/inbox', type: 'upload', status: 'expired', downloadCount: 0, maxDownloads: null, expiresAt: '2026-01-01T00:00:00.000Z', hasPassword: false },
  ] as any[],
  files: {
    '/': [
      { name: 'sub', isDirectory: true, size: 0, mtime: new Date().toISOString() },
      { name: "it's here.txt", isDirectory: false, size: 2048, mtime: new Date().toISOString() },
      { name: `${XSS}.txt`, isDirectory: false, size: 1, mtime: new Date().toISOString() },
    ],
    '/sub': [{ name: 'deep.txt', isDirectory: false, size: 10, mtime: new Date().toISOString() }],
  } as Record<string, any[]>,
};

const backend: Record<string, Handler> = {
  'get-authenticated-user': () => ({ username: 'admin', id: 1, totpEnabled: model.adminTotp }),
  'totp-setup': () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', qrSvg: '<svg id="qr-svg"></svg>' }),
  'totp-enable': (code: string) => { if (code !== '123456') throw new Error("Error invoking remote method 'totp-enable': Error: That code is not valid."); model.adminTotp = true; return { success: true }; },
  'totp-disable': () => { model.adminTotp = false; return { success: true }; },
  'get-server-identity': () => ({ sshHostKeyFingerprint: 'SHA256:abcDEF123' }),
  'get-shares': () => model.shares,
  'get-webhooks': () => model.webhooks,
  'get-security-settings': () => model.security,
  'set-security-settings': (u: any) => { Object.assign(model.security, u); return model.security; },
  'get-ip-bans': () => model.bans,
  'get-api-tokens': () => model.tokens,
  'export-backup': () => ({ success: true, path: '/home/admin/slightsftp-backup.json' }),
  'import-backup': () => ({ success: true, users: 3, listeners: 2, restoredFiles: [] }),
  'create-api-token': (name: string) => { const t = { id: model.tokens.length + 1, name, hint: 'sst_abc123', createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null }; model.tokens.push(t); return { ...t, token: 'sst_abc123SECRET' }; },
  'revoke-api-token': (id: number) => { model.tokens = model.tokens.filter(t => t.id !== id); return { success: true }; },
  'get-trash': () => ({ settings: model.trashSettings, items: model.trash }),
  'set-trash-settings': (u: any) => Object.assign(model.trashSettings, u),
  'restore-trash-item': (id: number) => { model.trash = model.trash.filter(t => t.id !== id); return { success: true }; },
  'purge-trash-item': (id: number) => { model.trash = model.trash.filter(t => t.id !== id); return { success: true }; },
  'empty-trash': () => { const count = model.trash.length; model.trash = []; return { success: true, count }; },
  'get-audit-settings': () => model.audit,
  'set-audit-settings': (u: any) => { model.audit = { ...model.audit, ...u, syslog: { ...model.audit.syslog, ...(u.syslog || {}) } }; return model.audit; },
  'test-syslog': () => ({ ok: false, error: 'connect ECONNREFUSED' }),
  'unban-ip': (ip: string) => { model.bans = model.bans.filter(b => b.ip !== ip); return { success: true }; },
  'create-webhook': (h: any) => { const hook = { id: model.webhooks.length + 1, enabled: true, lastStatus: null, hasSecret: !!h.secret, ...h }; model.webhooks.push(hook); return hook; },
  'update-webhook': (id: number, u: any) => { Object.assign(model.webhooks.find(h => h.id === id)!, u); return model.webhooks.find(h => h.id === id); },
  'delete-webhook': (id: number) => { model.webhooks = model.webhooks.filter(h => h.id !== id); return { success: true }; },
  'test-webhook': () => ({ ok: true, status: 200, attempts: 1 }),
  'revoke-share': (id: number) => { model.shares.find(x => x.id === id)!.status = 'revoked'; return { success: true }; },
  'logout': () => ({ success: true }),
  'get-all-listener-statuses': () => [
    ...model.listeners.map(l => ({ listener: l, running: model.running.has(l.id) })),
    { listener: { id: -1, name: 'Web GUI Server', protocol: 'HTTP', bindingIp: '0.0.0.0', port: 3000, enabled: true }, running: model.webRunning },
  ],
  'get-all-listeners': () => model.listeners,
  'get-listener': (id: number) => model.listeners.find(l => l.id === id),
  'create-listener': (l: any) => { const id = model.listeners.length + 1; model.listeners.push({ ...l, id }); return id; },
  'update-listener': (id: number, u: any) => { Object.assign(model.listeners.find(l => l.id === id)!, u); },
  'delete-listener': (id: number) => { model.listeners = model.listeners.filter(l => l.id !== id); },
  'start-listener': (id: number) => { model.running.add(id); },
  'stop-listener': (id: number) => { model.running.delete(id); },
  'get-web-server-status': () => ({ running: model.webRunning, port: model.webRunning ? 3000 : null }),
  'start-web-server': (port?: number) => { model.webRunning = true; return { success: true, port: port || 3000 }; },
  'stop-web-server': () => { model.webRunning = false; return { success: true }; },
  'get-all-users': () => model.users,
  'get-user': (u: string) => model.users.find(x => x.username === u),
  'create-user': (u: any) => { model.users.push({ ...u, id: model.users.length + 1 }); return model.users.length; },
  'update-user': () => undefined,
  'delete-user': (u: string) => { model.users = model.users.filter(x => x.username !== u); },
  'get-user-listeners': (id: number) => model.userListeners[id] || [],
  'get-user-usage': () => ({ usedBytes: 5 * 1024 * 1024, quotaBytes: 10 * 1024 * 1024 }),
  'get-virtual-paths': (id: number) => (model.virtualPaths[id] || []).map(v => ({ ...v })),
  'get-permission': (u: number, l: number) => model.permissions[`${u}:${l}`],
  'select-directory': () => '/picked/folder',
  'get-active-sessions': () => model.sessions,
  'disconnect-session': (id: string) => { const before = model.sessions.length; model.sessions = model.sessions.filter(s => s.sessionId !== id); return model.sessions.length < before; },
  'get-recent-activities': () => model.activities,
  'get-activity-count': () => model.activities.length,
  'get-all-settings': () => model.settings,
  'set-setting': (k: string, v: string) => { model.settings[k] = v; },
  'get-old-logs-stats': () => ({ count: 4 }),
  'cleanup-old-activities': () => ({ count: 4 }),
  'clear-all-activities': () => { const count = model.activities.length; model.activities = []; return { count }; },
  'clear-activities-by-date': () => ({ count: 2 }),
  'save-activity-log': () => ({ success: true }),
  'browse-files': (_u: string, p: string) => {
    if (!model.files[p]) throw new Error('Path not found');
    return { files: model.files[p] };
  },
  'download-file': (_u: string, p: string) => ({ success: true, savedPath: `/home/admin/Downloads${p}` }),
};

const ipcRenderer = {
  invoke: jest.fn(async (channel: string, ...args: any[]) => {
    const handler = backend[channel];
    if (!handler) throw new Error(`Unknown IPC channel: ${channel}`);
    return handler(...args);
  }),
  on: jest.fn(),
};

// ─── helpers ───────────────────────────────────────────────────────────────
const realSetImmediate: (cb: () => void) => void = jest.requireActual('timers').setImmediate;
const flush = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise<void>(r => realSetImmediate(r)); };
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];
const calls = (channel: string) => ipcRenderer.invoke.mock.calls.filter(([c]) => c === channel).map(([, ...a]) => a);
const lastCall = (channel: string) => calls(channel).at(-1);
const buttonByText = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll('button')).find(b => b.textContent!.trim() === text) as HTMLButtonElement;
const openPanel = async (panel: string) => { $(`.sidebar-item[data-panel="${panel}"]`).click(); await flush(); };
const setField = (form: HTMLFormElement, name: string, value: string | boolean) => {
  const el = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
  if (typeof value === 'boolean') el.checked = value; else el.value = value;
};
const submit = async (form: HTMLFormElement) => {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
};

// ─── bootstrap the real page ───────────────────────────────────────────────
beforeAll(async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

  // jsdom has no canvas implementation: give the activity chart a no-op 2D context
  const noop = () => undefined;
  const ctx = new Proxy({}, { get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true });
  (HTMLCanvasElement.prototype as any).getContext = () => ctx;

  (window as any).alert = jest.fn();
  (window as any).confirm = jest.fn(() => true);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn().mockResolvedValue(undefined) }, configurable: true });
  (window as any).require = (mod: string) => {
    if (mod === 'electron') return { ipcRenderer };
    throw new Error(`Cannot find module '${mod}'`);
  };

  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<script src="renderer\.js"><\/script>/, '');

  const script = document.createElement('script');
  script.textContent = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8');
  document.body.appendChild(script);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window.dispatchEvent(new Event('DOMContentLoaded'));
  await flush();
});

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

beforeEach(() => {
  (window.alert as jest.Mock).mockClear();
  (window.confirm as jest.Mock).mockClear().mockReturnValue(true);
});

// ─── tests ─────────────────────────────────────────────────────────────────
describe('Dashboard GUI (index.html + renderer.js)', () => {
  test('page script only uses IPC channels the backend knows', () => {
    const unknown = ipcRenderer.invoke.mock.calls.map(([c]) => c).filter(c => !backend[c]);
    expect(unknown).toEqual([]);
  });

  describe('dashboard panel', () => {
    test('shows the signed-in user', () => {
      expect($('#currentUser').textContent).toBe('admin');
    });

    test('renders user, session and listener statistics', () => {
      expect($('#totalUsersCount').textContent).toBe('2');
      expect($('#activeSessionsCount').textContent).toBe('1');
      expect($('#activeUsersCount').textContent).toBe('1');
      const overview = $('#server-overview').textContent!.replace(/\s+/g, ' ');
      expect(overview).toContain('3 Total Listeners');
      expect(overview).toContain('1 Running');
      expect(overview).toContain('2 Stopped');
      expect($('#active-listeners').textContent).toContain('Main SFTP');
      expect($('#active-listeners').textContent).not.toContain('Legacy FTP');
    });

    test('renders recent activity with success / error styling and listener names', () => {
      const items = $$('#dashboard-activity .activity-item');
      expect(items).toHaveLength(3);
      expect(items[1].classList.contains('activity-error')).toBe(true);
      expect(items[2].textContent).toContain('[Admin GUI] admin: GUI_LOGIN');
    });

    test('shows transfers in progress with speed', () => {
      const live = $('#live-transfers').textContent!.replace(/\s+/g, ' ');
      expect(live).toContain(`carol /${XSS}.iso — 1 MB at 256 KB/s (SFTP)`);
      expect($('#live-transfers').querySelector('img')).toBeNull();
    });

    test('activity paths are rendered as text, never as HTML (no script injection)', () => {
      const upload = $$('#dashboard-activity .activity-item')[0];
      expect(upload.querySelector('img')).toBeNull();
      expect(upload.textContent).toContain(XSS);
      expect(upload.textContent).toContain('(2 KB) sha256:aaaaaaaaaaaa…');
      expect((window as any).__pwned).toBeUndefined();
    });

    test('auto-refreshes when the main process pushes an activity update', async () => {
      const handler = ipcRenderer.on.mock.calls.find(([ch]) => ch === 'activity-update')![1];
      const before = calls('get-active-sessions').length;
      handler();
      await flush();
      expect(calls('get-active-sessions').length).toBeGreaterThan(before);
    });

    test('the activity chart polls every second', async () => {
      const before = calls('get-recent-activities').length;
      jest.advanceTimersByTime(3000);
      await flush();
      expect(calls('get-recent-activities').length).toBeGreaterThanOrEqual(before + 3);
    });
  });

  describe('theme', () => {
    test('the toggle cycles system → dark → light → system and remembers the choice', () => {
      const html = document.documentElement;
      expect(html.dataset.theme).toBeUndefined();
      $('#themeBtn').click();
      expect(html.dataset.theme).toBe('dark');
      expect(localStorage.getItem('slightsftp-theme')).toBe('dark');
      $('#themeBtn').click();
      expect(html.dataset.theme).toBe('light');
      $('#themeBtn').click();
      expect(html.dataset.theme).toBeUndefined();
      expect(localStorage.getItem('slightsftp-theme')).toBeNull();
      expect($('#themeBtn').title).toBe('Theme: follow system');
    });
  });

  describe('navigation', () => {
    test.each(['listeners', 'sessions', 'users', 'files', 'shares', 'webhooks', 'security', 'trash', 'activity', 'dashboard'])('sidebar switches to the %s panel', async panel => {
      await openPanel(panel);
      expect($$('.panel.active').map(p => p.id)).toEqual([panel]);
      expect($$('.sidebar-item.active').map(i => i.dataset.panel)).toEqual([panel]);
    });
  });

  describe('listeners panel', () => {
    beforeAll(() => openPanel('listeners'));

    const card = (name: string) => $$('#listeners-list .listener-card').find(c => c.querySelector('h3')!.textContent === name)!;

    test('lists every listener plus the Web GUI server with status and actions', () => {
      const names = $$('#listeners-list .listener-card h3').map(h => h.textContent);
      expect(names).toEqual(['Main SFTP', 'Legacy FTP', 'Web GUI Server']);
      expect(card('Main SFTP').textContent).toContain('Running');
      expect(card('Main SFTP').textContent).toContain('0.0.0.0:2222');
      expect(buttonByText(card('Main SFTP'), 'Stop')).toBeTruthy();
      expect(buttonByText(card('Legacy FTP'), 'Start')).toBeTruthy();
      expect(card('Web GUI Server').textContent).toContain('Security Note');
      expect(card('Main SFTP').textContent).toContain('Host key: SHA256:abcDEF123');
      expect(card('Legacy FTP').textContent).not.toContain('Host key');
    });

    test('Start / Stop buttons call the matching IPC and refresh the card', async () => {
      buttonByText(card('Legacy FTP'), 'Start').click();
      await flush();
      expect(lastCall('start-listener')).toEqual([2]);
      expect(buttonByText(card('Legacy FTP'), 'Stop')).toBeTruthy();

      buttonByText(card('Legacy FTP'), 'Stop').click();
      await flush();
      expect(lastCall('stop-listener')).toEqual([2]);
      expect(buttonByText(card('Legacy FTP'), 'Start')).toBeTruthy();
    });

    test('Add Listener modal submits a typed listener and closes', async () => {
      buttonByText($('#listeners'), 'Add Listener').click();
      expect($('#addListenerModal').classList.contains('active')).toBe(true);

      const form = $<HTMLFormElement>('#addListenerForm');
      setField(form, 'name', 'Partner SFTP');
      const protocol = form.querySelector('[name=protocol]') as HTMLSelectElement;
      protocol.value = 'SFTP';
      protocol.dispatchEvent(new Event('change'));
      expect((form.querySelector('[data-ftp-only]') as HTMLElement).style.display).toBe('none');
      setField(form, 'bindingIp', '127.0.0.1');
      setField(form, 'port', '2022');
      setField(form, 'enabled', false);
      await submit(form);

      expect(lastCall('create-listener')).toEqual([{ name: 'Partner SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2022, enabled: false, tlsMode: 'none' }]);
      expect($('#addListenerModal').classList.contains('active')).toBe(false);
      expect(card('Partner SFTP')).toBeTruthy();
    });

    test('Edit Port pre-fills the form and saves the change for the right listener', async () => {
      buttonByText(card('Legacy FTP'), 'Edit Port').click();
      await flush();
      const form = $<HTMLFormElement>('#editListenerForm');
      expect($('#editListenerModal').classList.contains('active')).toBe(true);
      expect((form.querySelector('[name=id]') as HTMLInputElement).value).toBe('2');
      expect((form.querySelector('[name=name]') as HTMLInputElement).value).toBe('Legacy FTP');
      expect((form.querySelector('[name=port]') as HTMLInputElement).value).toBe('2121');

      expect((form.querySelector('[data-ftp-only]') as HTMLElement).style.display).toBe('');
      setField(form, 'port', '2100');
      (form.querySelector('[name=tlsMode]') as HTMLSelectElement).value = 'required';
      await submit(form);
      expect(lastCall('update-listener')).toEqual([2, { name: 'Legacy FTP', bindingIp: '0.0.0.0', port: 2100, enabled: true, tlsMode: 'required' }]);
      expect(card('Legacy FTP').textContent).toContain('FTPS (TLS required)');
      expect(card('Legacy FTP').textContent).toContain('0.0.0.0:2100');
    });

    test('Delete asks for confirmation and does nothing when cancelled', async () => {
      (window.confirm as jest.Mock).mockReturnValueOnce(false);
      buttonByText(card('Partner SFTP'), 'Delete').click();
      await flush();
      expect(calls('delete-listener')).toHaveLength(0);

      buttonByText(card('Partner SFTP'), 'Delete').click();
      await flush();
      expect(lastCall('delete-listener')).toEqual([3]);
      expect(card('Partner SFTP')).toBeUndefined();
    });

    test('Web GUI server can be started from the desktop app', async () => {
      buttonByText(card('Web GUI Server'), 'Start').click();
      await flush();
      expect(calls('start-web-server')).toHaveLength(1);
      expect((window.alert as jest.Mock).mock.calls[0][0]).toMatch(/started successfully on port 3000/);
      expect(card('Web GUI Server').textContent).toContain('http://localhost:3000');
    });
  });

  describe('web GUI server settings', () => {
    beforeAll(() => openPanel('listeners'));
    const webCard = () => $$('#listeners-list .listener-card').find(c => c.querySelector('h3')!.textContent === 'Web GUI Server')!;

    test('a plain-HTTP web server shows the security warning', () => {
      expect(webCard().textContent).toContain('passwords travel unencrypted');
    });

    test('Edit Port with "Use HTTPS" saves the setting and restarts on the new port', async () => {
      buttonByText(webCard(), 'Edit Port').click();
      await flush();
      jest.advanceTimersByTime(200);
      expect($('#editWebPortModal').classList.contains('active')).toBe(true);
      expect($<HTMLInputElement>('#webServerHttps').checked).toBe(false);

      $<HTMLInputElement>('#webServerHttps').checked = true;
      $<HTMLInputElement>('#webServerPort').value = '3443';
      backend['start-web-server'] = (port?: number) => { model.webRunning = true; return { success: true, port, https: true, url: `https://localhost:${port}` }; };
      await submit($<HTMLFormElement>('#editWebPortForm'));

      expect(lastCall('set-setting')).toEqual(['webHttps', 'true']);
      expect(calls('stop-web-server').length).toBeGreaterThan(0);
      expect(lastCall('start-web-server')).toEqual([3443]);
      expect((window.alert as jest.Mock).mock.calls.at(-1)[0]).toContain('https://localhost:3443');
    });
  });

  describe('users panel', () => {
    beforeAll(() => openPanel('users'));

    const row = (username: string) => $$('#users-table tbody tr').find(r => r.children[0].textContent === username)!;

    test('lists users with auth flags; admin cannot be deleted', () => {
      expect($$('#users-table tbody tr')).toHaveLength(2);
      expect(Array.from(row('carol').children).slice(1, 4).map(c => c.textContent)).toEqual(['✓', '✓', '✗']);
      expect(buttonByText(row('admin'), 'Delete')).toBeUndefined();
      expect(buttonByText(row('carol'), 'Delete')).toBeTruthy();
    });

    test('Add User submits the form values', async () => {
      buttonByText($('#users'), 'Add User').click();
      const form = $<HTMLFormElement>('#addUserForm');
      setField(form, 'username', 'dave');
      setField(form, 'password', 'p@ss');
      setField(form, 'guiEnabled', true);
      setField(form, 'mustChangePassword', true);
      await submit(form);
      expect(lastCall('create-user')).toEqual([{ username: 'dave', password: 'p@ss', passwordEnabled: true, publicKey: undefined, guiEnabled: true, mustChangePassword: true, portalEnabled: false, allowedIps: '', quotaMb: '', uploadLimitKBps: '', downloadLimitKBps: '' }]);
      expect(row('dave')).toBeTruthy();
    });

    test('usernames are rendered as text', async () => {
      model.users.push({ id: 99, username: XSS, passwordEnabled: false, publicKey: '', guiEnabled: false });
      await openPanel('users');
      expect($('#users-table').querySelector('img')).toBeNull();
      expect(row(XSS)).toBeTruthy();
      model.users.pop();
      await openPanel('users');
    });

    describe('Edit User dialog', () => {
      beforeAll(async () => {
        buttonByText(row('carol'), 'Edit').click();
        await flush();
      });

      test('opens pre-filled with the user, listener subscriptions and permissions', () => {
        expect($('#editUserModal').classList.contains('active')).toBe(true);
        const form = $<HTMLFormElement>('#editUserForm');
        expect((form.querySelector('[name=username]') as HTMLInputElement).value).toBe('carol');
        expect((form.querySelector('[name=publicKey]') as HTMLTextAreaElement).value).toBe('AAAAB3Nza');
        expect($<HTMLInputElement>('#listener-1').checked).toBe(true);
        expect($<HTMLInputElement>('#listener-2').checked).toBe(false);
        expect($('#permissions-2').style.display).toBe('none');
        expect($<HTMLInputElement>('#perm-1-canRead').checked).toBe(true);
        expect($<HTMLInputElement>('#perm-1-canCreate').checked).toBe(true);
        expect($<HTMLInputElement>('#perm-1-canDelete').checked).toBe(false);
        expect($('#virtualPathsList').textContent).toContain('/srv/carol');
        expect($('#editUserForm .quota-usage').textContent).toBe('Currently using 5 MB of 10 MB');
      });

      test('ticking a listener reveals its permission grid', () => {
        $<HTMLInputElement>('#listener-2').click();
        expect($('#permissions-2').style.display).toBe('block');
      });

      test('"Read Only" preset leaves only read + list ticked', () => {
        buttonByText($('#permissions-2'), 'Read Only').click();
        const ticked = $$('#permissions-2 input[type=checkbox]').filter(c => (c as HTMLInputElement).checked).map(c => c.id);
        expect(ticked.sort()).toEqual(['perm-2-canList', 'perm-2-canRead']);
      });

      test('virtual paths can be added (with folder picker), edited and removed', async () => {
        buttonByText($('#editUserModal'), 'Add Virtual Path').click();
        expect($('#virtualPathModal').classList.contains('active')).toBe(true);
        $<HTMLInputElement>('#vpVirtualPath').value = '/shared';
        buttonByText($('#virtualPathModal'), 'Browse...').click();
        await flush();
        expect($<HTMLInputElement>('#vpRealPath').value).toBe('/picked/folder');
        $<HTMLInputElement>('#vpCanDelete').checked = true;
        await submit($<HTMLFormElement>('#virtualPathForm'));
        expect($('#virtualPathsList').textContent).toContain('/shared');

        const items = () => $$('#virtualPathsList .virtual-path-item');
        buttonByText(items()[0], 'Edit').click();
        expect($<HTMLInputElement>('#vpVirtualPath').value).toBe('/');
        $<HTMLInputElement>('#vpCanWrite').checked = false;
        await submit($<HTMLFormElement>('#virtualPathForm'));
        expect(items()[0].textContent).not.toMatch(/Write/);

        model.virtualPaths[2].push({ id: 11, userId: 2, virtualPath: '/tmp-remove', localPath: '/x' });
      });

      test('saving sends subscriptions, per-listener permissions and virtual paths', async () => {
        // turn "List Directories" OFF for listener 1 — this must be honoured
        $<HTMLInputElement>('#perm-1-canList').checked = false;
        const form = $<HTMLFormElement>('#editUserForm');
        setField(form, 'password', 'n3w');
        await submit(form);

        const [username, updates, listeners, vps, perms] = lastCall('update-user')!;
        expect(username).toBe('carol');
        expect(updates).toEqual({ password: 'n3w', passwordEnabled: true, publicKey: 'AAAAB3Nza', guiEnabled: false, mustChangePassword: false, portalEnabled: false, allowedIps: '', quotaMb: '', uploadLimitKBps: '', downloadLimitKBps: '' });
        expect(listeners).toEqual([1, 2]);

        const p1 = perms.find((p: any) => p.listenerId === 1);
        const p2 = perms.find((p: any) => p.listenerId === 2);
        expect(p1).toMatchObject({ userId: 2, canRead: true, canCreate: true, canEdit: true, canList: false, canDelete: false });
        expect(p2).toMatchObject({ canRead: true, canList: true, canCreate: false, canEdit: false, canDelete: false });

        expect(vps.map((v: any) => v.virtualPath)).toEqual(['/', '/shared']);
        expect(vps[0]).toMatchObject({ localPath: '/srv/carol', canWrite: false });
        expect(vps[1]).toMatchObject({ localPath: '/picked/folder', canDelete: true, userId: 2 });
        expect($('#editUserModal').classList.contains('active')).toBe(false);
      });
    });

    test('Delete user confirms then removes the row', async () => {
      buttonByText(row('dave'), 'Delete').click();
      await flush();
      expect((window.confirm as jest.Mock).mock.calls[0][0]).toContain('dave');
      expect(lastCall('delete-user')).toEqual(['dave']);
      expect(row('dave')).toBeUndefined();
    });
  });

  describe('security panel', () => {
    beforeAll(() => openPanel('security'));

    test('shows the protection settings and current bans (reasons as text)', () => {
      const f = $<HTMLFormElement>('#securitySettingsForm').elements as any;
      expect(f.namedItem('enabled').checked).toBe(true);
      expect(f.namedItem('maxFailures').value).toBe('5');
      expect(f.namedItem('allowlist').value).toBe('127.0.0.0/8, ::1');
      const row = $$('#bans-table tr')[0];
      expect(row.textContent).toContain('203.0.113.9');
      expect(row.querySelector('img')).toBeNull();
    });

    test('backup and restore buttons', async () => {
      buttonByText($('#security'), 'Download backup').click();
      await flush();
      expect(calls('export-backup')).toHaveLength(1);
      expect((window.alert as jest.Mock).mock.calls.at(-1)[0]).toBe('Backup saved to /home/admin/slightsftp-backup.json');

      (window.confirm as jest.Mock).mockReturnValueOnce(false);
      buttonByText($('#security'), 'Restore from backup…').click();
      await flush();
      expect(calls('import-backup')).toHaveLength(0);
      buttonByText($('#security'), 'Restore from backup…').click();
      await flush();
      expect(calls('import-backup')).toHaveLength(1);
      expect((window.alert as jest.Mock).mock.calls.at(-1)[0]).toBe('Restored 3 user(s) and 2 listener(s).');
    });

    test('API tokens: create shows the token once; revoke removes it', async () => {
      expect($('#api-tokens-table').textContent).toContain('No tokens');
      const f = $<HTMLFormElement>('#apiTokenForm');
      (f.elements as any).namedItem('name').value = `CI ${XSS}`;
      await submit(f);
      expect(lastCall('create-api-token')).toEqual([`CI ${XSS}`, '90']);
      expect($('#newApiTokenValue').textContent).toBe('sst_abc123SECRET');
      expect($('#api-tokens-table').textContent).toContain('sst_abc123…');
      expect($('#api-tokens-table').textContent).not.toContain('SECRET');
      expect($('#api-tokens-table').querySelector('img')).toBeNull();
      buttonByText($$('#api-tokens-table tr')[0], 'Revoke').click();
      await flush();
      expect(lastCall('revoke-api-token')).toEqual([1]);
    });

    test('audit export settings load, save and test', async () => {
      const f = $<HTMLFormElement>('#auditSettingsForm');
      expect((f.elements as any).namedItem('checksumUploads').checked).toBe(true);
      expect((f.elements as any).namedItem('syslogPort').value).toBe('514');
      (f.elements as any).namedItem('syslogEnabled').checked = true;
      (f.elements as any).namedItem('syslogHost').value = 'siem.example.com';
      (f.elements as any).namedItem('syslogProtocol').value = 'tcp';
      await submit(f);
      expect(lastCall('set-audit-settings')).toEqual([{ checksumUploads: true, syslog: { enabled: true, host: 'siem.example.com', port: 514, protocol: 'tcp', facility: 16 } }]);
      buttonByText(f, 'Send test message').click();
      await flush();
      expect((window.alert as jest.Mock).mock.calls.at(-1)[0]).toBe('Could not send: connect ECONNREFUSED');
    });

    test('saving sends typed settings; Unban removes the row', async () => {
      const f = $<HTMLFormElement>('#securitySettingsForm');
      (f.elements as any).namedItem('maxFailures').value = '8';
      (f.elements as any).namedItem('allowlist').value = '10.0.0.0/8';
      await submit(f);
      expect(lastCall('set-security-settings')).toEqual([{ enabled: true, maxFailures: 8, windowMinutes: 10, banMinutes: 15, allowlist: '10.0.0.0/8' }]);

      buttonByText($$('#bans-table tr')[0], 'Unban').click();
      await flush();
      expect(lastCall('unban-ip')).toEqual(['203.0.113.9']);
      expect($('#bans-table').textContent).toContain('No banned addresses');
    });
  });

  describe('recycle bin panel', () => {
    beforeAll(() => openPanel('trash'));

    test('lists deleted files (names as text) and restores / purges them', async () => {
      const rows = () => $$('#trash-table tr');
      expect(rows()).toHaveLength(2);
      expect(rows()[0].textContent).toContain('4 KB');
      expect($('#trash-table').querySelector('img')).toBeNull();

      buttonByText(rows()[0], 'Restore').click();
      await flush();
      expect(lastCall('restore-trash-item')).toEqual([1]);
      expect(rows()).toHaveLength(1);

      buttonByText(rows()[0], 'Delete forever').click();
      await flush();
      expect(lastCall('purge-trash-item')).toEqual([2]);
      expect($('#trash-table').textContent).toContain('The recycle bin is empty');
    });

    test('settings are saved', async () => {
      const f = $<HTMLFormElement>('#trashSettingsForm');
      expect((f.elements as any).namedItem('retentionDays').value).toBe('30');
      (f.elements as any).namedItem('retentionDays').value = '14';
      await submit(f);
      expect(lastCall('set-trash-settings')).toEqual([{ enabled: true, retentionDays: 14 }]);
    });
  });

  describe('webhooks panel', () => {
    beforeAll(() => openPanel('webhooks'));

    test('starts empty and Add Webhook creates one from the form', async () => {
      expect($('#webhooks-table').textContent).toContain('No webhooks yet');
      buttonByText($('#webhooks'), 'Add Webhook').click();
      const form = $<HTMLFormElement>('#addWebhookForm');
      setField(form, 'name', `Notify ${XSS}`);
      setField(form, 'url', 'https://hooks.example.com/abc');
      $<HTMLInputElement>('#wh-delete').checked = true;
      setField(form, 'pathPrefix', '/incoming');
      (form.querySelector('[name=format]') as HTMLSelectElement).value = 'json';
      setField(form, 'secret', 'shh');
      await submit(form);

      expect(lastCall('create-webhook')).toEqual([{ name: `Notify ${XSS}`, url: 'https://hooks.example.com/abc', events: ['upload', 'delete'], usernameFilter: '', pathPrefix: '/incoming', format: 'json', secret: 'shh' }]);
      const row = $$('#webhooks-table tr')[0];
      expect(row.textContent).toContain('Upload, Delete');
      expect(row.textContent).toContain('under /incoming');
      expect(row.querySelector('img')).toBeNull();
    });

    test('Test, enable/disable and Delete', async () => {
      buttonByText($$('#webhooks-table tr')[0], 'Test').click();
      await flush();
      expect(lastCall('test-webhook')).toEqual([1]);
      expect((window.alert as jest.Mock).mock.calls[0][0]).toBe('Test event delivered (HTTP 200).');

      const toggle = $$('#webhooks-table tr')[0].querySelector('input[type=checkbox]') as HTMLInputElement;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await flush();
      expect(lastCall('update-webhook')).toEqual([1, { enabled: false }]);

      buttonByText($$('#webhooks-table tr')[0], 'Delete').click();
      await flush();
      expect(lastCall('delete-webhook')).toEqual([1]);
      expect($('#webhooks-table').textContent).toContain('No webhooks yet');
    });
  });

  describe('two-factor sign-in', () => {
    test('setting up shows the QR code and key, and a valid code turns it on', async () => {
      buttonByText(document.body, '🔐 2FA').click();
      await flush();
      expect($('#twoFactorModal').classList.contains('active')).toBe(true);
      expect($('#twoFactorOff').style.display).toBe('block');
      buttonByText($('#twoFactorOff'), 'Set up').click();
      await flush();
      expect($('#twoFactorQr').querySelector('#qr-svg')).toBeTruthy();
      expect($('#twoFactorSecret').textContent).toBe('JBSWY3DPEHPK3PXP');

      $<HTMLInputElement>('#twoFactorCode').value = '000000';
      buttonByText($('#twoFactorSetup'), 'Turn on').click();
      await flush();
      expect((window.alert as jest.Mock).mock.calls.at(-1)[0]).toBe('That code is not valid.'); // IPC wrapper stripped

      $<HTMLInputElement>('#twoFactorCode').value = '123456';
      buttonByText($('#twoFactorSetup'), 'Turn on').click();
      await flush();
      expect(lastCall('totp-enable')).toEqual(['123456']);
      expect($('#twoFactorModal').classList.contains('active')).toBe(false);
    });

    test('when on, the dialog offers to turn it off with a code', async () => {
      buttonByText(document.body, '🔐 2FA').click();
      await flush();
      expect($('#twoFactorOn').style.display).toBe('block');
      $<HTMLInputElement>('#twoFactorDisableCode').value = '222333';
      buttonByText($('#twoFactorOn'), 'Turn off').click();
      await flush();
      expect(lastCall('totp-disable')).toEqual(['222333']);
    });

    test('admins can reset a user\'s 2FA from Edit User (but not turn it on)', async () => {
      await openPanel('users');
      const user = model.users.find(u => u.username === 'carol')! as any;
      user.totpEnabled = false;
      buttonByText($$('#users-table tbody tr').find(r => r.children[0].textContent!.startsWith('carol'))!, 'Edit').click();
      await flush();
      const box = $<HTMLFormElement>('#editUserForm').elements.namedItem('totpEnabled') as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(true);
      closeEdit();

      user.totpEnabled = true;
      buttonByText($$('#users-table tbody tr').find(r => r.children[0].textContent!.startsWith('carol'))!, 'Edit').click();
      await flush();
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(false);
      box.checked = false;
      await submit($<HTMLFormElement>('#editUserForm'));
      expect(lastCall('update-user')![1]).toMatchObject({ totpEnabled: false });
      user.totpEnabled = false;
    });

    function closeEdit() { ($('#editUserModal .close-btn') as HTMLElement).click(); }
  });

  describe('shared links panel', () => {
    beforeAll(() => openPanel('shares'));

    test('lists every link with status, usage and expiry; paths are text', () => {
      const rows = $$('#shares-table tr');
      expect(rows).toHaveLength(2);
      const first = Array.from(rows[0].children).map(c => c.textContent!.trim());
      expect(first.slice(0, 5)).toEqual(['carol', `/${XSS}.pdf 🔒`, 'Download', 'active', '1 / 5']);
      expect(first[5]).toBe('Never');
      expect($('#shares-table').querySelector('img')).toBeNull();
      expect(buttonByText(rows[1], 'Revoke')).toBeUndefined(); // expired
    });

    test('Revoke asks for confirmation and updates the row', async () => {
      buttonByText($$('#shares-table tr')[0], 'Revoke').click();
      await flush();
      expect(lastCall('revoke-share')).toEqual([7]);
      expect($$('#shares-table tr')[0].textContent).toContain('revoked');
    });
  });

  describe('active sessions panel', () => {
    beforeAll(() => openPanel('sessions'));

    test('shows session details including duration', () => {
      const cells = Array.from($$('#sessions-table tr')[0].children).map(c => c.textContent!.trim());
      expect(cells.slice(0, 4)).toEqual(['carol', 'SFTP', 'Main SFTP', '10.0.0.5']);
      expect(cells[5]).toMatch(/^1m \d+s$/);
      expect(cells[6]).toContain('↑ 2 MB ↓ 512 Bytes');
      expect(cells[6]).toContain(`⬆ /${XSS}.iso — 1 MB at 256 KB/s`);
    });

    test('Disconnect confirms, calls IPC and shows the empty state', async () => {
      buttonByText($('#sessions-table'), 'Disconnect').click();
      await flush();
      expect(lastCall('disconnect-session')).toEqual(['s-1']);
      expect((window.alert as jest.Mock).mock.calls[0][0]).toContain('carol');
      expect($('#sessions-table').textContent).toContain('No active sessions');
    });

    test('refreshes every 5 seconds while visible', async () => {
      const before = calls('get-active-sessions').length;
      jest.advanceTimersByTime(5000);
      await flush();
      expect(calls('get-active-sessions').length).toBeGreaterThan(before);
    });
  });

  describe('file browser panel', () => {
    beforeAll(async () => {
      await openPanel('files');
      const select = $<HTMLSelectElement>('#fileBrowserUser');
      select.value = 'carol';
      select.dispatchEvent(new Event('change'));
      await flush();
    });

    const fileItem = (name: string) => $$('#fileList .file-item').find(i => i.querySelector('.file-name')!.textContent === name)!;

    test('user selector lists all users and loads the root listing', () => {
      expect(Array.from($<HTMLSelectElement>('#fileBrowserUser').options).map(o => o.value)).toEqual(['', 'admin', 'carol']);
      expect(lastCall('browse-files')).toEqual(['carol', '/']);
      expect($('#fileBrowserContent').style.display).toBe('block');
      expect(fileItem("it's here.txt").textContent).toContain('2 KB');
    });

    test('file names are rendered as text', () => {
      expect($('#fileList').querySelector('img')).toBeNull();
      expect(fileItem(`${XSS}.txt`)).toBeTruthy();
    });

    test('files whose names contain quotes can still be downloaded', async () => {
      buttonByText(fileItem("it's here.txt"), 'Download').click();
      await flush();
      expect(lastCall('download-file')).toEqual(['carol', "/it's here.txt"]);
      expect((window.alert as jest.Mock).mock.calls[0][0]).toContain('/home/admin/Downloads');
    });

    test('opening a folder updates the breadcrumb; clicking Root goes back', async () => {
      buttonByText(fileItem('sub'), 'Open').click();
      await flush();
      expect(lastCall('browse-files')).toEqual(['carol', '/sub']);
      expect($('#fileBreadcrumb').textContent).toContain('sub');

      buttonByText(fileItem('deep.txt'), 'Download').click();
      await flush();
      expect(lastCall('download-file')).toEqual(['carol', '/sub/deep.txt']);

      ($('#fileBreadcrumb .breadcrumb-item') as HTMLElement).click();
      await flush();
      expect(lastCall('browse-files')).toEqual(['carol', '/']);
    });

    test('backend errors are surfaced to the user', async () => {
      await (window as any).browsePath('/missing');
      expect((window.alert as jest.Mock).mock.calls[0][0]).toMatch(/Failed to browse path: Path not found/);
    });
  });

  describe('activity log panel', () => {
    beforeAll(() => openPanel('activity'));

    test('shows entries, total count and retention', () => {
      expect($$('#full-activity-log .activity-item')).toHaveLength(3);
      expect($('#activityCount').textContent).toBe('3');
      expect($('#logRetentionDisplay').textContent).toBe('30');
      expect($('#full-activity-log').querySelector('img')).toBeNull();
    });

    test('Copy puts a readable log on the clipboard', async () => {
      buttonByText($('#activity'), '📋 Copy').click();
      await flush();
      const text = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0];
      expect(text.split('\n')).toHaveLength(3);
      expect(text).toContain('[Main SFTP] carol: UPLOAD');
    });

    test('Save exports CSV with escaped values', async () => {
      buttonByText($('#activity'), '💾 Save').click();
      await flush();
      const [csv] = lastCall('save-activity-log')!;
      expect(csv.split('\n')[0]).toBe('Timestamp,Listener,Username,Action,Path,Success,Bytes,SHA256');
      expect(csv).toContain('"Main SFTP","carol","UPLOAD"');
      expect(csv).toContain(`"/${XSS.replace(/"/g, '""')}.txt"`);
    });

    test('log settings show old-log stats and save the retention period', async () => {
      buttonByText($('#activity'), 'Settings').click();
      await flush();
      expect($('#oldLogsStatus').textContent).toContain('Found 4 log(s) older than 30 days');
      $<HTMLInputElement>('#logRetentionDays').value = '90';
      await submit($<HTMLFormElement>('#logSettingsForm'));
      expect(lastCall('set-setting')).toEqual(['logRetentionDays', '90']);
      expect($('#logRetentionDisplay').textContent).toBe('90');
    });

    test('Clear by Date sends an ISO timestamp', async () => {
      buttonByText($('#activity'), 'Clear by Date').click();
      $<HTMLInputElement>('#clearBeforeDate').value = '2026-01-01T00:00';
      await submit($<HTMLFormElement>('#clearActivityForm'));
      expect(lastCall('clear-activities-by-date')![0]).toBe(new Date('2026-01-01T00:00').toISOString());
      expect((window.alert as jest.Mock).mock.calls[0][0]).toBe('Deleted 2 activity log entries.');
    });

    test('Clear All empties the log', async () => {
      buttonByText($('#activity'), 'Clear All').click();
      await flush();
      expect(calls('clear-all-activities')).toHaveLength(1);
      expect($('#full-activity-log').textContent).toContain('No activity yet');
      expect($('#activityCount').textContent).toBe('0');
    });
  });

  describe('logout', () => {
    test('asks for confirmation before logging out', async () => {
      (window.confirm as jest.Mock).mockReturnValueOnce(false);
      buttonByText(document.body, 'Logout').click();
      await flush();
      expect(calls('logout')).toHaveLength(0);

      buttonByText(document.body, 'Logout').click();
      await flush();
      expect(calls('logout')).toHaveLength(1);
    });
  });
});
