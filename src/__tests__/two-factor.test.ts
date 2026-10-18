/**
 * two-factor.test.ts — TOTP implementation and two-factor sign-in for the web
 * admin GUI and the file portal.
 */
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import { WebServer } from '../web-server';
import { TotpReplayGuard, base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totp, verifyTotp } from '../totp';
import { saveGuardSettings, getLoginGuard } from '../login-guard';
import { getFreePort, makeTempDir, removeDir, FULL_VPATH_PERMS } from './helpers/test-env';

jest.setTimeout(30000);

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  test.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']])(
    'RFC 6238 SHA-1 vector at T=%i → %s', (seconds, code) => {
      expect(totp(rfcSecret, seconds * 1000)).toBe(code);
    });

  test('RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 9].map(c => hotp(rfcSecret, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });

  test('base32 round-trips and generated secrets are 160-bit', () => {
    const raw = Buffer.from([0, 1, 2, 250, 255, 7, 8]);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t qojq'.toUpperCase()).toString()).toBe('1234567890');
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
    expect(() => base32Decode('ABC1')).toThrow();
  });

  test('accepts one step of clock drift, rejects malformed codes', () => {
    const s = generateTotpSecret();
    const t = 1_800_000_000_000;
    expect(verifyTotp(s, totp(s, t), t)).not.toBeNull();
    expect(verifyTotp(s, totp(s, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(s, totp(s, t + 30_000), t)).not.toBeNull();
    expect(verifyTotp(s, totp(s, t + 90_000), t)).toBeNull();
    expect(verifyTotp(s, '12345', t)).toBeNull();
    expect(verifyTotp(s, 'abcdef', t)).toBeNull();
    expect(verifyTotp(s, ` ${totp(s, t).slice(0, 3)} ${totp(s, t).slice(3)} `, t)).not.toBeNull();
  });

  test('a code can only be used once', () => {
    const s = generateTotpSecret();
    const g = new TotpReplayGuard();
    const t = 1_800_000_000_000;
    expect(g.check('u', s, totp(s, t), t)).toBe(true);
    expect(g.check('u', s, totp(s, t), t)).toBe(false);
    expect(g.check('u', s, totp(s, t - 30_000), t)).toBe(false); // older step
    expect(g.check('u', s, totp(s, t + 30_000), t)).toBe(true);
    expect(g.check('v', s, totp(s, t), t)).toBe(true); // per user
  });

  test('otpauth URI for authenticator apps', () => {
    expect(otpauthUrl('ABC', 'ann')).toBe('otpauth://totp/SLightSFTP%3Aann?secret=ABC&issuer=SLightSFTP&algorithm=SHA1&digits=6&period=30');
  });
});

describe('two-factor sign-in', () => {
  let dir: string;
  let db: DatabaseManager;
  let web: WebServer;
  let base: string;
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const nextStep = () => { offset += 30_000; };
  const codeFor = (username: string) => totp(db.getUser(username)!.totpSecret!, Date.now());

  beforeAll(async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    dir = makeTempDir('2fa');
    fs.mkdirSync(path.join(dir, 'root'));
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    saveGuardSettings(db, { maxFailures: 50, allowlist: '' });
    db.createUser({ username: 'admin', password: 'Admin-Pass-1', passwordEnabled: true, guiEnabled: true });
    db.createUser({ username: 'ops', password: 'Ops-Pass-123', passwordEnabled: true, guiEnabled: true });
    const pid = db.createUser({ username: 'paula', password: 'Paula-Pass1', passwordEnabled: true, guiEnabled: false, portalEnabled: true });
    db.addVirtualPath({ userId: pid, virtualPath: '/', localPath: path.join(dir, 'root'), ...FULL_VPATH_PERMS });
    const port = await getFreePort();
    web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    (Date.now as jest.Mock).mockRestore();
    await web.stop();
    db.close();
    removeDir(dir);
  });

  describe('web admin GUI', () => {
    let session: ReturnType<typeof request.agent>;
    let secret: string;

    beforeAll(async () => {
      session = request.agent(base);
      await session.post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
    });

    test('setup returns a secret, otpauth URI and QR code; nothing is enabled until confirmed', async () => {
      const res = await session.post('/api/2fa/setup').expect(200);
      secret = res.body.secret;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(res.body.otpauthUrl).toContain(`secret=${secret}`);
      expect(res.body.qrSvg).toContain('<svg');
      expect(db.getUser('admin')!.totpEnabled).toBe(false);
      expect((await session.get('/api/user')).body.totpEnabled).toBe(false);
    });

    test('a wrong confirmation code is refused; the right one turns 2FA on', async () => {
      await session.post('/api/2fa/enable').send({ code: '000000' }).expect(400);
      await session.post('/api/2fa/enable').send({ code: totp(secret, Date.now()) }).expect(200);
      expect(db.getUser('admin')!.totpEnabled).toBe(true);
      expect((await session.get('/api/user')).body.totpEnabled).toBe(true);
    });

    test('secrets never leave the server', async () => {
      const users = (await session.get('/api/users')).body;
      expect(users.find((u: any) => u.username === 'admin')).toMatchObject({ totpEnabled: true });
      expect(JSON.stringify(users)).not.toContain(secret);
      expect(users.every((u: any) => !('totpSecret' in u) && !('totpPendingSecret' in u) && !('password' in u))).toBe(true);
    });

    test('signing in now needs the code; wrong codes count as failures; codes cannot be replayed', async () => {
      const noCode = await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(401);
      expect(noCode.body).toEqual({ error: 'Enter the code from your authenticator app', requireTotp: true });

      const before = db.getRecentActivities(undefined, 200).filter(a => a.path === 'Invalid two-factor code').length;
      const wrong = await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1', totp: '123456' }).expect(401);
      expect(wrong.body).toEqual({ error: 'Invalid two-factor code', requireTotp: true });
      expect(db.getRecentActivities(undefined, 200).filter(a => a.path === 'Invalid two-factor code').length).toBe(before + 1);

      nextStep();
      const code = codeFor('admin');
      await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1', totp: code }).expect(200);
      await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1', totp: code }).expect(401); // replay

      // the wrong password is still rejected before the code is even considered
      await request(base).post('/api/login').send({ username: 'admin', password: 'nope', totp: code }).expect(401);
    });

    test('admins can reset another user\'s 2FA, but cannot switch it on for them', async () => {
      const ops = request.agent(base);
      await ops.post('/api/login').send({ username: 'ops', password: 'Ops-Pass-123' }).expect(200);
      const s = (await ops.post('/api/2fa/setup')).body.secret;
      nextStep();
      await ops.post('/api/2fa/enable').send({ code: totp(s, Date.now()) }).expect(200);

      await session.put('/api/users/ops').send({ totpEnabled: false }).expect(200);
      expect(db.getUser('ops')).toMatchObject({ totpEnabled: false, totpSecret: null });
      await session.put('/api/users/paula').send({ totpEnabled: true }).expect(200);
      expect(db.getUser('paula')!.totpEnabled).toBe(false);
      await request(base).post('/api/login').send({ username: 'ops', password: 'Ops-Pass-123' }).expect(200);
    });

    test('turning it off requires a current code', async () => {
      await session.post('/api/2fa/disable').send({ code: '000000' }).expect(400);
      nextStep();
      await session.post('/api/2fa/disable').send({ code: codeFor('admin') }).expect(200);
      expect(db.getUser('admin')).toMatchObject({ totpEnabled: false, totpSecret: null });
      await request(base).post('/api/login').send({ username: 'admin', password: 'Admin-Pass-1' }).expect(200);
    });
  });

  describe('file portal', () => {
    test('setup, sign-in with a code, and disable', async () => {
      const paula = request.agent(base);
      await paula.post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1' }).expect(200);
      expect((await paula.get('/portal/api/me')).body.totpEnabled).toBe(false);
      const setup = await paula.post('/portal/api/2fa/setup').expect(200);
      nextStep();
      await paula.post('/portal/api/2fa/enable').send({ code: 'nope' }).expect(400);
      await paula.post('/portal/api/2fa/enable').send({ code: totp(setup.body.secret, Date.now()) }).expect(200);

      const next = request.agent(base);
      expect((await next.post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1' }).expect(401)).body.requireTotp).toBe(true);
      await next.post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1', totp: '111111' }).expect(401);
      nextStep();
      await next.post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1', totp: codeFor('paula') }).expect(200);
      expect((await next.get('/portal/api/me')).body.totpEnabled).toBe(true);

      nextStep();
      await next.post('/portal/api/2fa/disable').send({ code: codeFor('paula') }).expect(200);
      await request(base).post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1' }).expect(200);
    });

    test('wrong codes feed brute-force protection', async () => {
      saveGuardSettings(db, { maxFailures: 3 });
      const s = (await (async () => {
        const a = request.agent(base);
        await a.post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1' }).expect(200);
        return (await a.post('/portal/api/2fa/setup')).body.secret;
      })());
      nextStep();
      db.updateUser('paula', { totpSecret: s, totpEnabled: true });
      for (let i = 0; i < 3; i++) {
        await request(base).post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1', totp: '999999' }).expect(401);
      }
      await request(base).post('/portal/api/login').send({ username: 'paula', password: 'Paula-Pass1', totp: totp(s, Date.now()) }).expect(429);
      getLoginGuard(db).unban('127.0.0.1');
      saveGuardSettings(db, { maxFailures: 50 });
    });
  });
});
