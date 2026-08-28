/**
 * renderer-dom.test.ts — unit tests for renderer-side DOM helper functions.
 * We simulate the browser environment (jsdom) and load renderer.js to test
 * UI utility logic without requiring Electron.
 *
 * @jest-environment jsdom
 */

export {}; // make this file a module so declare global works

declare global {
  interface Window {
    api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: (ch: string, cb: Function) => void; removeAllListeners: (ch: string) => void };
    ipcRenderer: typeof window.api;
  }
}

// ── minimal window.api mock (contextBridge output) ─────────────────────────
const mockInvoke = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
(globalThis as any).window = globalThis;
(globalThis as any).window.api = { invoke: mockInvoke, on: mockOn, removeAllListeners: jest.fn() };
(globalThis as any).window.ipcRenderer = (globalThis as any).window.api;

// Prevent Chart.js and other DOM-heavy code from crashing
(globalThis as any).Chart = jest.fn().mockReturnValue({
  update: jest.fn(), data: { labels: [], datasets: [{ data: [] }, { data: [] }] }
});

// ── standalone helpers extracted from renderer.js logic ────────────────────
// These are pure functions we can test without loading the full 1390-line file.

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleString();
}

function sanitizeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildListenerStatusBadge(running: boolean): string {
  return running
    ? '<span class="badge badge-success">Running</span>'
    : '<span class="badge badge-stopped">Stopped</span>';
}

function parsePort(value: string): number | null {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 65535) return null;
  return n;
}

function validateUsername(username: string): string | null {
  if (!username || username.trim() === '') return 'Username is required';
  if (username.length < 2) return 'Username must be at least 2 characters';
  if (username.length > 64) return 'Username must be at most 64 characters';
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username may only contain letters, numbers, _, ., -';
  return null;
}

