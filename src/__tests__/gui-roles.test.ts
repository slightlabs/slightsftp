import request from 'supertest';
import { DatabaseManager } from '../database';
import { WebServer } from '../web-server';
import { viewerMayCallApi, viewerMayInvoke } from '../gui-roles';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const serverManager: any = {
  on: jest.fn(), off: jest.fn(), emit: jest.fn(),
  getActiveSessions: jest.fn().mockReturnValue([]),
  isListenerRunning: jest.fn().mockReturnValue(false),
  startListener: jest.fn(), stopListener: jest.fn(),
};

describe('GUI roles (REST API)', () => {
  let db: DatabaseManager;
  let app: any;
  let admin: ReturnType<typeof request.agent>;
  let viewer: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin#2026', passwordEnabled: true, publicKey: '', guiEnabled: true });
    app = new WebServer(db, serverManager, 0).getApp();
    admin = request.agent(app);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin#2026' }).expect(200);
    await admin.post('/api/users').send({ username: 'val', password: 'Viewer#2026', passwordEnabled: true, guiEnabled: true, guiRole: 'viewer' }).expect(200);
    viewer = request.agent(app);
    await viewer.post('/api/login').send({ username: 'val', password: 'Viewer#2026' }).expect(200);
  });
  afterEach(() => db.close());

  test('existing and new users are administrators unless made read-only', async () => {
    expect(db.getUser('admin')!.guiRole).toBe('admin');
    expect(db.getUser('val')!.guiRole).toBe('viewer');
    expect((await viewer.get('/api/user').expect(200)).body).toMatchObject({ username: 'val', guiRole: 'viewer' });
  });

  test('a read-only user can look at the dashboard data', async () => {
    for (const url of ['/api/listeners', '/api/users', '/api/activity', '/api/settings', '/api/sessions', '/api/listener-statuses', '/api/security/bans']) {
      await viewer.get(url).expect(200);
    }
  });

  test('a read-only user cannot change anything', async () => {
    const attempts: Array<[string, string, any?]> = [
      ['post', '/api/listeners', { name: 'x', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2999, enabled: false }],
      ['post', '/api/users', { username: 'mallory', password: 'Mallory#2026', guiEnabled: true }],
      ['put', '/api/users/admin', { password: 'Hijacked#2026' }],
      ['put', '/api/users/val', { guiRole: 'admin' }],
      ['delete', '/api/users/admin'],
      ['put', '/api/settings/logRetentionDays', { value: '1' }],
      ['put', '/api/security/settings', { enabled: false }],
      ['delete', '/api/activity'],
      ['post', '/api/backup/restore', {}],
    ];
    for (const [method, url, body] of attempts) {
      const res = await (viewer as any)[method](url).send(body);
      expect([method, url, res.status]).toEqual([method, url, 403]);
      expect(res.body.error).toBe('This account is read-only');
    }
    expect(db.getUser('mallory')).toBeUndefined();
    expect(db.getUser('val')!.guiRole).toBe('viewer');
  });

  test('a read-only user cannot download files or backups', async () => {
    await viewer.get('/api/backup').expect(403);
    await viewer.get('/api/files/download?username=admin&path=/x').expect(403);
  });

  test('share-link tokens and webhook URLs are hidden from read-only users', async () => {
    db.createShare({ token: 'secret-token-123', owner: 'admin', virtualPath: '/a.txt', type: 'download' } as any);
    db.createWebhook({ name: 'slack', url: 'https://hooks.slack.com/services/T0/B0/secret', events: ['upload'], format: 'json', enabled: true } as any);
    const shares = (await viewer.get('/api/shares').expect(200)).body;
    expect(JSON.stringify(shares)).not.toContain('secret-token-123');
    const hooks = (await viewer.get('/api/webhooks').expect(200)).body;
    expect(hooks[0].url).toBe('https://hooks.slack.com/…');
    // administrators still see them
    expect(JSON.stringify((await admin.get('/api/shares').expect(200)).body)).toContain('secret-token-123');
  });

  test('read-only users manage their own sign-in, and their API tokens are read-only too', async () => {
    const created = (await viewer.post('/api/tokens').send({ name: 'dash' }).expect(201)).body;
    await request(app).get('/api/listeners').set('Authorization', `Bearer ${created.token}`).expect(200);
    await request(app).post('/api/listeners').set('Authorization', `Bearer ${created.token}`).send({}).expect(403);
    await viewer.delete(`/api/tokens/${created.id}`).expect(200);
    await viewer.post('/api/change-password').send({ currentPassword: 'Viewer#2026', newPassword: 'Viewer#2027' }).expect(200);
  });

  test('the last administrator cannot be deleted, demoted or locked out', async () => {
    await admin.put('/api/users/admin').send({ guiRole: 'viewer' }).expect(400);
    await admin.put('/api/users/admin').send({ guiEnabled: false }).expect(400);
    await admin.delete('/api/users/admin').expect(400);
    // with a second administrator it is allowed
    await admin.put('/api/users/val').send({ guiRole: 'admin' }).expect(200);
    await admin.put('/api/users/admin').send({ guiRole: 'viewer' }).expect(200);
    expect(db.getUser('admin')!.guiRole).toBe('viewer');
  });

  test('a role change applies to an existing session at once', async () => {
    await admin.put('/api/users/val').send({ guiRole: 'admin' }).expect(200);
    await viewer.post('/api/listeners').send({ name: 'ok', protocol: 'SFTP', bindingIp: '127.0.0.1', port: 2998, enabled: false }).expect(200);
    await admin.put('/api/users/val').send({ guiRole: 'viewer' }).expect(200);
    await viewer.delete('/api/listeners/1').expect(403);
  });
});

describe('role policy', () => {
  test('API: reads yes (except file and backup downloads), writes only self-service', () => {
    expect(viewerMayCallApi('GET', '/listeners')).toBe(true);
    expect(viewerMayCallApi('GET', '/backup')).toBe(false);
    expect(viewerMayCallApi('GET', '/files/download')).toBe(false);
    expect(viewerMayCallApi('POST', '/2fa/enable')).toBe(true);
    expect(viewerMayCallApi('POST', '/listeners')).toBe(false);
    expect(viewerMayCallApi('DELETE', '/tokens/3')).toBe(true);
    expect(viewerMayCallApi('DELETE', '/users/admin')).toBe(false);
  });

  test('desktop IPC: get-* and self-service only', () => {
    expect(viewerMayInvoke('get-all-users')).toBe(true);
    expect(viewerMayInvoke('totp-enable')).toBe(true);
    expect(viewerMayInvoke('create-user')).toBe(false);
    expect(viewerMayInvoke('download-file')).toBe(false);
    expect(viewerMayInvoke('export-backup')).toBe(false);
    expect(viewerMayInvoke('import-backup')).toBe(false);
  });
});
