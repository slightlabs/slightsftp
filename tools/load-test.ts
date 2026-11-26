/**
 * Load test for a running SLightSFTP server: N concurrent clients each
 * upload and download files and verify them byte for byte.
 *
 *   npm run tools:build
 *   node dist-tools/tools/load-test.js --host 127.0.0.1 --port 2222 --user load --password '...' \
 *     [--protocol sftp|ftp] [--clients 50] [--files 5] [--size 1MB] [--dir /load-test]
 *
 * Or let it start its own server in a temporary folder (no other setup needed):
 *   node dist-tools/tools/load-test.js --self [--protocol sftp|ftp] [--clients 50] [--size 10MB]
 *
 * Reports throughput, per-file latency percentiles, failures and (with --self)
 * the server's memory, and exits non-zero if any transfer failed or a
 * download did not match its upload.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';

interface Options {
  host: string;
  port: number;
  user: string;
  password: string;
  protocol: 'sftp' | 'ftp';
  clients: number;
  files: number;
  size: number;
  dir: string;
  self: boolean;
}

function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(text.trim());
  if (!m) throw new Error(`Bad size: ${text}`);
  const unit = (m[2] || 'B').toUpperCase();
  return Math.round(Number(m[1]) * ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as Record<string, number>)[unit]);
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const protocol = (get('protocol', 'sftp') as string).toLowerCase();
  if (protocol !== 'sftp' && protocol !== 'ftp') throw new Error('--protocol is sftp or ftp');
  return {
    host: get('host', '127.0.0.1')!,
    port: Number(get('port', protocol === 'sftp' ? '2222' : '2121')),
    user: get('user', 'load')!,
    password: get('password', '')!,
    protocol,
    clients: Number(get('clients', '20')),
    files: Number(get('files', '5')),
    size: parseSize(get('size', '1MB')!),
    dir: get('dir', '/load-test')!,
    self: argv.includes('--self'),
  };
}

/** Deterministic pseudo-random content, so downloads can be checked without keeping uploads in memory. */
function contentStream(seed: string, size: number): Readable {
  let produced = 0;
  let counter = 0;
  return new Readable({
    read() {
      if (produced >= size) return this.push(null);
      const block = crypto.createHash('sha512').update(`${seed}:${counter++}`).digest();
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - produced));
      for (let i = 0; i < chunk.length; i += block.length) block.copy(chunk, i);
      produced += chunk.length;
      this.push(chunk);
    },
  });
}

async function digestOf(stream: Readable): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

interface Result {
  op: 'upload' | 'download';
  ms: number;
  bytes: number;
  ok: boolean;
  error?: string;
}