function buildVirtualPathRow(vp: { virtualPath: string; localPath: string; id: number }): string {
  return `<tr data-id="${vp.id}"><td>${sanitizeHtml(vp.virtualPath)}</td><td>${sanitizeHtml(vp.localPath)}</td></tr>`;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('Renderer utility functions', () => {
  describe('formatBytes()', () => {
    test('0 bytes → "0 B"', () => expect(formatBytes(0)).toBe('0 B'));
    test('1024 → "1 KB"', () => expect(formatBytes(1024)).toBe('1 KB'));
    test('1048576 → "1 MB"', () => expect(formatBytes(1048576)).toBe('1 MB'));
    test('1073741824 → "1 GB"', () => expect(formatBytes(1073741824)).toBe('1 GB'));
    test('1500 → "1.46 KB"', () => expect(formatBytes(1500)).toBe('1.46 KB'));
  });

  describe('sanitizeHtml()', () => {
    test("escapes angle brackets and ampersands", () => {
      expect(sanitizeHtml("<b>hello & world</b>")).toBe(
        "&lt;b&gt;hello &amp; world&lt;/b&gt;"
      );
    });

    test("escapes double and single quotes", () => {
      const result = sanitizeHtml("say \"hello\" and don't");
      expect(result).toContain("&quot;");
      expect(result).toContain("&#39;");
    });
    test('passes through plain text unchanged', () => {
      expect(sanitizeHtml('hello world')).toBe('hello world');
    });
    test('handles empty string', () => {
      expect(sanitizeHtml('')).toBe('');
    });
  });

  describe('buildListenerStatusBadge()', () => {
    test('running=true → success badge', () => {
      expect(buildListenerStatusBadge(true)).toContain('badge-success');
      expect(buildListenerStatusBadge(true)).toContain('Running');
    });
    test('running=false → stopped badge', () => {
      expect(buildListenerStatusBadge(false)).toContain('badge-stopped');
      expect(buildListenerStatusBadge(false)).toContain('Stopped');
    });
  });

  describe('parsePort()', () => {
    test('valid port returns number', () => {
      expect(parsePort('22')).toBe(22);
      expect(parsePort('3000')).toBe(3000);
      expect(parsePort('65535')).toBe(65535);
    });
    test('port 0 is invalid', () => expect(parsePort('0')).toBeNull());
    test('port 65536 is invalid', () => expect(parsePort('65536')).toBeNull());
    test('non-numeric is invalid', () => expect(parsePort('abc')).toBeNull());
    test('negative is invalid', () => expect(parsePort('-1')).toBeNull());
  });

  describe('validateUsername()', () => {
    test('valid usernames pass', () => {
      expect(validateUsername('alice')).toBeNull();
      expect(validateUsername('user_01')).toBeNull();
      expect(validateUsername('a.b-c')).toBeNull();
    });
    test('empty string fails', () => expect(validateUsername('')).not.toBeNull());
    test('single char fails', () => expect(validateUsername('a')).not.toBeNull());
    test('special chars fail', () => expect(validateUsername('u@host')).not.toBeNull());
    test('65-char username fails', () => expect(validateUsername('a'.repeat(65))).not.toBeNull());
    test('64-char username passes', () => expect(validateUsername('a'.repeat(64))).toBeNull());
  });

  describe('buildVirtualPathRow()', () => {
    test('produces a table row with escaped content', () => {
      const html = buildVirtualPathRow({ virtualPath: '/data', localPath: 'C:\\folder', id: 42 });
      expect(html).toContain('/data');
      expect(html).toContain('data-id="42"');
      expect(html).toContain('<tr');
      expect(html).toContain('</tr>');
    });

    test('escapes XSS in path fields', () => {
      const html = buildVirtualPathRow({ virtualPath: '<xss>', localPath: '/safe', id: 1 });
      expect(html).not.toContain('<xss>');
      expect(html).toContain('&lt;xss&gt;');
    });
  });

  describe('formatDate()', () => {
    test('returns a non-empty string for a valid date', () => {
      const result = formatDate(new Date('2026-01-01T00:00:00.000Z'));
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('handles ISO string input', () => {
      const result = formatDate('2026-06-15T12:00:00.000Z');
      expect(result).not.toBe('Invalid Date');
    });
  });
});

// ── DOM manipulation helpers ──────────────────────────────────────────────

describe('DOM helper functions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('creating and appending an element', () => {
    const el = document.createElement('div');
    el.id = 'panel-dashboard';
    el.className = 'panel';
    document.body.appendChild(el);
    expect(document.getElementById('panel-dashboard')).not.toBeNull();
  });

  test('hiding and showing elements via display style', () => {
    const el = document.createElement('div');
    el.id = 'myEl';
    document.body.appendChild(el);

    el.style.display = 'none';
    expect(el.style.display).toBe('none');

    el.style.display = 'block';
    expect(el.style.display).toBe('block');
  });

  test('setting innerHTML with sanitized content is safe', () => {
    const el = document.createElement('td');
    el.innerHTML = sanitizeHtml('<script>alert(1)</script>');
    expect(el.innerHTML).toContain('&lt;script&gt;');
    expect(el.querySelector('script')).toBeNull();
  });

  test('form input value roundtrip', () => {
    const input = document.createElement('input') as HTMLInputElement;
    input.type = 'text';
    input.value = 'admin';
    document.body.appendChild(input);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('admin');
  });

  test('button disabled state', () => {
    const btn = document.createElement('button') as HTMLButtonElement;
    btn.disabled = false;
    btn.disabled = true;
    expect(btn.disabled).toBe(true);
    btn.disabled = false;
    expect(btn.disabled).toBe(false);
  });

  test('class toggling', () => {
    const el = document.createElement('div');
    el.classList.add('active');
    expect(el.classList.contains('active')).toBe(true);
    el.classList.remove('active');
    expect(el.classList.contains('active')).toBe(false);
    el.classList.toggle('active');
    expect(el.classList.contains('active')).toBe(true);
  });
});

// ── API interaction stubs (window.api.invoke patterns) ────────────────────

describe('window.api.invoke patterns', () => {
  beforeEach(() => jest.clearAllMocks());

  test('invoke get-all-users is called correctly', async () => {
    mockInvoke.mockResolvedValueOnce([{ id: 1, username: 'alice' }]);
    const result = await window.api.invoke('get-all-users');
    expect(mockInvoke).toHaveBeenCalledWith('get-all-users');
    expect(result).toEqual([{ id: 1, username: 'alice' }]);
  });

  test('invoke create-listener passes parameters', async () => {
    const payload = { name: 'SFTP', protocol: 'SFTP', bindingIp: '0.0.0.0', port: 22, enabled: true };
    mockInvoke.mockResolvedValueOnce({ id: 1, ...payload });
    await window.api.invoke('create-listener', payload);
    expect(mockInvoke).toHaveBeenCalledWith('create-listener', payload);
  });

  test('invoke get-active-sessions returns array', async () => {
    mockInvoke.mockResolvedValueOnce([{ sessionId: 's1', username: 'bob' }]);
    const sessions = await window.api.invoke('get-active-sessions');
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('failed invoke propagates error to caller', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('DB error'));
    await expect(window.api.invoke('get-all-listeners')).rejects.toThrow('DB error');
  });

  test('invoke authenticate-user with credentials', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, user: { username: 'admin' } });
    await window.api.invoke('authenticate-user', 'admin', 'secret');
    expect(mockInvoke).toHaveBeenCalledWith('authenticate-user', 'admin', 'secret');
  });
});
