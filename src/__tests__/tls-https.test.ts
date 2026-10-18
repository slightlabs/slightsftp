/**
 * tls-https.test.ts — server certificate management and the web GUI over HTTPS.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import WebSocket from 'ws';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { CERT_FILE, KEY_FILE, generateSelfSigned, getServerCertificate, setCertificateDir } from '../tls';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';

jest.setTimeout(30000);

describe('server certificate', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tls');
    setCertificateDir(dir);
  });

  afterEach(() => removeDir(dir));

  test('generates a self-signed server certificate once and reuses it', async () => {
    const [a, b] = await Promise.all([getServerCertificate(), getServerCertificate()]);
    expect(a.fingerprint256).toBe(b.fingerprint256);
    expect(a.selfSigned).toBe(true);
    expect(a.subject).toContain('CN=SLightSFTP');

    const x509 = new crypto.X509Certificate(a.cert);
    expect(x509.subjectAltName).toContain('DNS:localhost');
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(new Date(x509.validTo).getTime()).toBeGreaterThan(Date.now() + 700 * 24 * 3600 * 1000);

    expect(fs.readFileSync(path.join(dir, CERT_FILE), 'utf8')).toBe(a.cert);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o077).toBe(0);
    }
  });

  test('a certificate already on disk survives a restart', async () => {
    const first = await getServerCertificate();
    setCertificateDir(dir); // drops the in-memory cache, like a new process
    expect((await getServerCertificate()).fingerprint256).toBe(first.fingerprint256);
  });

  test('a user-supplied certificate takes precedence', async () => {
    const own = await generateSelfSigned(['files.example.com']);
    fs.writeFileSync(path.join(dir, 'own.crt'), own.cert);
    fs.writeFileSync(path.join(dir, 'own.key'), own.key);
    const cert = await getServerCertificate({ certPath: path.join(dir, 'own.crt'), keyPath: path.join(dir, 'own.key') });
    expect(cert.selfSigned).toBe(false);
    expect(new crypto.X509Certificate(cert.cert).subjectAltName).toContain('DNS:files.example.com');
    expect(fs.existsSync(path.join(dir, CERT_FILE))).toBe(false);
  });

  test('a key that does not match the certificate is rejected', async () => {
    const a = await generateSelfSigned();
    const b = await generateSelfSigned();
    fs.writeFileSync(path.join(dir, 'a.crt'), a.cert);
    fs.writeFileSync(path.join(dir, 'b.key'), b.key);
    await expect(getServerCertificate({ certPath: path.join(dir, 'a.crt'), keyPath: path.join(dir, 'b.key') }))
      .rejects.toThrow(/does not match/);
  });
});

describe('web GUI over HTTPS', () => {
  let dir: string;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let web: WebServer;
  let port: number;
  let fingerprint: string;

  const get = (p: string, opts: https.RequestOptions = {}) => new Promise<{ status: number; headers: any; body: string; peerFingerprint: string }>((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false, agent: false, ...opts }, res => {
      const peerFingerprint = (res.socket as any).getPeerCertificate().fingerprint256;
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body, peerFingerprint }));
    });
    req.on('error', reject);
    if (opts.method === 'POST') req.write(JSON.stringify({ username: 'admin', password: 'Https-Admin-1' }));
    req.end();
  });

  beforeAll(async () => {
    dir = makeTempDir('https');
    setCertificateDir(dir);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Https-Admin-1', passwordEnabled: true, guiEnabled: true });
    serverManager = new ServerManager(db);
    port = await getFreePort();
    const cert = await getServerCertificate();
    fingerprint = cert.fingerprint256;
    web = new WebServer(db, serverManager, port, { tls: cert });
    await web.start();
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    removeDir(dir);
  });

  test('serves the GUI with the server certificate', async () => {
    const res = await get('/login');
    expect(res.status).toBe(200);
    expect(res.peerFingerprint).toBe(fingerprint);
    expect(web.isHttps()).toBe(true);
    expect(web.getUrl()).toBe(`https://localhost:${port}`);
  });

  test('plain HTTP is not accepted on the HTTPS port', async () => {
    const http = require('http');
    await expect(new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/login' }, (res: any) => resolve(res.statusCode)).on('error', reject);
    }).then(status => (status === 400 ? Promise.reject(new Error('400')) : status))).rejects.toThrow();
  });

  test('session cookies are marked Secure and HttpOnly', async () => {
    const res = await get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  test('the Web GUI pseudo-listener reports HTTPS', async () => {
    const login = await get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
    const res = await get('/api/listener-statuses', { headers: { Cookie: sessionCookie } });
    expect(JSON.parse(res.body).find((s: any) => s.listener.id === -1).listener.protocol).toBe('HTTPS');
  });

  test('the live activity feed works over wss://', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.close();
  });
});