async function runClient(o: Options, id: number, results: Result[]): Promise<void> {
  const name = (f: number) => `${o.dir}/c${id}-f${f}.bin`;
  const expected = new Map<number, string>();
  const timed = async (op: Result['op'], fn: () => Promise<void>) => {
    const started = process.hrtime.bigint();
    try {
      await fn();
      results.push({ op, ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: o.size, ok: true });
    } catch (err: any) {
      results.push({ op, ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: 0, ok: false, error: err?.message || String(err) });
    }
  };

  if (o.protocol === 'sftp') {
    const c = new SftpClient();
    await c.connect({ host: o.host, port: o.port, username: o.user, password: o.password, readyTimeout: 20000 });
    try {
      for (let f = 0; f < o.files; f++) {
        const seed = `${id}-${f}`;
        expected.set(f, await digestOf(contentStream(seed, o.size)));
        await timed('upload', () => c.put(contentStream(seed, o.size), name(f)).then(() => undefined));
        await timed('download', async () => {
          const sink = new PassThrough();
          const digest = digestOf(sink);
          await c.get(name(f), sink);
          if ((await digest) !== expected.get(f)) throw new Error(`content mismatch in ${name(f)}`);
        });
        await c.delete(name(f)).catch(() => undefined);
      }
    } finally {
      await c.end().catch(() => undefined);
    }
  } else {
    const c = new FtpClient(30000);
    await c.access({ host: o.host, port: o.port, user: o.user, password: o.password });
    try {
      for (let f = 0; f < o.files; f++) {
        const seed = `${id}-${f}`;
        expected.set(f, await digestOf(contentStream(seed, o.size)));
        await timed('upload', () => c.uploadFrom(contentStream(seed, o.size), name(f)).then(() => undefined));
        await timed('download', async () => {
          const sink = new PassThrough();
          const digest = digestOf(sink);
          await c.downloadTo(sink, name(f));
          sink.end();
          if ((await digest) !== expected.get(f)) throw new Error(`content mismatch in ${name(f)}`);
        });
        await c.remove(name(f)).catch(() => undefined);
      }
    } finally {
      c.close();
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);

/** Start a throwaway server (database, user, listener) in a temp folder. */
async function startSelf(o: Options): Promise<{ stop: () => Promise<void>; memory: () => NodeJS.MemoryUsage }> {
  const { DatabaseManager } = require('../src/database');
  const { ServerManager } = require('../src/server-manager');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-load-'));
  process.env.SLIGHTSFTP_CERT_DIR = dir;
  require('../src/tls').setCertificateDir(dir);
  const root = path.join(dir, 'files');
  fs.mkdirSync(path.join(root, o.dir.replace(/^\//, '')), { recursive: true });
  const db = new DatabaseManager(path.join(dir, 'config.db'));
  await db.init();
  db.setSetting('maxConnectionsPerListener', String(Math.max(100, o.clients * 2)));
  db.setSetting('bruteForceEnabled', 'false');
  o.password = o.password || 'Load-Test-Pass-1';
  const uid = db.createUser({ username: o.user, password: o.password, passwordEnabled: true, guiEnabled: false });
  db.addVirtualPath({ userId: uid, virtualPath: '/', localPath: root, canRead: true, canWrite: true, canAppend: true, canDelete: true, canList: true, canCreateDir: true, canRename: true, applyToSubdirs: true });
  const listener = db.createListener({ name: 'load', protocol: o.protocol.toUpperCase(), bindingIp: '127.0.0.1', port: o.port, enabled: true });
  db.subscribeUserToListener(uid, listener);
  const manager = new ServerManager(db);
  await manager.startListener(listener);
  return {
    memory: () => process.memoryUsage(),
    stop: async () => {
      await manager.stopAllListeners();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.self && !process.argv.includes('--port')) o.port = 20000 + Math.floor(Math.random() * 20000);
  const server = o.self ? await startSelf(o) : null;

  // make sure the target folder exists
  if (o.protocol === 'sftp') {
    const c = new SftpClient();
    await c.connect({ host: o.host, port: o.port, username: o.user, password: o.password, readyTimeout: 20000 });
    await c.mkdir(o.dir, true).catch(() => undefined);
    await c.end();
  } else {
    const c = new FtpClient();
    await c.access({ host: o.host, port: o.port, user: o.user, password: o.password });
    await c.ensureDir(o.dir).catch(() => undefined);
    c.close();
  }

  console.log(`${o.protocol.toUpperCase()} ${o.host}:${o.port}: ${o.clients} clients × ${o.files} files × ${mb(o.size)} MB (upload + download + verify)`);
  const results: Result[] = [];
  const connectFailures: string[] = [];
  let peakRss = 0;
  const sampler = server ? setInterval(() => { peakRss = Math.max(peakRss, server.memory().rss); }, 200) : null;
  const rssBefore = server ? server.memory().rss : 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: o.clients }, (_, i) =>
    runClient(o, i, results).catch(err => { connectFailures.push(err?.message || String(err)); })));
  const seconds = (Date.now() - started) / 1000;
  if (sampler) clearInterval(sampler);

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const moved = ok.reduce((n, r) => n + r.bytes, 0);
  console.log(`\nDuration         ${seconds.toFixed(1)} s`);
  console.log(`Transfers        ${ok.length} ok, ${failed.length} failed, ${connectFailures.length} clients could not connect`);
  console.log(`Throughput       ${mb(moved / seconds)} MB/s aggregate (${mb(moved)} MB moved)`);
  for (const op of ['upload', 'download'] as const) {
    const ms = ok.filter(r => r.op === op).map(r => r.ms).sort((a, b) => a - b);
    console.log(`${op.padEnd(16)} p50 ${percentile(ms, 50).toFixed(0)} ms, p95 ${percentile(ms, 95).toFixed(0)} ms, max ${percentile(ms, 100).toFixed(0)} ms`);
  }
  if (server) console.log(`Server memory    RSS ${mb(rssBefore)} MB before, ${mb(peakRss)} MB peak (load generator in the same process)`);
  for (const e of [...new Set([...failed.map(f => f.error), ...connectFailures])].slice(0, 10)) console.log(`  error: ${e}`);

  await server?.stop();
  process.exit(failed.length || connectFailures.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
