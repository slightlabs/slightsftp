/**
 * webhooks.test.ts — event classification, filters, and real HTTP delivery
 * (including an end-to-end SFTP upload firing a webhook).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { Webhook } from '../types';
import { WebhookDispatcher, buildPayload, classifyActivity, matchesWebhook, signPayload, validateWebhookInput } from '../webhooks';
import { getFreePort, makeTempDir, removeDir, waitFor, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

interface Received { headers: http.IncomingHttpHeaders; body: string; json: any }

/** A tiny HTTP receiver whose responses can be scripted. */
async function receiver() {
  const received: Received[] = [];
  let script: number[] = [];
  let delayMs = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let json: any;
      try { json = JSON.parse(body); } catch { json = undefined; }
      received.push({ headers: req.headers, body, json });
      const status = script.length ? script.shift()! : 200;
      setTimeout(() => { res.statusCode = status; res.end('ok'); }, delayMs);
    });
  });
  const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as any).port)));
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    respondWith: (...statuses: number[]) => { script = statuses; },
    delay: (ms: number) => { delayMs = ms; },
    close: () => new Promise(r => server.close(r)),
  };
}

const hook = (over: Partial<Webhook> = {}): Webhook => ({ id: 1, name: 'h', url: 'http://x', events: ['upload'], format: 'json', enabled: true, ...over });

describe('classification and filters', () => {
  test.each([
    ['UPLOAD', true, 'upload'], ['PORTAL_UPLOAD', true, 'upload'], ['SHARE_UPLOAD', true, 'upload'], ['UPLOAD', false, null],
    ['DOWNLOAD', true, 'download'], ['PORTAL_DOWNLOAD', true, 'download'], ['SHARE_DOWNLOAD', true, 'download'],
    ['REMOVE', true, 'delete'], ['RMDIR', true, 'delete'], ['DELETE', true, 'delete'], ['PORTAL_DELETE', true, 'delete'], ['REMOVE_DENIED', false, null],
    ['LOGIN (password) [1.2.3.4:5]', true, 'login'], ['PORTAL_LOGIN', true, 'login'], ['WEB_LOGIN_SUCCESS', true, 'login'], ['GUI_LOGIN', true, 'login'],
    ['LOGIN_FAILED (Invalid password) [1.2.3.4:5]', false, 'login_failed'], ['WEB_LOGIN_FAILED', false, 'login_failed'], ['PORTAL_LOGIN_FAILED', false, 'login_failed'], ['SHARE_UNLOCK_FAILED', false, 'login_failed'],
    ['SHARE_CREATED', true, 'share'], ['SHARE_CREATED_UPLOAD', true, 'share'], ['SHARE_REVOKED', true, 'share'],
    ['OPEN', true, null], ['LIST', true, null], ['STAT', true, null], ['SERVER_STARTED', true, null],
  ])('%s (success=%s) → %s', (action, success, expected) => {
    expect(classifyActivity({ action, success })).toBe(expected);
  });

  test('user and path filters', () => {
    const a = { listenerId: 1, username: 'ann', action: 'UPLOAD', path: '/incoming/a.csv', success: true };
    expect(matchesWebhook(hook(), 'upload', a)).toBe(true);
    expect(matchesWebhook(hook(), 'download', a)).toBe(false);
    expect(matchesWebhook(hook({ enabled: false }), 'upload', a)).toBe(false);
    expect(matchesWebhook(hook({ usernameFilter: 'bob' }), 'upload', a)).toBe(false);
    expect(matchesWebhook(hook({ usernameFilter: 'ann' }), 'upload', a)).toBe(true);
    expect(matchesWebhook(hook({ pathPrefix: '/incoming' }), 'upload', a)).toBe(true);
    expect(matchesWebhook(hook({ pathPrefix: '/incoming/' }), 'upload', a)).toBe(true);
    expect(matchesWebhook(hook({ pathPrefix: '/inc' }), 'upload', a)).toBe(false); // not a path segment
  });

  test('Slack format is a single readable text message', () => {
    const body = JSON.parse(buildPayload(hook({ format: 'slack' }), 'upload', { listenerId: 1, username: 'ann', action: 'UPLOAD', path: '/a.csv', success: true, bytes: 42 }));
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toBe('⬆️ Upload: *ann* UPLOAD `/a.csv` (42 bytes)');
  });

  test.each([
    [{ name: '', url: 'https://x', events: ['upload'] }, /name/],
    [{ name: 'a', url: 'not a url', events: ['upload'] }, /URL/],
    [{ name: 'a', url: 'ftp://x', events: ['upload'] }, /http/],
    [{ name: 'a', url: 'https://x', events: ['nope'] }, /event/],
  ])('rejects invalid input %j', (input, message) => {
    expect(() => validateWebhookInput(input)).toThrow(message);
  });

  test('normalises input', () => {
    expect(validateWebhookInput({ name: ' n ', url: 'https://h.example/x', events: 'upload,delete,upload', pathPrefix: 'in', usernameFilter: '', format: 'slack' }))
      .toEqual({ name: 'n', url: 'https://h.example/x', events: ['upload', 'delete'], pathPrefix: '/in', usernameFilter: null, format: 'slack' });
  });
});

