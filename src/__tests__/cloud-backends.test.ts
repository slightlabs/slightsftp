/**
 * cloud-backends.test.ts — the same contract for every cloud backend:
 * S3 (an in-memory fake, plus a real MinIO/S3 when SLIGHTSFTP_TEST_S3_* is
 * set) and Azure Blob (Azurite, the official emulator).
 */
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { CloudBackend, CloudError, cleanKey, cloudPath, createBackend, normalizeConnection, parseCloudPath, publicConnection, readAll, testConnection } from '../cloud-storage';
import { FakeS3, fakeS3Config, startFakeS3 } from './helpers/fake-s3';
import { Azurite, createAzureContainer, startAzurite } from './helpers/cloud-servers';

jest.setTimeout(60000);

const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const text = async (b: CloudBackend, key: string, start?: number) => (await readAll(await b.read(key, start))).toString();

describe('cloud paths and connection settings', () => {
  test('cloud:// paths parse into a connection and a clean prefix', () => {
    expect(parseCloudPath('cloud://3')).toEqual({ connectionId: 3, prefix: '' });
    expect(parseCloudPath('cloud://3/team//docs/')).toEqual({ connectionId: 3, prefix: 'team/docs' });
    expect(parseCloudPath('/home/x')).toBeNull();
    expect(parseCloudPath('cloud://abc/x')).toBeNull();
    expect(() => parseCloudPath('cloud://3/a/../b')).toThrow(CloudError);
    expect(cloudPath(4, '/a/b/')).toBe('cloud://4/a/b');
    expect(cloudPath(4)).toBe('cloud://4');
    expect(cleanKey('./a/./b')).toBe('a/b');
  });

  test('connections are validated and secrets are kept but never shown', () => {
    expect(() => normalizeConnection({ name: '', type: 's3' })).toThrow(/name/);
    expect(() => normalizeConnection({ name: 'x', type: 'ftp' })).toThrow(/Type/);
    expect(() => normalizeConnection({ name: 'x', type: 's3', config: { bucket: 'bbb' } })).toThrow(/access key/);
    expect(() => normalizeConnection({ name: 'x', type: 's3', config: { bucket: 'b!', accessKeyId: 'a', secretAccessKey: 's' } })).toThrow(/bucket/);
    expect(() => normalizeConnection({ name: 'x', type: 's3', config: { bucket: 'bbb', endpoint: 'ftp://x', accessKeyId: 'a', secretAccessKey: 's' } })).toThrow(/endpoint/);
    expect(() => normalizeConnection({ name: 'x', type: 'azure', config: { container: 'Bad_Name', connectionString: 'x' } })).toThrow(/container/);
    expect(() => normalizeConnection({ name: 'x', type: 'azure', config: { container: 'files' } })).toThrow(/connection string/);

    const s3 = normalizeConnection({ name: ' Backups ', type: 's3', config: { bucket: 'bbb', accessKeyId: 'AK', secretAccessKey: 'SK', forcePathStyle: 'true' } });
    expect(s3).toEqual({ id: undefined, name: 'Backups', type: 's3', config: { bucket: 'bbb', region: 'us-east-1', endpoint: '', accessKeyId: 'AK', secretAccessKey: 'SK', forcePathStyle: true } });
    // editing with an empty secret keeps the stored one
    const edited = normalizeConnection({ config: { bucket: 'bbb2', accessKeyId: 'AK', secretAccessKey: '' } }, { ...s3, id: 7 });
    expect(edited.config).toMatchObject({ bucket: 'bbb2', secretAccessKey: 'SK' });
    expect(edited.id).toBe(7);

    const shown = publicConnection({ ...edited, id: 7 });
    expect(JSON.stringify(shown)).not.toContain('SK');
    expect(shown.config).toMatchObject({ hasSecretAccessKey: true, accessKeyId: 'AK' });
    expect(shown.url).toBe('cloud://7');
  });
});

type Setup = { name: string; start: () => Promise<{ backend: CloudBackend; stop: () => Promise<void>; conn: any }> };

