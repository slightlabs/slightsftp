/**
 * @jest-environment jsdom
 *
 * web-shim-contract.test.ts — the browser build of the GUI runs the same
 * renderer.js as Electron, with `ipcRenderer` replaced by a fetch-based shim
 * injected by WebServer. This executes that real injected shim and checks that
 * every channel the GUI uses is mapped, with the Electron argument order, to the
 * correct REST call.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const SRC = path.join(__dirname, '..');
const fetchMock = jest.fn();

function guiChannels(): string[] {
  const used = new Set<string>();
  for (const file of ['renderer.js', 'login.html']) {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const m of src.matchAll(/ipcRenderer\.invoke\(\s*'([a-z-]+)'/g)) used.add(m[1]);
  }
  return [...used].sort();
}

beforeAll(() => {
  // Build the shim exactly as the server injects it into index.html
  // (injectWebAPI is pure; call it off the prototype since jsdom can't host a ws server)
  const { WebServer } = require('../web-server');
  const injected: string = WebServer.prototype['injectWebAPI'].call(
    {}, '<html><head></head><body><script src="renderer.js"></script></body></html>', true
  );
  const shim = injected.match(/<script>([\s\S]*?)<\/script>/)![1];

  (window as any).fetch = fetchMock;
  (window as any).prompt = jest.fn(() => ' /srv/picked ');
  (URL as any).createObjectURL = jest.fn(() => 'blob:fake');
  (URL as any).revokeObjectURL = jest.fn();
  (window as any).WebSocket = jest.fn(() => ({}));

  const script = document.createElement('script');
  script.textContent = shim;
  document.head.appendChild(script);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ count: 7, value: 'v', files: [] }) }));
});

const ipc = () => (window as any).ipcRenderer;
const lastFetch = () => {
  const [url, init = {}] = fetchMock.mock.calls.at(-1)!;
  return { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
};

describe('Web GUI IPC shim (WebServer.injectWebAPI)', () => {
  test('maps every channel used by renderer.js / login.html', async () => {
    const unmapped: string[] = [];
    for (const channel of guiChannels()) {
      try {
        await ipc().invoke(channel, 1, {}, [], [], []);
      } catch (err: any) {
        if (/Unknown IPC channel/.test(err.message)) unmapped.push(channel);
      }
    }
    expect(unmapped).toEqual([]);
  });

  test('rejects channels that do not exist', async () => {
    await expect(ipc().invoke('format-disk')).rejects.toThrow('Unknown IPC channel: format-disk');
  });

  test.each([
    ['update-listener', [2, { name: 'L', port: 2100 }], 'PUT', '/api/listeners/2', { name: 'L', port: 2100 }],
    ['update-user', ['bob', { guiEnabled: true }, [1], [{ virtualPath: '/' }], [{ listenerId: 1 }]], 'PUT', '/api/users/bob',
      { guiEnabled: true, listeners: [1], virtualPaths: [{ virtualPath: '/' }], permissions: [{ listenerId: 1 }] }],
    ['create-listener', [{ name: 'L' }], 'POST', '/api/listeners', { name: 'L' }],
    ['delete-user', ['bob'], 'DELETE', '/api/users/bob', undefined],
    ['start-listener', [3], 'POST', '/api/listeners/3/start', undefined],
    ['disconnect-session', ['s-1'], 'DELETE', '/api/sessions/s-1', undefined],
    ['get-virtual-paths', [5], 'GET', '/api/users/id/5/virtual-paths', undefined],
    ['get-permission', [5, 2], 'GET', '/api/users/id/5/permissions/2', undefined],
    ['get-all-settings', [], 'GET', '/api/settings', undefined],
    ['set-setting', ['logRetentionDays', '90'], 'PUT', '/api/settings/logRetentionDays', { value: '90' }],
    ['clear-all-activities', [], 'DELETE', '/api/activity', {}],
    ['clear-activities-by-date', ['2026-01-01T00:00:00.000Z'], 'DELETE', '/api/activity', { beforeDate: '2026-01-01T00:00:00.000Z' }],
    ['get-old-logs-stats', [30], 'GET', '/api/activity/old-stats?retentionDays=30', undefined],
    ['cleanup-old-activities', [], 'POST', '/api/activity/cleanup', undefined],
    ['browse-files', ['bob', '/a b'], 'GET', '/api/files/browse?username=bob&path=%2Fa%20b', undefined],
  ])('%s → %s %s', async (channel, args, method, url, body) => {
    await ipc().invoke(channel, ...(args as any[]));
    expect(lastFetch()).toEqual({ url, method, body });
  });

  test('get-activity-count unwraps the count', async () => {
    await expect(ipc().invoke('get-activity-count')).resolves.toBe(7);
  });

  test('API errors are surfaced as rejected promises with the server message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'User not found' }) });
    await expect(ipc().invoke('get-virtual-paths', 99)).rejects.toThrow('User not found');
  });

  test('download-file checks the file then triggers a browser download', async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const result = await ipc().invoke('download-file', 'bob', '/dir/report.pdf');
    expect(fetchMock.mock.calls[0]).toEqual(['/api/files/download?username=bob&path=%2Fdir%2Freport.pdf', { method: 'HEAD' }]);
    expect(click).toHaveBeenCalled();
    expect(result.success).toBe(true);
    click.mockRestore();
  });

  test('save-activity-log downloads the CSV as a file', async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await expect(ipc().invoke('save-activity-log', 'a,b')).resolves.toEqual({ success: true });
    expect(click).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    click.mockRestore();
  });

  test('select-directory asks for a server-side path', async () => {
    await expect(ipc().invoke('select-directory')).resolves.toBe('/srv/picked');
  });

  test('web-server controls report the browser-hosted server as running and unstoppable', async () => {
    await expect(ipc().invoke('get-web-server-status')).resolves.toMatchObject({ running: true });
    await expect(ipc().invoke('stop-web-server')).resolves.toMatchObject({ success: false });
  });
});
