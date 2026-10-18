/**
 * ldap-auth.test.ts — directory sign-in against a real (in-process) LDAP
 * server, over SFTP, FTP, the web GUI and the portal.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import * as ftp from 'basic-ftp';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { LDAP_DEFAULT_FILTER, escapeFilterValue, ldapVerify, readLdapSettings, saveLdapSettings, testLdap } from '../ldap-auth';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const ldap = require('ldapjs');
const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

const BASE = 'dc=example,dc=com';
const SERVICE = { dn: `cn=svc,${BASE}`, password: 'svc-secret' };
const PEOPLE: Record<string, { password: string; attrs: Record<string, string> }> = {
  [`uid=dora,ou=people,${BASE}`]: { password: 'Dora-Directory-1', attrs: { uid: 'dora', objectClass: 'person', cn: 'Dora' } },
  [`cn=Ed Admin,ou=people,${BASE}`]: { password: 'Ed-Directory-1', attrs: { sAMAccountName: 'ed', objectClass: 'person', cn: 'Ed Admin' } },
  [`uid=twin1,ou=people,${BASE}`]: { password: 'x', attrs: { uid: 'twin', objectClass: 'person' } },
  [`uid=twin2,ou=people,${BASE}`]: { password: 'x', attrs: { uid: 'twin', objectClass: 'person' } },
};

/** A minimal directory: service-account bind, user binds, subtree search. */
function startDirectory(): Promise<{ url: string; close: () => void; searches: string[] }> {
  const server = ldap.createServer();
  const searches: string[] = [];
  server.bind(BASE, (req: any, res: any, next: any) => {
    const dn = req.dn.toString().replace(/\s/g, '').toLowerCase();
    const pw = req.credentials;
    const match = dn === SERVICE.dn.toLowerCase() ? SERVICE.password
      : Object.entries(PEOPLE).find(([d]) => d.replace(/\s/g, '').toLowerCase() === dn)?.[1].password;
    if (match === undefined || pw !== match) return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });
  server.search(BASE, (req: any, res: any, next: any) => {
    searches.push(req.filter.toString());
    for (const [dn, p] of Object.entries(PEOPLE)) {
      if (req.filter.matches(p.attrs)) res.send({ dn, attributes: p.attrs });
    }
    res.end();
    return next();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `ldap://127.0.0.1:${server.address().port}`, close: () => server.close(), searches })));
}