const setups: Setup[] = [
  {
    name: 'S3 (in-memory fake, 3 keys per page)',
    start: async () => {
      const s3: FakeS3 = await startFakeS3({ pageSize: 3 });
      const conn = { name: 'fake', type: 's3', config: fakeS3Config(s3) };
      return { backend: createBackend(conn as any), stop: () => s3.close(), conn };
    },
  },
  {
    name: 'Azure Blob (Azurite)',
    start: async () => {
      const azurite: Azurite = await startAzurite();
      const container = 'c' + crypto.randomBytes(4).toString('hex');
      await createAzureContainer(azurite.connectionString, container);
      const conn = { name: 'azurite', type: 'azure', config: { container, connectionString: azurite.connectionString } };
      return { backend: createBackend(conn as any), stop: () => azurite.stop(), conn };
    },
  },
];

if (process.env.SLIGHTSFTP_TEST_S3_ENDPOINT) {
  setups.push({
    name: `S3 (${process.env.SLIGHTSFTP_TEST_S3_ENDPOINT})`,
    start: async () => {
      const conn = {
        name: 'real', type: 's3',
        config: {
          bucket: process.env.SLIGHTSFTP_TEST_S3_BUCKET || 'slightsftp-test',
          region: process.env.SLIGHTSFTP_TEST_S3_REGION || 'us-east-1',
          endpoint: process.env.SLIGHTSFTP_TEST_S3_ENDPOINT,
          accessKeyId: process.env.SLIGHTSFTP_TEST_S3_KEY || 'minioadmin',
          secretAccessKey: process.env.SLIGHTSFTP_TEST_S3_SECRET || 'minioadmin',
          forcePathStyle: true,
        },
      };
      const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
      await new S3Client({ region: conn.config.region, endpoint: conn.config.endpoint, forcePathStyle: true, credentials: { accessKeyId: conn.config.accessKeyId, secretAccessKey: conn.config.secretAccessKey } })
        .send(new CreateBucketCommand({ Bucket: conn.config.bucket })).catch(() => undefined);
      // every run works under its own prefix of the shared bucket
      const backend = createBackend(conn as any);
      const root = 'run-' + crypto.randomBytes(4).toString('hex');
      const scoped: CloudBackend = {
        stat: k => (cleanKey(k) ? backend.stat(cleanKey(`${root}/${k}`)) : backend.stat('')),
        list: k => backend.list(cleanKey(`${root}/${k}`)).catch(err => (cleanKey(k) ? Promise.reject(err) : [])),
        read: (k, s) => backend.read(cleanKey(`${root}/${k}`), s),
        write: (k, b) => backend.write(cleanKey(`${root}/${k}`), b),
        remove: k => backend.remove(cleanKey(`${root}/${k}`)),
        mkdir: k => backend.mkdir(cleanKey(`${root}/${k}`)),
        rmdir: k => (cleanKey(k) ? backend.rmdir(cleanKey(`${root}/${k}`)) : Promise.reject(new CloudError('ENOTEMPTY'))),
        rename: (a, b) => backend.rename(cleanKey(`${root}/${a}`), cleanKey(`${root}/${b}`)),
        usage: k => backend.usage(cleanKey(`${root}/${k}`)),
      };
      return { backend: scoped, stop: async () => undefined, conn };
    },
  });
}

