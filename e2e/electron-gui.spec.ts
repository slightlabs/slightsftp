/**
 * Desktop GUI end-to-end: launches the real Electron app (dist/main.js) with
 * Playwright and drives the login window and dashboard window like a user.
 * Linux CI: run under `xvfb-run`.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { DIST, getFreePort, httpStatus, makeTempDir } from './helpers';
import { startFakeS3 } from '../src/__tests__/helpers/fake-s3';
import { createAzureContainer, startAzurite } from '../src/__tests__/helpers/cloud-servers';

const SftpClient = require('ssh2-sftp-client');

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let workDir: string;
let webPort: number;
let login: Page;
let dashboard: Page;
const dialogs: string[] = [];
const ADMIN_PW = 'Desk-Admin-2026';

const autoAcceptDialogs = (page: Page) => page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
const windowFor = async (file: string) => {
  const existing = app.windows().find(w => w.url().endsWith(file));
  return existing ?? app.waitForEvent('window', { predicate: w => w.url().endsWith(file) });
};
const nav = (panel: string) => dashboard.locator(`.sidebar-item[data-panel="${panel}"]`).click();
const card = (name: string) => dashboard.locator('#listeners-list .listener-card', { has: dashboard.locator('h3', { hasText: new RegExp(`^${name}$`) }) });

async function signIn(user: string, password: string, newPassword?: string): Promise<Page> {
  login = await windowFor('login.html');
  await login.fill('#username', user);
  await login.fill('#password', password);
  await login.click('#loginBtn');
  if (newPassword) {
    await expect(login.locator('#changePasswordForm')).toBeVisible();
    await login.fill('#newPassword', newPassword);
    await login.fill('#confirmPassword', newPassword);
    await login.click('#changePasswordBtn');
  }
  const page = await windowFor('index.html');
  autoAcceptDialogs(page);
  return page;
}

test.beforeAll(async () => {
  workDir = makeTempDir('electron');
  webPort = await getFreePort();
  app = await electron.launch({
    args: ['--no-sandbox', path.join(DIST, 'main.js')],
    cwd: workDir, // development layout: config.db + ftp-root live in the working directory
    env: { ...process.env, WEB_PORT: String(webPort), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', SLIGHTSFTP_NO_UPDATE_CHECK: '1' },
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('starts with a frameless login window and no dashboard', async () => {
  login = await windowFor('login.html');
  await expect(login.locator('#loginForm')).toBeVisible();
  await expect(login.locator('#loginBtn')).toHaveText('Sign In');
  expect(app.windows().filter(w => w.url().endsWith('index.html'))).toHaveLength(0);
  expect(fs.existsSync(path.join(workDir, 'config.db'))).toBe(true);
});

test('rejects bad credentials in the login window', async () => {
  await login.fill('#username', 'admin');
  await login.fill('#password', 'wrong');
  await login.click('#loginBtn');
  await expect(login.locator('#errorMessage')).toHaveText('Invalid username or password');
  await expect(login.locator('#loginBtn')).toBeEnabled();
});

test('first admin login forces a new password, then opens the dashboard window', async () => {
  dashboard = await signIn('admin', 'admin123', ADMIN_PW);
  await expect(dashboard.locator('#setupWizard')).toHaveClass(/active/);
  await dashboard.locator('#setupStep1').getByRole('button', { name: 'Skip' }).click();
  await expect(dashboard.locator('#setupWizard')).not.toHaveClass(/active/);
  await expect(dashboard.locator('#currentUser')).toHaveText('admin');
  await expect(dashboard.locator('#totalUsersCount')).toHaveText('1');
  await expect(dashboard.locator('#server-overview')).toContainText('3');
  expect(await dashboard.title()).toBeTruthy();
});

test('default listeners use non-privileged ports', async () => {
  await nav('listeners');
  await expect(card('Default SFTP')).toContainText('0.0.0.0:2222');
  await expect(card('Default FTP')).toContainText('0.0.0.0:2121');
  await expect(card('Web GUI Server')).toContainText('Stopped');
});

test('the embedded web GUI server can be started and stopped from the desktop', async () => {
  dialogs.length = 0;
  await card('Web GUI Server').getByRole('button', { name: 'Start' }).click();
  await expect(card('Web GUI Server')).toContainText('Running');
  expect(dialogs.join('\n')).toContain(`started successfully on port ${webPort}`);
  expect(await httpStatus(`http://127.0.0.1:${webPort}/login`)).toBe(200);

  await card('Web GUI Server').getByRole('button', { name: 'Stop' }).click();
  await expect(card('Web GUI Server')).toContainText('Stopped');
  await expect(httpStatus(`http://127.0.0.1:${webPort}/login`)).rejects.toThrow();
});

test('a listener and user created in the desktop GUI serve real SFTP traffic', async () => {
  const sftpPort = await getFreePort();
  await dashboard.getByRole('button', { name: 'Add Listener' }).click();
  const lf = dashboard.locator('#addListenerForm');
  await lf.locator('[name=name]').fill('Desktop SFTP');
  await lf.locator('[name=protocol]').selectOption('SFTP');
  await lf.locator('[name=bindingIp]').fill('127.0.0.1');
  await lf.locator('[name=port]').fill(String(sftpPort));
  await lf.getByRole('button', { name: 'Create Listener' }).click();
  await card('Desktop SFTP').getByRole('button', { name: 'Start' }).click();
  await expect(card('Desktop SFTP')).toContainText('Running');

  await nav('users');
  await dashboard.getByRole('button', { name: 'Add User' }).click();
  const uf = dashboard.locator('#addUserForm');
  await uf.locator('[name=username]').fill('desk');
  await uf.locator('[name=password]').fill('desk-pass');
  await uf.getByRole('button', { name: 'Create User' }).click();

  const row = dashboard.locator('#users-table tbody tr', { hasText: 'desk' });
  await row.getByRole('button', { name: 'Edit' }).click();
  const modal = dashboard.locator('#editUserModal');
  await modal.locator('label', { hasText: 'Desktop SFTP' }).click();
  const listenerId = await modal.locator('input[id^="listener-"]:checked').getAttribute('value');
  await modal.locator(`#permissions-${listenerId}`).getByRole('button', { name: 'Select All' }).click();
  await modal.getByRole('button', { name: 'Add Virtual Path' }).click();
  const root = path.join(workDir, 'desk-root');
  fs.mkdirSync(root);
  await dashboard.fill('#vpVirtualPath', '/');
  await dashboard.fill('#vpRealPath', root);
  await dashboard.locator('#virtualPathForm').getByRole('button', { name: 'OK' }).click();
  await modal.getByRole('button', { name: 'Update User' }).click();
  await expect(modal).not.toHaveClass(/active/);

  const client = new SftpClient();
  await client.connect({ host: '127.0.0.1', port: sftpPort, username: 'desk', password: 'desk-pass', readyTimeout: 5000 });
  try {
    await client.put(Buffer.from('from the desktop test'), '/hello.txt');
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('from the desktop test');

    await nav('sessions');
    await expect(dashboard.locator('#sessions-table')).toContainText('desk');
  } finally {
    await client.end();
  }

  await nav('files');
  await dashboard.selectOption('#fileBrowserUser', 'desk');
  await expect(dashboard.locator('#fileList')).toContainText('hello.txt');
});

test('S3 and Azure Blob connections made in the desktop app serve SFTP traffic', async () => {
  const s3 = await startFakeS3({ bucket: 'desk-bucket' });
  const azurite = await startAzurite();
  await createAzureContainer(azurite.connectionString, 'desk-files');
  try {
    await nav('storage');
    const addConnection = async (fill: (form: ReturnType<Page['locator']>) => Promise<void>, name: string) => {
      await dashboard.getByRole('button', { name: 'Add Connection' }).click();
      const form = dashboard.locator('#storageForm');
      await form.locator('[name=name]').fill(name);
      await fill(form);
      await form.getByRole('button', { name: 'Test connection' }).click();
      await expect(dashboard.locator('#storageTestResult')).toContainText('✓ Connected');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(dashboard.locator('#storage-table')).toContainText(name);
    };
    await addConnection(async form => {
      await form.locator('[name=bucket]').fill('desk-bucket');
      await form.locator('[name=endpoint]').fill(s3.endpoint);
      await form.locator('[name=accessKeyId]').fill('k');
      await form.locator('[name=secretAccessKey]').fill('s');
      await form.locator('#storage-path-style').check();
    }, 'Desk S3');
    await addConnection(async form => {
      await form.locator('[name=type]').selectOption('azure');
      await form.locator('[name=container]').fill('desk-files');
      await form.locator('[name=connectionString]').fill(azurite.connectionString);
    }, 'Desk Azure');

    await nav('users');
    await dashboard.locator('#users-table tbody tr', { hasText: 'desk' }).getByRole('button', { name: 'Edit' }).click();
    const modal = dashboard.locator('#editUserModal');
    for (const [vpath, label] of [['/s3', '☁ Desk S3 (S3)'], ['/azure', '☁ Desk Azure (Azure Blob)']]) {
      await modal.getByRole('button', { name: 'Add Virtual Path' }).click();
      await dashboard.fill('#vpVirtualPath', vpath);
      await dashboard.selectOption('#vpStorage', { label });
      await dashboard.fill('#vpRealPath', 'desk');
      await dashboard.locator('#virtualPathForm').getByRole('button', { name: 'OK' }).click();
    }
    await modal.getByRole('button', { name: 'Update User' }).click();
    await expect(modal).not.toHaveClass(/active/);

    const sftpPort = Number((await card('Desktop SFTP').textContent())!.match(/127\.0\.0\.1:(\d+)/)![1]);
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: sftpPort, username: 'desk', password: 'desk-pass', readyTimeout: 5000 });
    try {
      await client.put(Buffer.from('into s3 from electron'), '/s3/a.txt');
      await client.put(Buffer.from('into azure from electron'), '/azure/b.txt');
      expect(s3.objects.get('desk/a.txt')?.body.toString()).toBe('into s3 from electron');
      expect((await client.get('/azure/b.txt')).toString()).toBe('into azure from electron');
      expect((await client.list('/azure')).map((e: any) => e.name)).toEqual(['b.txt']);
    } finally {
      await client.end();
    }
  } finally {
    await s3.close();
    await azurite.stop();
  }
});

test('Logout returns to the login window; the dashboard is closed', async () => {
  dialogs.length = 0;
  const loginPromise = app.waitForEvent('window', { predicate: w => w.url().endsWith('login.html') });
  await dashboard.getByRole('button', { name: 'Logout' }).click();
  login = await loginPromise;
  expect(dialogs).toContain('Are you sure you want to logout?');
  await expect.poll(() => app.windows().filter(w => w.url().endsWith('index.html')).length).toBe(0);
  await expect(login.locator('#loginForm')).toBeVisible();
});

test('non-GUI users are refused at the login window; admin can sign back in', async () => {
  await login.fill('#username', 'desk');
  await login.fill('#password', 'desk-pass');
  await login.click('#loginBtn');
  await expect(login.locator('#errorMessage')).toHaveText('Invalid username or password');

  dashboard = await signIn('admin', ADMIN_PW);
  await expect(dashboard.locator('#currentUser')).toHaveText('admin');
  await expect(dashboard.locator('#totalUsersCount')).toHaveText('2');
});