describe('delivery', () => {
  let dir: string;
  let db: DatabaseManager;
  let dispatcher: WebhookDispatcher;
  let rx: Awaited<ReturnType<typeof receiver>>;

  beforeEach(async () => {
    dir = makeTempDir('wh');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    rx = await receiver();
    dispatcher = new WebhookDispatcher(db, { retries: 2, retryDelayMs: 10, timeoutMs: 300 });
  });

  afterEach(async () => {
    dispatcher.stop();
    await rx.close();
    db.close();
    removeDir(dir);
  });

  const log = (over: any = {}) => db.logActivity({ listenerId: 1, username: 'ann', action: 'UPLOAD', path: '/in/report.pdf', success: true, bytes: 1234, ...over });

  test('matching activity is POSTed as signed JSON and the status recorded', async () => {
    const id = db.createWebhook({ name: 'all uploads', url: rx.url, events: ['upload'], format: 'json', secret: 's3cret', enabled: true });
    log();
    log({ action: 'LIST' });
    await dispatcher.idle();

    expect(rx.received).toHaveLength(1);
    const [msg] = rx.received;
    expect(msg.json).toMatchObject({ event: 'upload', username: 'ann', action: 'UPLOAD', path: '/in/report.pdf', bytes: 1234, success: true, server: 'SLightSFTP' });
    expect(msg.headers['x-slightsftp-event']).toBe('upload');
    expect(msg.headers['x-slightsftp-signature']).toBe('sha256=' + crypto.createHmac('sha256', 's3cret').update(msg.body).digest('hex'));
    expect(msg.headers['x-slightsftp-signature']).toBe(signPayload('s3cret', msg.body));
    expect(db.getWebhook(id)!.lastStatus).toBe('OK 200');
  });

  test('filters and disabled hooks are respected', async () => {
    db.createWebhook({ name: 'bob only', url: rx.url, events: ['upload'], format: 'json', usernameFilter: 'bob', enabled: true });
    db.createWebhook({ name: 'off', url: rx.url, events: ['upload'], format: 'json', enabled: false });
    db.createWebhook({ name: 'other path', url: rx.url, events: ['upload'], format: 'json', pathPrefix: '/out', enabled: true });
    log();
    await dispatcher.idle();
    expect(rx.received).toHaveLength(0);
  });

  test('server errors are retried; client errors are not', async () => {
    const retried = db.createWebhook({ name: 'flaky', url: rx.url, events: ['upload'], format: 'json', enabled: true });
    rx.respondWith(500, 503, 200);
    log();
    await dispatcher.idle();
    expect(rx.received).toHaveLength(3);
    expect(db.getWebhook(retried)!.lastStatus).toBe('OK 200');

    db.updateWebhook(retried, { enabled: false });
    const rejected = db.createWebhook({ name: 'bad', url: rx.url, events: ['upload'], format: 'json', enabled: true });
    rx.received.length = 0;
    rx.respondWith(404);
    log();
    await dispatcher.idle();
    expect(rx.received).toHaveLength(1);
    expect(db.getWebhook(rejected)!.lastStatus).toBe('HTTP 404');
  });

  test('slow and unreachable endpoints fail without blocking anything', async () => {
    const slow = db.createWebhook({ name: 'slow', url: rx.url, events: ['upload'], format: 'json', enabled: true });
    const dead = db.createWebhook({ name: 'dead', url: `http://127.0.0.1:${await getFreePort()}/x`, events: ['upload'], format: 'json', enabled: true });
    rx.delay(1000);
    const started = Date.now();
    log(); // logging itself must return immediately
    expect(Date.now() - started).toBeLessThan(200);
    await dispatcher.idle();
    expect(db.getWebhook(slow)!.lastStatus).toMatch(/Timed out after 300 ms/);
    expect(db.getWebhook(dead)!.lastStatus).toMatch(/ECONNREFUSED/);
  });

  test('test() sends a sample event once', async () => {
    const id = db.createWebhook({ name: 't', url: rx.url, events: ['upload'], format: 'slack', enabled: true });
    const result = await dispatcher.test(db.getWebhook(id)!, 'admin');
    expect(result).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(rx.received[0].json.text).toMatch(/^✅ Test: \*admin\* TEST/);
  });
});

