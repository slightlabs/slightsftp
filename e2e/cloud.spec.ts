/**
 * Cloud storage end-to-end: in a real browser the admin connects an S3
 * bucket from the Cloud Storage panel, points a user's folder at it, and the
 * user's portal uploads land in the bucket (served by dist/web-only.js).
 */
import { test, expect, Page } from '@playwright/test';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DIST, getFreePort, makeTempDir, startWebOnlyServer, stopProcess } from './helpers';
import { FakeS3, startFakeS3 } from '../src/__tests__/helpers/fake-s3';

test.describe.configure({ mode: 'serial' });

let workDir: string;
let server: ChildProcess;
let s3: FakeS3;
let baseURL: string;
let page: Page;
const pageErrors: Error[] = [];

test.beforeAll(async ({ browser }) => {
  workDir = makeTempDir('cloud');
  s3 = await startFakeS3({ bucket: 'e2e-bucket' });
  s3.objects.set('cleo/welcome.txt', { body: Buffer.from('already in the bucket'), mtime: new Date(), etag: 'x' });

  const { DatabaseManager } = require(path.join(DIST, 'database.js'));
  const db = new DatabaseManager(path.join(workDir, 'config.db'));
  await db.init();
  db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
  db.createUser({ username: 'cleo', password: 'Cleo-Pass-123', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
  db.setSetting('setupComplete', 'true');
  db.close();

  const port = await getFreePort();
  server = await startWebOnlyServer(workDir, port);
  baseURL = `http://127.0.0.1:${port}`;
  page = await (await browser.newContext({ baseURL, acceptDownloads: true })).newPage();
  page.on('pageerror', err => pageErrors.push(err));
});

test.afterAll(async () => {
  await page?.context().close();
  await stopProcess(server);
  await s3?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('admin adds an S3 bucket from the Cloud Storage panel and tests it', async () => {
  await page.goto('/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'Admin-Pass-1');
  await page.click('#loginBtn');
  await expect(page).toHaveURL(`${baseURL}/`);
  const wizard = page.locator('#setupWizard');
  if (await wizard.evaluate(el => el.classList.contains('active'))) {
    await page.locator('#setupStep1').getByRole('button', { name: 'Skip' }).click();
  }

  await page.click('.sidebar-item[data-panel="storage"]');
  await expect(page.locator('#storage-table')).toContainText('No cloud storage yet');
  await page.getByRole('button', { name: 'Add Connection' }).click();
  const form = page.locator('#storageForm');
  await form.locator('[name=name]').fill('E2E bucket');
  await form.locator('[name=bucket]').fill('e2e-bucket');
  await form.locator('[name=endpoint]').fill(s3.endpoint);
  await form.locator('[name=accessKeyId]').fill('e2e-key');
  await form.locator('[name=secretAccessKey]').fill('e2e-secret');
  await form.locator('#storage-path-style').check();
  await form.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('#storageTestResult')).toContainText('✓ Connected');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#storageModal')).not.toHaveClass(/active/);
  await expect(page.locator('#storage-table')).toContainText('E2E bucket');
  await expect(page.locator('#storage-table')).toContainText(`e2e-bucket @ ${s3.endpoint}`);
});

test('admin points the user\'s home folder at the bucket', async () => {
  await page.click('.sidebar-item[data-panel="users"]');
  const row = page.locator('#users-table tr', { hasText: 'cleo' });
  await row.getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('#editUserModal');
  await expect(modal).toHaveClass(/active/);
  await modal.getByRole('button', { name: 'Add Virtual Path' }).click();
  await page.fill('#vpVirtualPath', '/');
  await page.selectOption('#vpStorage', { label: '☁ E2E bucket (S3)' });
  await expect(page.locator('#vpBrowseBtn')).toBeHidden();
  await page.fill('#vpRealPath', 'cleo');
  await page.check('#vpCanDelete');
  await page.check('#vpCanCreateDir');
  await page.check('#vpCanRename');
  await page.locator('#virtualPathForm').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('#virtualPathsList')).toContainText('☁ E2E bucket / cleo');
  await modal.getByRole('button', { name: 'Update User' }).click();
  await expect(modal).not.toHaveClass(/active/);

  // the panel now shows who uses the bucket
  await page.click('.sidebar-item[data-panel="storage"]');
  await expect(page.locator('#storage-table')).toContainText('cleo → /');
});

test('the user\'s portal lists, uploads and downloads in the bucket', async ({ browser }) => {
  const portal = await (await browser.newContext({ baseURL, acceptDownloads: true })).newPage();
  try {
    await portal.goto('/files');
    await portal.fill('#username', 'cleo');
    await portal.fill('#password', 'Cleo-Pass-123');
    await portal.click('#loginBtn');
    const row = (name: string) => portal.locator('#rows .row', { has: portal.locator('.name button', { hasText: name }) });
    await expect(row('welcome.txt')).toBeVisible();

    await portal.locator('#fileInput').setInputFiles([{ name: 'from-browser.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded in the browser') }]);
    await expect(row('from-browser.txt')).toBeVisible();
    expect(s3.objects.get('cleo/from-browser.txt')?.body.toString()).toBe('uploaded in the browser');

    const [download] = await Promise.all([portal.waitForEvent('download'), row('welcome.txt').getByRole('button', { name: 'Download' }).click()]);
    expect(download.suggestedFilename()).toBe('welcome.txt');
    expect(fs.readFileSync((await download.path())!, 'utf8')).toBe('already in the bucket');
  } finally {
    await portal.context().close();
  }
});

test('the admin Files panel browses the bucket too', async () => {
  await page.click('.sidebar-item[data-panel="files"]');
  await page.selectOption('#fileBrowserUser', 'cleo');
  await expect(page.locator('#fileList')).toContainText('from-browser.txt');
  await expect(page.locator('#fileList')).toContainText('welcome.txt');
  const item = page.locator('#fileList .file-item', { has: page.locator('.file-name', { hasText: /^welcome\.txt$/ }) });
  const [download] = await Promise.all([page.waitForEvent('download'), item.getByRole('button', { name: 'Download' }).click()]);
  expect(fs.readFileSync((await download.path())!, 'utf8')).toBe('already in the bucket');
});

test('no page errors', async () => {
  expect(pageErrors).toEqual([]);
});
