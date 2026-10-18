/**
 * Web GUI end-to-end: a real Chromium browser drives the real web GUI served by
 * the real `dist/web-only.js` entrypoint. Everything an admin does is done by
 * clicking through the UI; the result is then proven with real SFTP clients.
 */
import { test, expect, Page, Dialog } from '@playwright/test';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getFreePort, makeTempDir, startWebOnlyServer, stopProcess } from './helpers';

const SftpClient = require('ssh2-sftp-client');

test.describe.configure({ mode: 'serial' });

let workDir: string;
let ftpRoot: string;
let server: ChildProcess;
let webPort: number;
let sftpPort: number;
let page: Page;
const dialogs: string[] = [];

const sftp = async (port = sftpPort, username = 'webuser', password = 'Web#Pass1') => {
  const client = new SftpClient();
  await client.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 5000, retries: 0 });
  return client;
};

const nav = (panel: string) => page.locator(`.sidebar-item[data-panel="${panel}"]`).click();
const card = (name: string) => page.locator('#listeners-list .listener-card', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
const userRow = (name: string) => page.locator('#users-table tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }) });

test.beforeAll(async ({ browser }) => {
  workDir = makeTempDir('web');
  ftpRoot = path.join(workDir, 'files');
  fs.mkdirSync(ftpRoot);
  fs.writeFileSync(path.join(ftpRoot, 'readme.txt'), 'served by slightsftp');
  [webPort, sftpPort] = [await getFreePort(), await getFreePort()];
  server = await startWebOnlyServer(workDir, webPort);

  const context = await browser.newContext({ acceptDownloads: true, baseURL: `http://127.0.0.1:${webPort}` });
  page = await context.newPage();
  page.on('dialog', async (d: Dialog) => { dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', err => { throw err; });
});

test.afterAll(async () => {
  await page?.context().close();
  await stopProcess(server);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('unauthenticated visitors are sent to the login page', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('#loginForm')).toBeVisible();
});

test('a wrong password shows an error and keeps the user on the login page', async () => {
  await page.fill('#username', 'admin');
  await page.fill('#password', 'not-the-password');
  await page.click('#loginBtn');
  await expect(page.locator('#errorMessage')).toHaveText('Invalid credentials');
  await expect(page.locator('#password')).toHaveValue('');
  await expect(page).toHaveURL(/\/login$/);
});

test('the default admin can sign in and lands on the dashboard', async () => {
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin123');
  await page.click('#loginBtn');
  await expect(page).toHaveURL(`http://127.0.0.1:${webPort}/`);
  await expect(page.locator('#currentUser')).toHaveText('admin');
  await expect(page.locator('#totalUsersCount')).toHaveText('1');
  await expect(page.locator('#server-overview')).toContainText('Total Listeners');
});

test('admin creates an SFTP listener from the Listeners panel', async () => {
  await nav('listeners');
  await expect(card('Web GUI Server')).toContainText('Running');
  await expect(card('Web GUI Server').getByRole('button', { name: 'Stop' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add Listener' }).click();
  const form = page.locator('#addListenerForm');
  await form.locator('[name=name]').fill('Browser SFTP');
  await form.locator('[name=protocol]').selectOption('SFTP');
  await form.locator('[name=bindingIp]').fill('127.0.0.1');
  await form.locator('[name=port]').fill(String(sftpPort));
  await form.getByRole('button', { name: 'Create Listener' }).click();

  await expect(page.locator('#addListenerModal')).not.toHaveClass(/active/);
  await expect(card('Browser SFTP')).toContainText(`127.0.0.1:${sftpPort}`);
  await page.reload();
  await nav('listeners');
  await expect(card('Browser SFTP')).toContainText('Running');
});

test('admin creates a user from the Users panel', async () => {
  await nav('users');
  await page.getByRole('button', { name: 'Add User' }).click();
  const form = page.locator('#addUserForm');
  await form.locator('[name=username]').fill('webuser');
  await form.locator('[name=password]').fill('Web#Pass1');
  await form.getByRole('button', { name: 'Create User' }).click();
  await expect(userRow('webuser')).toBeVisible();
  await expect(userRow('admin').getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('admin grants the user a listener, permissions and a virtual path via Edit User', async () => {
  await userRow('webuser').getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('#editUserModal');
  await expect(modal).toHaveClass(/active/);

  const listenerBox = modal.locator('label', { hasText: 'Browser SFTP' });
  await listenerBox.click();
  const listenerId = await modal.locator('input[id^="listener-"]:checked').getAttribute('value');
  const perms = modal.locator(`#permissions-${listenerId}`);
  await expect(perms).toBeVisible();
  await perms.getByRole('button', { name: 'Select All' }).click();

  await modal.getByRole('button', { name: 'Add Virtual Path' }).click();
  await page.fill('#vpVirtualPath', '/');
  await page.fill('#vpRealPath', ftpRoot);
  await page.check('#vpCanDelete');
  await page.check('#vpCanCreateDir');
  await page.check('#vpCanRename');
  await page.locator('#virtualPathForm').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('#virtualPathsList')).toContainText(ftpRoot);

  await modal.getByRole('button', { name: 'Update User' }).click();
  await expect(modal).not.toHaveClass(/active/);

  // Re-open: everything must have been persisted on the server
  await userRow('webuser').getByRole('button', { name: 'Edit' }).click();
  await expect(modal.locator(`#listener-${listenerId}`)).toBeChecked();
  await expect(modal.locator(`#perm-${listenerId}-canDelete`)).toBeChecked();
  await expect(page.locator('#virtualPathsList')).toContainText(ftpRoot);
  await modal.locator('.close-btn').click();
});

test('the GUI-provisioned user can really use SFTP', async () => {
  const client = await sftp();
  try {
    expect((await client.get('/readme.txt')).toString()).toBe('served by slightsftp');
    await client.put(Buffer.from('uploaded through sftp'), '/from-client.txt');
    await client.mkdir('/reports');
    await client.rename('/from-client.txt', '/reports/from-client.txt');
  } finally {
    await client.end();
  }
  expect(fs.readFileSync(path.join(ftpRoot, 'reports', 'from-client.txt'), 'utf8')).toBe('uploaded through sftp');
});

test('Active Sessions shows a live connection and Disconnect drops it', async () => {
  const client = await sftp();
  const closed = new Promise(resolve => client.client.once('close', resolve));
  try {
    await nav('sessions');
    const row = page.locator('#sessions-table tr', { hasText: 'webuser' });
    await expect(row).toContainText('Browser SFTP');
    await expect(row).toContainText('127.0.0.1');

    dialogs.length = 0;
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await closed;
    // the confirmation alert is shown after the API call returns, which can trail the socket close
    await expect.poll(() => dialogs).toEqual(expect.arrayContaining([expect.stringContaining('disconnect user "webuser"'), 'User "webuser" has been disconnected.']));
    await expect(page.locator('#sessions-table')).toContainText('No active sessions');
  } finally {
    await client.end().catch(() => undefined);
  }
});

test('Files panel browses the user\'s tree and downloads a file', async () => {
  await nav('files');
  await page.selectOption('#fileBrowserUser', 'webuser');
  const item = (name: string) => page.locator('#fileList .file-item', { has: page.locator('.file-name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(item('readme.txt')).toBeVisible();

  await item('reports').getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#fileBreadcrumb')).toContainText('reports');
  const downloadPromise = page.waitForEvent('download');
  await item('from-client.txt').getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('from-client.txt');
  expect(fs.readFileSync((await download.path())!, 'utf8')).toBe('uploaded through sftp');

  await page.locator('#fileBreadcrumb .breadcrumb-item').first().click();
  await expect(item('readme.txt')).toBeVisible();
});

test('hostile file names uploaded over SFTP cannot inject markup into the GUI', async () => {
  const evil = '<img src=x onerror="alert(document.cookie)">.txt';
  const client = await sftp();
  try {
    await client.put(Buffer.from('x'), `/${evil}`);
  } finally {
    await client.end();
  }
  dialogs.length = 0;
  await nav('files');
  await page.selectOption('#fileBrowserUser', 'webuser');
  await expect(page.locator('#fileList .file-name', { hasText: evil })).toBeVisible();
  await nav('activity');
  await expect(page.locator('#full-activity-log')).toContainText(evil);
  await nav('dashboard');
  await expect(page.locator('#dashboard-activity')).toContainText('webuser');
  expect(await page.locator('#fileList img, #full-activity-log img, #dashboard-activity img').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test('Activity Log shows server events and its settings can be changed', async () => {
  await nav('activity');
  await expect(page.locator('#full-activity-log')).toContainText('webuser');
  expect(Number(await page.locator('#activityCount').textContent())).toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#oldLogsStatus')).toContainText('older than 30 days');
  await page.fill('#logRetentionDays', '60');
  await page.locator('#logSettingsForm').getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.locator('#logRetentionDisplay')).toHaveText('60');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '💾 Save' }).click();
  const csv = fs.readFileSync((await (await downloadPromise).path())!, 'utf8');
  expect(csv.split('\n')[0]).toBe('Timestamp,Listener,Username,Action,Path,Success');
  expect(csv).toContain('webuser');
});

test('Edit Port moves the running listener to a new port', async () => {
  const newPort = await getFreePort();
  await nav('listeners');
  await card('Browser SFTP').getByRole('button', { name: 'Edit Port' }).click();
  const form = page.locator('#editListenerForm');
  await expect(form.locator('[name=name]')).toHaveValue('Browser SFTP');
  await form.locator('[name=port]').fill(String(newPort));
  await form.getByRole('button', { name: 'Update Listener' }).click();
  await expect(card('Browser SFTP')).toContainText(`127.0.0.1:${newPort}`);

  const client = await sftp(newPort);
  await client.end();
  sftpPort = newPort;
});

test('Stop takes the listener offline', async () => {
  await card('Browser SFTP').getByRole('button', { name: 'Stop' }).click();
  await expect(card('Browser SFTP')).toContainText('Stopped');
  await expect(sftp()).rejects.toThrow();
  await card('Browser SFTP').getByRole('button', { name: 'Start' }).click();
  await expect(card('Browser SFTP')).toContainText('Running');
});

test('deleting the user from the GUI revokes access', async () => {
  await nav('users');
  await userRow('webuser').getByRole('button', { name: 'Delete' }).click();
  await expect(userRow('webuser')).toHaveCount(0);
  await expect(sftp()).rejects.toThrow();
});

test('Logout ends the web session and returns to the login page', async () => {
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/users')).status()).toBe(401);
});