describe('end to end: an SFTP upload fires a webhook; managed through the REST API', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let dispatcher: WebhookDispatcher;
  let rx: Awaited<ReturnType<typeof receiver>>;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;

  beforeAll(async () => {
    dir = makeTempDir('wh-e2e');
    fs.mkdirSync(path.join(dir, 'root', 'incoming'), { recursive: true });
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const userId = db.createUser({ username: 'uploader', password: 'Upload-Pass1', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    sftpPort = await getFreePort();
    const listenerId = db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true });
    db.subscribeUserToListener(userId, listenerId);

    rx = await receiver();
    dispatcher = new WebhookDispatcher(db, { retryDelayMs: 10 });
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    const webPort = await getFreePort();
    web = new WebServer(db, manager, webPort, { webhooks: dispatcher });
    await web.start();
    admin = request.agent(`http://127.0.0.1:${webPort}`);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    dispatcher.stop();
    await manager.stopAllListeners();
    await web.stop();
    await rx.close();
    db.close();
    removeDir(dir);
  });

  test('CRUD through the API never returns the secret', async () => {
    await admin.post('/api/webhooks').send({ name: 'x', url: 'nope', events: ['upload'] }).expect(400);
    const created = await admin.post('/api/webhooks')
      .send({ name: 'Incoming files', url: rx.url, events: ['upload', 'delete'], pathPrefix: '/incoming', format: 'json', secret: 'k' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Incoming files', events: ['upload', 'delete'], pathPrefix: '/incoming', hasSecret: true, enabled: true });
    expect(created.body).not.toHaveProperty('secret');
    expect((await admin.get('/api/webhooks').expect(200)).body).toHaveLength(1);

    const updated = await admin.put(`/api/webhooks/${created.body.id}`).send({ enabled: false }).expect(200);
    expect(updated.body.enabled).toBe(false);
    await admin.put(`/api/webhooks/${created.body.id}`).send({ enabled: true }).expect(200);
    await admin.put('/api/webhooks/999').send({ enabled: true }).expect(404);
  });

  test('a real SFTP upload into /incoming is delivered with its size; other paths are not', async () => {
    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: sftpPort, username: 'uploader', password: 'Upload-Pass1', readyTimeout: 5000 });
    try {
      await client.put(Buffer.from('elsewhere'), '/other.txt');
      await client.put(Buffer.alloc(2048, 1), '/incoming/data.bin');
    } finally {
      await client.end();
    }
    const msg = await waitFor(() => rx.received.find(r => r.json?.path === '/incoming/data.bin'));
    expect(msg!.json).toMatchObject({ event: 'upload', username: 'uploader', action: 'UPLOAD', bytes: 2048 });
    await dispatcher.idle();
    expect(rx.received.some(r => r.json?.path === '/other.txt')).toBe(false);
  });

  test('"Send test event" and delete through the API', async () => {
    const [hookRow] = (await admin.get('/api/webhooks')).body;
    const test = await admin.post(`/api/webhooks/${hookRow.id}/test`).expect(200);
    expect(test.body).toMatchObject({ ok: true, status: 200 });
    expect(rx.received.at(-1)!.json).toMatchObject({ event: 'test', username: 'admin' });

    await admin.delete(`/api/webhooks/${hookRow.id}`).expect(200);
    expect((await admin.get('/api/webhooks')).body).toEqual([]);
  });
});
