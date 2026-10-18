import { contextBridge, ipcRenderer } from 'electron';

const INVOKE_CHANNELS = [
  'authenticate-user', 'get-authenticated-user', 'logout',
  'create-user', 'get-user', 'get-all-users', 'update-user', 'delete-user',
  'get-user-listeners', 'get-virtual-paths', 'get-permission',
  'get-user-subscriptions', 'add-user-subscription', 'remove-user-subscription',
  'get-user-virtual-paths', 'add-user-virtual-path', 'remove-user-virtual-path',
  'create-listener', 'get-listener', 'get-all-listeners', 'update-listener', 'delete-listener',
  'start-listener', 'stop-listener', 'get-listener-status', 'get-all-listener-statuses',
  'get-active-sessions', 'disconnect-session',
  'get-activity', 'clear-activity',
  'get-recent-activities', 'get-activity-count',
  'clear-activities-by-date', 'clear-all-activities', 'cleanup-old-activities',
  'get-old-logs-stats', 'save-activity-log',
  'get-setting', 'set-setting', 'get-all-settings',
  'browse-files', 'download-file', 'select-directory',
  'start-web-server', 'stop-web-server', 'get-web-server-status',
  'set-first-login-password', 'get-server-identity', 'get-shares', 'revoke-share',
  'get-ip-bans', 'unban-ip', 'get-security-settings', 'set-security-settings',
  'get-webhooks', 'create-webhook', 'update-webhook', 'delete-webhook', 'test-webhook',
];

const EVENT_CHANNELS = ['activity', 'activity-update', 'listener-started', 'listener-stopped'];

contextBridge.exposeInMainWorld('api', {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: string, callback: (event: null, ...args: unknown[]) => void): void {
    if (!EVENT_CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => callback(null, ...args));
  },
  removeAllListeners(channel: string): void {
    if (EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});
