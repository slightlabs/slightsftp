/**
 * File portal end-to-end: a real browser uses /files served by dist/web-only.js.
 */
import { test, expect, Page } from '@playwright/test';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DIST, getFreePort, makeTempDir, startWebOnlyServer, stopProcess } from './helpers';

test.describe.configure({ mode: 'serial' });

let workDir: string;
let home: string;
let server: ChildProcess;
let page: Page;
const pageErrors: Error[] = [];

const row = (name: string) => page.locator('#rows .row', { has: page.locator('.name button', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

test.beforeAll(async ({ browser }) => {
  workDir = makeTempDir('portal');
  home = path.join(workDir, 'home');
  fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'welcome.txt'), 'hi from the portal');
  fs.writeFileSync(path.join(home, '<img src=x onerror="window.__pwned=1">.txt'), 'x');

  // Seed the database the server will open, using the compiled DatabaseManager
  const { DatabaseManager } = require(path.join(DIST, 'database.js'));
  const db = new DatabaseManager(path.join(workDir, 'config.db'));
  await db.init();
  db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
  const id = db.createUser({ username: 'pam', password: 'Temp-Pass-1', passwordEnabled: true, guiEnabled: false, portalEnabled: true, mustChangePassword: true });
  db.addVirtualPath({ userId: id, virtualPath: '/', localPath: home, canRead: true, canWrite: true, canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true, applyToSubdirs: true });
  db.close();

  const port = await getFreePort();
  server = await startWebOnlyServer(workDir, port);
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', err => pageErrors.push(err));
});

test.afterAll(async () => {
  await page?.context().close();
  await stopProcess(server);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('signs in and must choose a new password first', async () => {
  await page.goto('/files');
  await page.fill('#username', 'pam');
  await page.fill('#password', 'nope');
  await page.click('#loginBtn');
  await expect(page.locator('#loginError')).toHaveText('Invalid username or password');

  await page.fill('#password', 'Temp-Pass-1');
  await page.click('#loginBtn');
  await expect(page.locator('#changeView')).toBeVisible();
  await page.fill('#newPassword', 'Pam-New-Pass-1');
  await page.fill('#confirmPassword', 'Pam-New-Pass-1');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.locator('#who')).toHaveText('pam');
});

test('lists files, folders first, and renders hostile names as text', async () => {
  await expect(page.locator('#rows .row .name button').first()).toHaveText('docs');
  await expect(row('welcome.txt')).toBeVisible();
  await expect(row('<img src=x onerror="window.__pwned=1">.txt')).toBeVisible();
  expect(await page.locator('#rows img').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test('downloads a file', async () => {
  const pending = page.waitForEvent('download');
  await row('welcome.txt').getByRole('button', { name: 'Download' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('welcome.txt');
  expect(fs.readFileSync((await download.path())!, 'utf8')).toBe('hi from the portal');
});

test('uploads with the Upload button and by drag and drop', async () => {
  await page.locator('#fileInput').setInputFiles([{ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }]);
  await expect(row('report.pdf')).toBeVisible();
  expect(fs.readFileSync(path.join(home, 'report.pdf'), 'utf8')).toBe('%PDF-1.4 fake');

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped content'], 'dropped.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.dispatchEvent('#listPanel', 'dragenter', { dataTransfer });
  await expect(page.locator('#dropzone')).toBeVisible();
  await page.dispatchEvent('#listPanel', 'drop', { dataTransfer });
  await expect(row('dropped.txt')).toBeVisible();
  await expect(page.locator('#dropzone')).toBeHidden();
  expect(fs.readFileSync(path.join(home, 'dropped.txt'), 'utf8')).toBe('dropped content');
});

test('creates a folder, opens it and navigates back with the breadcrumb', async () => {
  page.once('dialog', d => d.accept('Invoices'));
  await page.getByRole('button', { name: 'New folder' }).click();
  await row('Invoices').locator('.name button').click();
  await expect(page.locator('#crumbs')).toContainText('Invoices');
  await expect(page.locator('#rows')).toContainText('This folder is empty');
  await page.locator('#crumbs button', { hasText: 'My files' }).click();
  await expect(row('welcome.txt')).toBeVisible();
});

test('renames and deletes', async () => {
  page.once('dialog', d => d.accept('final-report.pdf'));
  await row('report.pdf').getByRole('button', { name: 'Rename' }).click();
  await expect(row('final-report.pdf')).toBeVisible();
  expect(fs.existsSync(path.join(home, 'final-report.pdf'))).toBe(true);

  page.once('dialog', d => d.accept());
  await row('final-report.pdf').getByRole('button', { name: 'Delete' }).click();
  await expect(row('final-report.pdf')).toHaveCount(0);
  expect(fs.existsSync(path.join(home, 'final-report.pdf'))).toBe(false);
});

test('works at phone width', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await expect(row('welcome.txt').getByRole('button', { name: 'Download' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('signs out', async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#loginView')).toBeVisible();
  await page.reload();
  await expect(page.locator('#loginView')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
