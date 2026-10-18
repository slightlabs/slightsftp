/**
 * backup.test.ts — configuration backup and restore through the REST API.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { hostKeyFingerprint, setCertificateDir, SSH_HOST_KEY_FILE } from '../tls';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('configuration backup & restore', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let backup: any;
  let fingerprint: string;

  const sftpLogin = async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'bea', password: 'Bea-Pass-123', readyTimeout: 5000 });
    await c.end();
  };

  beforeAll(async () => {
    dir = makeTempDir('backup');
    setCertificateDir(path.join(dir, 'keys'));
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const bea = db.createUser({ username: 'bea', password: 'Bea-Pass-123', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: bea, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    sftpPort = await getFreePort();
    db.subscribeUserToListener(bea, db.createListener({ name: 'Backed up SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.setSetting('logRetentionDays', '45');
    db.createWebhook({ name: 'hook', url: 'https://example.invalid/x', events: ['upload'], format: 'json', enabled: true });
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    fingerprint = hostKeyFingerprint();
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    admin = request.agent(`http://127.0.0.1:${port}`);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
    removeDir(dir);
  });

  test('requires authentication', async () => {
    await request((admin as any).app).get('/api/backup').expect(401);
  });

  test('downloads a bundle with the database, host key and certificate', async () => {
    const res = await admin.get('/api/backup').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="slightsftp-backup-\d{4}-\d\d-\d\d\.json"/);
    backup = res.body;
    expect(backup).toMatchObject({ format: 'slightsftp-backup', version: 1, appVersion: require('../../package.json').version });
    expect(Buffer.from(backup.database, 'base64').subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(Object.keys(backup.files)).toContain(SSH_HOST_KEY_FILE);
  });

  test('restoring brings back users, listeners, settings and webhooks, and restarts listeners', async () => {
    // change everything
    await admin.delete('/api/users/bea').expect(200);
    await admin.post('/api/listeners').send({ name: 'Temporary', protocol: 'FTP', bindingIp: '127.0.0.1', port: await getFreePort(), enabled: false }).expect(200);
    db.setSetting('logRetentionDays', '5');
    await expect(sftpLogin()).rejects.toThrow();

    const res = await admin.post('/api/backup/restore').send(backup).expect(200);
    expect(res.body).toMatchObject({ success: true, users: 2, listeners: 1 });

    expect(db.getAllUsers().map(u => u.username).sort()).toEqual(['admin', 'bea']);
    expect(db.getAllListeners().map(l => l.name)).toEqual(['Backed up SFTP']);
    expect(db.getSetting('logRetentionDays')).toBe('45');
    expect(db.listWebhooks().map(h => h.name)).toEqual(['hook']);
    await sftpLogin();
  });

  test('the server identity (host key) is restored too', async () => {
    fs.rmSync(path.join(dir, 'keys', SSH_HOST_KEY_FILE));
    setCertificateDir(path.join(dir, 'keys'));
    expect(hostKeyFingerprint()).not.toBe(fingerprint); // a new key was generated
    await admin.post('/api/backup/restore').send(backup).expect(200);
    expect(hostKeyFingerprint()).toBe(fingerprint);
  });

  test('the admin session survives a restore and the restored database is saved to disk', async () => {
    await admin.get('/api/users').expect(200);
    const reopened = new DatabaseManager(path.join(dir, 'config.db'));
    await reopened.init();
    expect(reopened.getAllListeners().map(l => l.name)).toEqual(['Backed up SFTP']);
    reopened.close();
  });

  test.each([
    [{ format: 'something-else', database: 'AAAA' }],
    [{ format: 'slightsftp-backup' }],
    [{ format: 'slightsftp-backup', database: Buffer.from('not sqlite at all').toString('base64') }],
  ])('rejects invalid bundles and keeps the current configuration (%#)', async bundle => {
    const res = await admin.post('/api/backup/restore').send(bundle).expect(400);
    expect(res.body.error).toBe('This is not a SLightSFTP configuration backup');
    expect(db.getAllListeners().map(l => l.name)).toEqual(['Backed up SFTP']);
    await sftpLogin();
  });
});
