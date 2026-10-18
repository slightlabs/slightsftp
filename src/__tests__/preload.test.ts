/**
 * preload.test.ts — loads the REAL preload script (src/preload.ts) with a fake
 * `electron` module and tests the API it exposes through contextBridge.
 */
import * as fs from 'fs';
import * as path from 'path';

const exposed: Record<string, any> = {};
const ipcRenderer = {
  invoke: jest.fn().mockResolvedValue('ok'),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
};

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: any) => { exposed[key] = api; } },
  ipcRenderer,
}));

require('../preload');
const api = exposed.api;

const EVENT_CHANNELS = ['activity', 'activity-update', 'listener-started', 'listener-stopped'];

beforeEach(() => {
  ipcRenderer.invoke.mockClear();
  ipcRenderer.on.mockClear();
  ipcRenderer.removeAllListeners.mockClear();
});

describe('preload.ts (real module)', () => {
  test('exposes exactly invoke / on / removeAllListeners as window.api', () => {
    expect(Object.keys(exposed)).toEqual(['api']);
    expect(Object.keys(api).sort()).toEqual(['invoke', 'on', 'removeAllListeners']);
  });

  describe('invoke()', () => {
    test('forwards whitelisted channels with their arguments', async () => {
      await expect(api.invoke('get-user', 'alice')).resolves.toBe('ok');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-user', 'alice');
    });

    test.each(['rm-rf', '', 'update-web-server-port-x', '__proto__'])('blocks non-whitelisted channel %p', async ch => {
      await expect(api.invoke(ch)).rejects.toThrow(`Blocked IPC channel: ${ch}`);
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    test('whitelists every channel the GUI actually invokes', async () => {
      const used = new Set<string>();
      for (const file of ['renderer.js', 'login.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        for (const m of src.matchAll(/ipcRenderer\.invoke\(\s*'([a-z-]+)'/g)) used.add(m[1]);
      }
      expect(used.size).toBeGreaterThan(30);
      const blocked: string[] = [];
      for (const ch of used) {
        await api.invoke(ch).catch(() => blocked.push(ch));
      }
      expect(blocked).toEqual([]);
    });
  });

  describe('on()', () => {
    test.each(EVENT_CHANNELS)('subscribes to event channel %s and strips the IPC event object', ch => {
      const cb = jest.fn();
      api.on(ch, cb);
      expect(ipcRenderer.on).toHaveBeenCalledWith(ch, expect.any(Function));
      const wrapped = ipcRenderer.on.mock.calls[0][1];
      wrapped({ sender: 'secret-ipc-event' }, { id: 1 }, 'extra');
      expect(cb).toHaveBeenCalledWith(null, { id: 1 }, 'extra');
    });

    test('silently ignores unknown event channels', () => {
      api.on('system-shutdown', jest.fn());
      api.on('get-all-users', jest.fn());
      expect(ipcRenderer.on).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners()', () => {
    test('only clears whitelisted event channels', () => {
      api.removeAllListeners('activity');
      api.removeAllListeners('get-all-users');
      expect(ipcRenderer.removeAllListeners).toHaveBeenCalledTimes(1);
      expect(ipcRenderer.removeAllListeners).toHaveBeenCalledWith('activity');
    });
  });
});
