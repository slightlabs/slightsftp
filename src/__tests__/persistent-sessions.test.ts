/**
 * Web GUI and portal sign-ins are kept in the database: a restart does not
 * sign anyone out, only token hashes are stored, and backups leave them out.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { createBackup, restoreBackup } from '../backup';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { SessionStore } from '../sessions';
import { SqliteDatabase } from '../sqlite';
import { setCertificateDir } from '../tls';
import { WebServer } from '../web-server';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';

jest.setTimeout(30000);

describe('persistent sessions', () => {
  let dir: string;
  let dbFile: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;

  const startWeb = async () => {
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
  };

  const cookieFrom = (res: request.Response, name: string): string => {
    const header = ([] as string[]).concat(res.headers['set-cookie'] || []).find(c => c.startsWith(`${name}=`));
    if (!header) throw new Error(`no ${name} cookie`);
    return header.split(';')[0];
  };

  beforeAll(async () => {
    dir = makeTempDir('sessions');
    setCertificateDir(path.join(dir, 'keys'));
    dbFile = path.join(dir, 'config.db');
    db = new DatabaseManager(dbFile);
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const pat = db.createUser({ username: 'pat', password: 'Portal-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: pat, virtualPath: '/', localPath: dir, canRead: true, canList: true, canWrite: false });
    manager = new ServerManager(db);
    await startWeb();
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    setCertificateDir(process.env.SLIGHTSFTP_CERT_DIR!);
    removeDir(dir);
  });

  test('an admin session and a portal session survive a server restart', async () => {
    const admin = cookieFrom(await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200), 'sessionId');
    const portal = await request(base).post('/portal/api/login').send({ username: 'pat', password: 'Portal-Pass1' }).expect(200);
    const portalCookie = ([] as string[]).concat(portal.headers['set-cookie']).map(c => c.split(';')[0]).join('; ');

    // restart: a new web server and a fresh connection to the same database file
    await web.stop();
    db.close();
    db = new DatabaseManager(dbFile);
    await db.init();
    manager = new ServerManager(db);
    await startWeb();

    const me = await request(base).get('/api/user').set('Cookie', admin).expect(200);
    expect(me.body.username).toBe('admin');
    const portalMe = await request(base).get('/portal/api/me').set('Cookie', portalCookie).expect(200);
    expect(portalMe.body.username).toBe('pat');
  });

  test('only a hash of the session token is stored', async () => {
    const cookie = cookieFrom(await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200), 'sessionId');
    const token = cookie.split('=')[1];
    const raw = new SqliteDatabase(dbFile, { readOnly: true });
    const rows = raw.exec('SELECT tokenHash FROM web_sessions')[0].values.map(r => String(r[0]));
    raw.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).not.toContain(token);
    expect(rows.every(r => /^[0-9a-f]{64}$/.test(r))).toBe(true);
  });

  test('logout, user deletion and expiry end sessions in the database too', async () => {
    const login = async () => cookieFrom(await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200), 'sessionId');
    const a = await login();
    await request(base).post('/api/logout').set('Cookie', a).expect(200);
    await request(base).get('/api/user').set('Cookie', a).expect(401);

    db.createUser({ username: 'temp', password: 'Temp-Pass-1', passwordEnabled: true, guiEnabled: true });
    const t = cookieFrom(await request(base).post('/api/login').send({ username: 'temp', password: 'Temp-Pass-1' }).expect(200), 'sessionId');
    await request(base).get('/api/user').set('Cookie', t).expect(200);
    const admin = await login();
    await request(base).delete('/api/users/temp').set('Cookie', admin).expect(200);
    await request(base).get('/api/user').set('Cookie', t).expect(401);
    const raw = new SqliteDatabase(dbFile, { readOnly: true });
    expect(raw.exec("SELECT * FROM web_sessions WHERE username = 'temp'")).toEqual([]);
    raw.close();

    // a store with a 1 ms lifetime: the session is expired by the time it is read
    const store = new SessionStore(db, 'admin', 1);
    store.create('expiring-token', { username: 'admin', createdAt: Date.now() - 10, mustChangePassword: false });
    expect(store.get('expiring-token')).toBeUndefined();
    store.create('old-token', { username: 'admin', createdAt: Date.now() - 10, mustChangePassword: false });
    store.sweep();
    expect(new SessionStore(db, 'admin', 60_000).get('old-token')).toBeUndefined();
  });

  test('a forced password change is remembered across a restart', async () => {
    db.createUser({ username: 'newbie', password: 'Newbie-Pass-1', passwordEnabled: true, guiEnabled: true, mustChangePassword: true });
    const res = await request(base).post('/api/login').send({ username: 'newbie', password: 'Newbie-Pass-1' }).expect(200);
    expect(res.body.requirePasswordChange).toBe(true);
    const cookie = cookieFrom(res, 'sessionId');
    await request(base).get('/api/users').set('Cookie', cookie).expect(403);
    await request(base).post('/api/change-password').set('Cookie', cookie).send({ newPassword: 'Brand-New-Pass-2' }).expect(200);

    await web.stop();
    await startWeb();
    await request(base).get('/api/users').set('Cookie', cookie).expect(200);
  });

  test('backups leave sessions out, and a restore keeps the people signed in now', async () => {
    const cookie = cookieFrom(await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200), 'sessionId');
    const bundle = createBackup(db, '0.0.0');
    const copy = path.join(dir, 'backup-copy.db');
    fs.writeFileSync(copy, Buffer.from(bundle.database, 'base64'));
    const raw = new SqliteDatabase(copy, { readOnly: true });
    expect(raw.exec('SELECT * FROM web_sessions')).toEqual([]);
    raw.close();

    await restoreBackup(db, bundle);
    await request(base).get('/api/user').set('Cookie', cookie).expect(200);
  });
});
