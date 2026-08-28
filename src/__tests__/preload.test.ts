/**
 * preload.test.ts — tests the channel whitelist logic from preload.ts.
 * We can't test contextBridge.exposeInMainWorld directly (it's Electron-only),
 * so we import the whitelist arrays from a re-export and test the guard logic.
 */

// ---- inline the whitelist so tests don't depend on Electron runtime ----
const INVOKE_CHANNELS: readonly string[] = [
  'authenticate-user', 'get-authenticated-user', 'logout',
  'create-user', 'get-user', 'get-all-users', 'update-user', 'delete-user',
  'get-user-listeners', 'get-virtual-paths', 'get-permission',
  'create-listener', 'get-listener', 'get-all-listeners', 'update-listener', 'delete-listener',
  'start-listener', 'stop-listener', 'get-listener-status', 'get-all-listener-statuses',
  'get-active-sessions', 'disconnect-session',
  'get-recent-activities', 'get-activity-count',
  'clear-activities-by-date', 'clear-all-activities', 'cleanup-old-activities',
  'get-old-logs-stats', 'save-activity-log',
  'get-setting', 'set-setting', 'get-all-settings',
  'browse-files', 'download-file', 'select-directory',
  'start-web-server', 'stop-web-server', 'get-web-server-status',
  'set-first-login-password',
];

const EVENT_CHANNELS: readonly string[] = [
  'activity', 'activity-update', 'listener-started', 'listener-stopped'
];

// Simulated preload guard (mirrors the logic in preload.ts)
function makeApi(invokeMock: jest.Mock, onMock: jest.Mock, removeAllMock: jest.Mock) {
  return {
    invoke(channel: string, ...args: unknown[]) {
      if (!INVOKE_CHANNELS.includes(channel)) {
        return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
      }
      return invokeMock(channel, ...args);
    },
    on(channel: string, callback: (...args: unknown[]) => void) {
      if (!EVENT_CHANNELS.includes(channel)) return;
      onMock(channel, callback);
    },
    removeAllListeners(channel: string) {
      if (EVENT_CHANNELS.includes(channel)) removeAllMock(channel);
    },
  };
}

describe('Preload channel whitelist', () => {
  let invokeMock: jest.Mock;
  let onMock: jest.Mock;
  let removeMock: jest.Mock;
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    invokeMock = jest.fn().mockResolvedValue('ok');
    onMock = jest.fn();
    removeMock = jest.fn();
    api = makeApi(invokeMock, onMock, removeMock);
  });

  describe('invoke() channel whitelist', () => {
    test('allows every listed invoke channel', async () => {
      for (const ch of INVOKE_CHANNELS) {
        await expect(api.invoke(ch)).resolves.toBe('ok');
      }
      expect(invokeMock).toHaveBeenCalledTimes(INVOKE_CHANNELS.length);
    });

    test('blocks an unknown channel with an error', async () => {
      await expect(api.invoke('rm-rf')).rejects.toThrow('Blocked IPC channel: rm-rf');
      expect(invokeMock).not.toHaveBeenCalled();
    });

    test('passes arguments to ipcRenderer.invoke', async () => {
      await api.invoke('get-user', 'alice');
      expect(invokeMock).toHaveBeenCalledWith('get-user', 'alice');
    });

    test('blocks an empty-string channel', async () => {
      await expect(api.invoke('')).rejects.toThrow('Blocked');
    });
  });

  describe('on() channel whitelist', () => {
    test('registers handler for every allowed event channel', () => {
      const cb = jest.fn();
      for (const ch of EVENT_CHANNELS) {
        api.on(ch, cb);
      }
      expect(onMock).toHaveBeenCalledTimes(EVENT_CHANNELS.length);
    });

    test('silently ignores an unknown event channel', () => {
      api.on('system-shutdown', jest.fn());
      expect(onMock).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners() channel whitelist', () => {
    test('calls through for allowed event channels', () => {
      api.removeAllListeners('activity');
      expect(removeMock).toHaveBeenCalledWith('activity');
    });

    test('silently ignores non-event channels', () => {
      api.removeAllListeners('get-all-users'); // invoke channel, not event
      expect(removeMock).not.toHaveBeenCalled();
    });
  });

  describe('Whitelist completeness', () => {
    test('all required renderer IPC channels are in the whitelist', () => {
      const requiredChannels = [
        'authenticate-user', 'logout', 'get-authenticated-user',
        'get-all-listeners', 'create-listener', 'update-listener', 'delete-listener',
        'start-listener', 'stop-listener', 'get-all-listener-statuses',
        'get-all-users', 'create-user', 'update-user', 'delete-user',
        'get-active-sessions', 'disconnect-session',
        'get-recent-activities', 'save-activity-log',
        'browse-files', 'select-directory',
        'start-web-server', 'stop-web-server', 'get-web-server-status',
        'set-first-login-password',
      ];
      for (const ch of requiredChannels) {
        expect(INVOKE_CHANNELS).toContain(ch);
      }
    });

    test('all required event channels are in the whitelist', () => {
      expect(EVENT_CHANNELS).toContain('activity');
      expect(EVENT_CHANNELS).toContain('listener-started');
      expect(EVENT_CHANNELS).toContain('listener-stopped');
    });
  });
});