describe.each(setups)('$name', ({ start }) => {
  let backend: CloudBackend;
  let conn: any;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ backend, stop, conn } = await start());
  });
  afterAll(() => stop());

  test('"test connection" succeeds and leaves nothing behind', async () => {
    expect(await testConnection(conn)).toEqual({ ok: true, message: expect.stringMatching(/^Connected/) });
    expect((await backend.list('')).filter(e => e.name.startsWith('.slightsftp-probe'))).toEqual([]);
  });

  test('an empty root lists as an empty folder', async () => {
    expect(await backend.list('')).toEqual([]);
    expect(await backend.stat('')).toMatchObject({ isDir: true });
  });

  test('files: write, stat, read (whole and from an offset), overwrite', async () => {
    await backend.write('hello.txt', body('hello cloud'));
    expect(await backend.stat('hello.txt')).toMatchObject({ name: 'hello.txt', isDir: false, size: 11 });
    expect(await text(backend, 'hello.txt')).toBe('hello cloud');
    expect(await text(backend, 'hello.txt', 6)).toBe('cloud');
    expect(await text(backend, 'hello.txt', 11)).toBe('');
    await backend.write('hello.txt', body('v2'));
    expect(await text(backend, 'hello.txt')).toBe('v2');
    await expect(backend.read('missing.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await backend.stat('missing.txt')).toBeNull();
  });

  test('a multi-part upload (6 MB) arrives intact', async () => {
    const big = crypto.randomBytes(6 * 1024 * 1024);
    const chunks = Array.from({ length: 12 }, (_, i) => big.subarray(i * 512 * 1024, (i + 1) * 512 * 1024));
    await backend.write('big.bin', Readable.from(chunks));
    expect((await backend.stat('big.bin'))!.size).toBe(big.length);
    const back = await readAll(await backend.read('big.bin'));
    expect(crypto.createHash('sha256').update(back).digest('hex')).toBe(crypto.createHash('sha256').update(big).digest('hex'));
    await backend.remove('big.bin');
  });

  test('folders: mkdir, nested files, listing (with paging), rmdir rules', async () => {
    await backend.mkdir('docs');
    expect(await backend.stat('docs')).toMatchObject({ name: 'docs', isDir: true });
    expect(await backend.list('docs')).toEqual([]);
    await expect(backend.mkdir('hello.txt')).rejects.toMatchObject({ code: 'EEXIST' });
    for (const n of ['a', 'b', 'c', 'd', 'e']) await backend.write(`docs/${n}.txt`, body(n));
    await backend.write('docs/sub/deep.txt', body('deep'));
    const list = await backend.list('docs');
    expect(list.map(e => `${e.name}${e.isDir ? '/' : ''}`).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'sub/']);
    expect(list.find(e => e.name === 'a.txt')!.size).toBe(1);
    // "sub" has no marker object but still exists as a folder
    expect(await backend.stat('docs/sub')).toMatchObject({ isDir: true });
    expect((await backend.list('')).map(e => e.name).sort()).toEqual(['docs', 'hello.txt']);
    await expect(backend.list('nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.list('hello.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(backend.rmdir('docs')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    await expect(backend.rmdir('nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await backend.mkdir('empty');
    await backend.rmdir('empty');
    expect(await backend.stat('empty')).toBeNull();
    expect(await backend.usage('docs')).toBe(5 + 4);
  });

  test('rename moves files and whole folders', async () => {
    await backend.rename('hello.txt', 'docs/hello-moved.txt');
    expect(await backend.stat('hello.txt')).toBeNull();
    expect(await text(backend, 'docs/hello-moved.txt')).toBe('v2');
    await expect(backend.rename('docs/a.txt', 'docs/b.txt')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(backend.rename('nope', 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.rename('docs', 'docs/inside')).rejects.toMatchObject({ code: 'EIO' });

    await backend.rename('docs', 'archive/2024');
    expect(await backend.stat('docs')).toBeNull();
    expect((await backend.list('archive/2024')).map(e => e.name).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'hello-moved.txt', 'sub']);
    expect(await text(backend, 'archive/2024/sub/deep.txt')).toBe('deep');
    expect(await backend.list('archive/2024')).toHaveLength(7);
  });

  test('names with spaces and unicode survive every operation', async () => {
    await backend.write('My Files/résumé #1.txt', body('ünïcode'));
    expect((await backend.list('My Files')).map(e => e.name)).toEqual(['résumé #1.txt']);
    await backend.rename('My Files/résumé #1.txt', 'My Files/naïve copy.txt');
    expect(await text(backend, 'My Files/naïve copy.txt')).toBe('ünïcode');
    await backend.remove('My Files/naïve copy.txt');
    await expect(backend.remove('My Files/naïve copy.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('connection failures are reported, not thrown', () => {
  test('a wrong bucket and an unreachable endpoint', async () => {
    const s3 = await startFakeS3();
    try {
      const res = await testConnection({ name: 'x', type: 's3', config: { ...fakeS3Config(s3), bucket: 'other' } });
      expect(res.ok).toBe(false);
    } finally {
      await s3.close();
    }
    const down = await testConnection({ name: 'x', type: 's3', config: { ...fakeS3Config(s3), endpoint: 'http://127.0.0.1:1' } });
    expect(down.ok).toBe(false);
    expect(down.message).toBeTruthy();
  });
});
