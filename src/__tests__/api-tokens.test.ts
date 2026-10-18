/**
 * api-tokens.test.ts — personal access tokens for the REST API.
 */
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { hashToken } from '../api-tokens';
import { getLoginGuard, saveGuardSettings } from '../login-guard';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';

jest.setTimeout(30000);

describe('REST API tokens', () => {
  let dir: string;
  let db: DatabaseManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let token: string;
  let tokenId: number;

  beforeAll(async () => {
    dir = makeTempDir('tokens');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    saveGuardSettings(db, { maxFailures: 3, allowlist: '' });
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    db.createUser({ username: 'ops', password: 'Ops-Pass-123', passwordEnabled: true, guiEnabled: true });
    const port = await getFreePort();
    web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    admin = request.agent(base);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await web.stop();
    db.close();
    removeDir(dir);
  });

  afterEach(() => getLoginGuard(db).unban('127.0.0.1'));

  test('creating a token returns it once; only its hash is stored', async () => {
    await admin.post('/api/tokens').send({ name: '' }).expect(400);
    await admin.post('/api/tokens').send({ name: 'x', expiresInDays: 0 }).expect(400);
    const res = await admin.post('/api/tokens').send({ name: 'backup script', expiresInDays: 30 }).expect(201);
    token = res.body.token;
    tokenId = res.body.id;
    expect(token).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ name: 'backup script', username: 'admin', hint: token.slice(0, 10), lastUsedAt: null });
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const raw = JSON.stringify((db as any).db.exec('SELECT * FROM api_tokens'));
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));

    const list = await admin.get('/api/tokens').expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  test('a bearer token authenticates API calls as its owner and records use', async () => {
    const me = await request(base).get('/api/user').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.username).toBe('admin');
    await request(base).get('/api/users').set('Authorization', `Bearer ${token}`).expect(200);
    await request(base).post('/api/listeners').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Scripted', protocol: 'SFTP', bindingIp: '127.0.0.1', port: await getFreePort(), enabled: false }).expect(200);
    expect(db.getAllListeners().map(l => l.name)).toContain('Scripted');
    expect((await admin.get('/api/tokens')).body[0].lastUsedAt).not.toBeNull();
  });

  test('invalid tokens are rejected and count towards brute-force bans', async () => {
    for (const bad of ['sst_nope', 'garbage', `${token}x`]) {
      await request(base).get('/api/users').set('Authorization', `Bearer ${bad}`).expect(401);
    }
    await request(base).get('/api/users').set('Authorization', `Bearer ${token}`).expect(429);
  });

  test('tokens stop working when expired, when the user loses GUI access, or when revoked', async () => {
    (db as any).db.run('UPDATE api_tokens SET expiresAt = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), tokenId]);
    await request(base).get('/api/user').set('Authorization', `Bearer ${token}`).expect(401);
    (db as any).db.run('UPDATE api_tokens SET expiresAt = NULL WHERE id = ?', [tokenId]);
    await request(base).get('/api/user').set('Authorization', `Bearer ${token}`).expect(200);

    db.updateUser('admin', { guiEnabled: false });
    await request(base).get('/api/user').set('Authorization', `Bearer ${token}`).expect(401);
    db.updateUser('admin', { guiEnabled: true });
    getLoginGuard(db).unban('127.0.0.1');

    await admin.delete(`/api/tokens/${tokenId}`).expect(200);
    await request(base).get('/api/user').set('Authorization', `Bearer ${token}`).expect(401);
  });

  test("users only see and revoke their own tokens", async () => {
    const ops = request.agent(base);
    await ops.post('/api/login').send({ username: 'ops', password: 'Ops-Pass-123' }).expect(200);
    const mine = (await admin.post('/api/tokens').send({ name: 'admin only' }).expect(201)).body;
    expect((await ops.get('/api/tokens').expect(200)).body).toEqual([]);
    await ops.delete(`/api/tokens/${mine.id}`).expect(404);
    expect(mine.expiresAt).toBeNull();
  });
});
