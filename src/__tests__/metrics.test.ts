/**
 * Monitoring endpoints: Prometheus metrics behind an API token, and open
 * health checks that report a listener that is not running.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { createApiToken } from '../api-tokens';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

const SftpClient = require('ssh2-sftp-client');
jest.setTimeout(30000);

describe('metrics and health checks', () => {
  let dir: string;
  let db: DatabaseManager;
  let manager: ServerManager;
  let web: WebServer;
  let base: string;
  let token: string;
  let sftpPort: number;
  let sftpId: number;

  const metric = (text: string, line: string) => text.split('\n').find(l => l.startsWith(line));

  beforeAll(async () => {
    dir = makeTempDir('metrics');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    db.createUser({ username: 'ro', password: 'Viewer-Pass-1', passwordEnabled: true, guiEnabled: true, guiRole: 'viewer' } as any);
    const mo = db.createUser({ username: 'mo', password: 'Mo-Pass-1234', passwordEnabled: true, guiEnabled: false });
    db.addVirtualPath({ userId: mo, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    sftpPort = await getFreePort();
    sftpId = db.createListener({ name: 'Main SFTP', protocol: 'SFTP', bindingIp: '127.0.0.1', port: sftpPort, enabled: true });
    db.subscribeUserToListener(mo, sftpId);
    manager = new ServerManager(db);
    await manager.startAllEnabledListeners();
    const port = await getFreePort();
    web = new WebServer(db, manager, port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
    token = createApiToken(db, 'ro', 'prometheus').token;
  });

  afterAll(async () => {
    await manager.stopAllListeners();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  test('/metrics needs an API token (a read-only user\'s is enough)', async () => {
    await request(base).get('/metrics').expect(401);
    await request(base).get('/metrics').set('Authorization', 'Bearer sst_wrong').expect(401);
    const res = await request(base).get('/metrics').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain;.*version=0\.0\.4/);
    expect(res.text).toMatch(/slightsftp_info\{version="\d+\.\d+\.\d+.*"\} 1/);
    expect(res.text).toContain('slightsftp_process_resident_memory_bytes');
    expect(metric(res.text, `slightsftp_listener_up{listener="Main SFTP",protocol="SFTP",port="${sftpPort}"}`)).toMatch(/ 1$/);
  });

  test('sign-ins, sessions and transfers are counted', async () => {
    const bad = new SftpClient();
    await expect(bad.connect({ host: '127.0.0.1', port: sftpPort, username: 'mo', password: 'wrong', readyTimeout: 5000 })).rejects.toThrow();

    const client = new SftpClient();
    await client.connect({ host: '127.0.0.1', port: sftpPort, username: 'mo', password: 'Mo-Pass-1234', readyTimeout: 5000 });
    await client.put(Buffer.alloc(2048, 'a'), '/up.bin');
    await client.get('/up.bin');
    let text = (await request(base).get('/metrics').set('Authorization', `Bearer ${token}`)).text;
    expect(metric(text, 'slightsftp_sessions{protocol="SFTP"}')).toBe('slightsftp_sessions{protocol="SFTP"} 1');
    await client.end();

    text = (await request(base).get('/metrics').set('Authorization', `Bearer ${token}`)).text;
    expect(metric(text, 'slightsftp_logins_total{protocol="SFTP",result="failure"}')).toMatch(/ [1-9]\d*$/);
    expect(metric(text, 'slightsftp_logins_total{protocol="SFTP",result="success"}')).toMatch(/ [1-9]\d*$/);
    expect(metric(text, 'slightsftp_transfers_total{protocol="SFTP",direction="upload"}')).toBe('slightsftp_transfers_total{protocol="SFTP",direction="upload"} 1');
    expect(metric(text, 'slightsftp_transfer_bytes_total{protocol="SFTP",direction="upload"}')).toBe('slightsftp_transfer_bytes_total{protocol="SFTP",direction="upload"} 2048');
    expect(metric(text, 'slightsftp_transfers_total{protocol="SFTP",direction="download"}')).toMatch(/ 1$/);

    // web GUI sign-ins are counted as "web"
    await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
    text = (await request(base).get('/metrics').set('Authorization', `Bearer ${token}`)).text;
    expect(metric(text, 'slightsftp_logins_total{protocol="web",result="success"}')).toMatch(/ [1-9]\d*$/);
  });

  test('/healthz and /readyz answer without sign-in; /readyz fails while an enabled listener is down', async () => {
    expect((await request(base).get('/healthz').expect(200)).body).toEqual({ status: 'ok' });
    const ready = await request(base).get('/readyz').expect(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { database: true, listeners: { enabled: 1, running: 1 } } });

    await manager.stopListener(sftpId);
    const down = await request(base).get('/readyz').expect(503);
    expect(down.body).toMatchObject({ status: 'unavailable', checks: { listeners: { enabled: 1, running: 0 } } });
    await request(base).get('/healthz').expect(200); // still alive
    const text = (await request(base).get('/metrics').set('Authorization', `Bearer ${token}`)).text;
    expect(metric(text, 'slightsftp_listener_up{listener="Main SFTP"')).toMatch(/ 0$/);

    await manager.startListener(sftpId);
    await request(base).get('/readyz').expect(200);
  });
});