describe('LDAP helpers', () => {
  test('filter values are escaped (RFC 4515)', () => {
    expect(escapeFilterValue('a*b(c)\\d')).toBe('a\\2ab\\28c\\29\\5cd');
    expect(escapeFilterValue('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
  });
});

describe('directory sign-in', () => {
  let directory: Awaited<ReturnType<typeof startDirectory>>;
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let admin: ReturnType<typeof request.agent>;
  let sftpPort: number;
  let ftpPort: number;

  beforeAll(async () => {
    directory = await startDirectory();
    dir = makeTempDir('ldap');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    const dora = db.createUser({ username: 'dora', passwordEnabled: true, guiEnabled: true, portalEnabled: true, authSource: 'ldap' });
    db.addVirtualPath({ userId: dora, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    db.createUser({ username: 'ed', passwordEnabled: true, guiEnabled: true, authSource: 'ldap' });
    db.createUser({ username: 'twin', passwordEnabled: true, guiEnabled: true, authSource: 'ldap' });
    [sftpPort, ftpPort] = [await getFreePort(), await getFreePort()];
    db.subscribeUserToListener(dora, db.createListener({ name: 'S', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true }));
    db.subscribeUserToListener(dora, db.createListener({ name: 'F', protocol: 'FTP', bindingIp: '127.0.0.1', port: ftpPort, enabled: true }));
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    admin = request.agent(base);
    await admin.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    directory.close();
    removeDir(dir);
  });

  test('settings are validated; the bind password is never returned', async () => {
    await admin.put('/api/ldap').send({ url: 'http://nope' }).expect(400);
    await admin.put('/api/ldap').send({ enabled: true }).expect(400); // url + base DN required
    await admin.put('/api/ldap').send({ userFilter: '(uid=x)' }).expect(400);
    const saved = await admin.put('/api/ldap')
      .send({ enabled: true, url: directory.url, baseDn: BASE, bindDn: SERVICE.dn, bindPassword: SERVICE.password, tlsVerify: true })
      .expect(200);
    expect(saved.body).toEqual({ enabled: true, url: directory.url, bindDn: SERVICE.dn, baseDn: BASE, userFilter: LDAP_DEFAULT_FILTER, tlsVerify: true, hasBindPassword: true });
    // saving again with an empty password keeps the stored one
    await admin.put('/api/ldap').send({ bindPassword: '' }).expect(200);
    expect(readLdapSettings(db).bindPassword).toBe(SERVICE.password);
  });

  test('"test connection" binds and looks users up', async () => {
    expect((await admin.post('/api/ldap/test').send({}).expect(200)).body).toEqual({ ok: true, message: 'Connected' });
    expect((await admin.post('/api/ldap/test').send({ username: 'ed' })).body).toEqual({ ok: true, message: `Found cn=Ed Admin, ou=people, ${BASE}`.replace(/, /g, ',') });
    expect((await admin.post('/api/ldap/test').send({ username: 'twin' })).body.ok).toBe(false);
    expect((await testLdap({ ...readLdapSettings(db), bindPassword: 'wrong' })).ok).toBe(false);
  });

  test('passwords are checked against the directory (uid and sAMAccountName)', async () => {
    const s = readLdapSettings(db);
    expect(await ldapVerify(s, 'dora', 'Dora-Directory-1')).toBe(true);
    expect(await ldapVerify(s, 'ed', 'Ed-Directory-1')).toBe(true);
    expect(await ldapVerify(s, 'dora', 'wrong')).toBe(false);
    expect(await ldapVerify(s, 'dora', '')).toBe(false); // no unauthenticated binds
    expect(await ldapVerify(s, 'twin', 'x')).toBe(false); // ambiguous
    expect(await ldapVerify(s, 'nobody', 'x')).toBe(false);
    expect(await ldapVerify(s, '*', 'x')).toBe(false);
    expect(directory.searches.some(f => f.includes('\\2a'))).toBe(true); // "*" was escaped
  });

  test('SFTP and FTP accept the directory password, not anything else', async () => {
    const c = new SftpClient();
    await c.connect({ host: '127.0.0.1', port: sftpPort, username: 'dora', password: 'Dora-Directory-1', readyTimeout: 5000 });
    await c.put(Buffer.from('via ldap'), '/ldap.txt');
    await c.end();
    expect(fs.readFileSync(path.join(dir, 'root', 'ldap.txt'), 'utf8')).toBe('via ldap');
    await expect(new SftpClient().connect({ host: '127.0.0.1', port: sftpPort, username: 'dora', password: 'nope', readyTimeout: 5000, retries: 0 })).rejects.toThrow();

    const f = new ftp.Client(5000);
    await f.access({ host: '127.0.0.1', port: ftpPort, user: 'dora', password: 'Dora-Directory-1' });
    f.close();
  });

  test('web GUI and portal sign-in use the directory; password changes are refused', async () => {
    const web1 = request.agent(base);
    const res = await web1.post('/api/login').send({ username: 'ed', password: 'Ed-Directory-1' }).expect(200);
    expect(res.body.requirePasswordChange).toBeUndefined();
    await request(base).post('/api/login').send({ username: 'ed', password: 'wrong' }).expect(401);
    const change = await web1.post('/api/change-password').send({ currentPassword: 'Ed-Directory-1', newPassword: 'Something-New-1' }).expect(400);
    expect(change.body.error).toMatch(/directory/);

    const portal = request.agent(base);
    await portal.post('/portal/api/login').send({ username: 'dora', password: 'Dora-Directory-1' }).expect(200);
    await portal.post('/portal/api/change-password').send({ currentPassword: 'x', newPassword: 'Something-New-1' }).expect(400);
  });

  test('when directory sign-in is turned off, directory users cannot sign in; local users are unaffected', async () => {
    await admin.put('/api/ldap').send({ enabled: false }).expect(200);
    await request(base).post('/api/login').send({ username: 'ed', password: 'Ed-Directory-1' }).expect(401);
    await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
  });

  test('admins can switch a user between local and directory passwords', async () => {
    await admin.put('/api/users/ed').send({ authSource: 'local', password: 'Ed-Local-Pass1' }).expect(200);
    expect(db.getUser('ed')!.authSource).toBe('local');
    await request(base).post('/api/login').send({ username: 'ed', password: 'Ed-Local-Pass1' }).expect(200);
    await admin.post('/api/users').send({ username: 'newdir', passwordEnabled: true, guiEnabled: false, authSource: 'ldap' }).expect(200);
    expect(db.getUser('newdir')!.authSource).toBe('ldap');
  });

  test('an unreachable directory fails closed', async () => {
    const s = { ...readLdapSettings(db), enabled: true, url: `ldap://127.0.0.1:${await getFreePort()}` };
    expect(await ldapVerify(s, 'dora', 'Dora-Directory-1')).toBe(false);
  });
});
