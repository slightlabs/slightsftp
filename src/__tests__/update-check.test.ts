import * as http from 'http';
import * as path from 'path';
import { DatabaseManager } from '../database';
import { checkForUpdate, compareVersions, resetUpdateCache } from '../update-check';
import { makeTempDir, removeDir } from './helpers/test-env';

describe('update check', () => {
  let dir: string;
  let db: DatabaseManager;
  let server: http.Server;
  let url: string;
  let hits = 0;
  let release: any = { tag_name: 'v9.1.0', html_url: 'https://github.com/slightlabs/slightsftp/releases/tag/v9.1.0' };
  let status = 200;

  beforeAll(async () => {
    dir = makeTempDir('update');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    server = http.createServer((req, res) => {
      hits++;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(release));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as any).port}/latest`;
  });

  afterAll(() => { server.close(); db.close(); removeDir(dir); });

  beforeEach(() => {
    resetUpdateCache();
    process.env.SLIGHTSFTP_NO_UPDATE_CHECK = '0';
  });

  afterAll(() => { process.env.SLIGHTSFTP_NO_UPDATE_CHECK = '1'; });

  test.each([['1.10.0', '1.9.3', 1], ['v2.0.0', '2.0.0', 0], ['1.5.0', '1.5.1', -1], ['1.5', '1.5.0', 0], ['2.0.0-beta.1', '1.9.9', 1]])(
    'compareVersions(%s, %s) = %i', (a, b, expected) => {
      expect(compareVersions(a, b)).toBe(expected);
    });

  test('reports a newer release with its link, and caches the answer', async () => {
    hits = 0;
    const info = await checkForUpdate(db, '1.5.0', { url });
    expect(info).toMatchObject({ currentVersion: '1.5.0', latestVersion: '9.1.0', updateAvailable: true, url: release.html_url });
    await checkForUpdate(db, '1.5.0', { url });
    expect(hits).toBe(1);
    await checkForUpdate(db, '1.5.0', { url, force: true });
    expect(hits).toBe(2);
  });

  test('no update when already current; untrusted links are dropped', async () => {
    release = { tag_name: 'v1.5.0', html_url: 'https://evil.example/download' };
    const info = await checkForUpdate(db, '1.5.0', { url });
    expect(info).toMatchObject({ updateAvailable: false, latestVersion: '1.5.0', url: null });
  });

  test('errors are reported, not thrown', async () => {
    status = 503;
    expect((await checkForUpdate(db, '1.5.0', { url })).error).toMatch(/503/);
    status = 200;
    release = { nonsense: true };
    expect((await checkForUpdate(db, '1.5.0', { url })).error).toMatch(/Unexpected/);
  });

  test('can be turned off by setting or environment', async () => {
    hits = 0;
    db.setSetting('updateCheck', 'false');
    expect(await checkForUpdate(db, '1.5.0', { url })).toMatchObject({ updateAvailable: false, checkedAt: null });
    db.setSetting('updateCheck', 'true');
    process.env.SLIGHTSFTP_NO_UPDATE_CHECK = '1';
    await checkForUpdate(db, '1.5.0', { url });
    expect(hits).toBe(0);
  });
});
