/**
 * Cloud storage virtual paths. A virtual path whose local path is
 * "cloud://<connectionId>/<prefix>" lives in an S3 bucket (AWS, MinIO, Wasabi,
 * Cloudflare R2, Backblaze B2, ...) or an Azure Blob container instead of on
 * this computer. SFTP, FTP, the web portal and share links talk to it through
 * the small CloudBackend interface below; folders are key prefixes, and an
 * empty folder is a zero-byte "<folder>/" marker object.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import type { DatabaseManager } from './database';
import { StorageConnection, StorageType } from './types';

export interface CloudEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: Date;
}

export interface CloudBackend {
  /** null when nothing exists at key; key "" is the connection root (always a folder) */
  stat(key: string): Promise<CloudEntry | null>;
  /** the immediate children of a folder */
  list(key: string): Promise<CloudEntry[]>;
  read(key: string, start?: number): Promise<Readable>;
  write(key: string, body: Readable): Promise<void>;
  remove(key: string): Promise<void>;
  mkdir(key: string): Promise<void>;
  rmdir(key: string): Promise<void>;
  /** a file, or a folder with everything in it */
  rename(from: string, to: string): Promise<void>;
  /** total size of the files at or below key */
  usage(key: string): Promise<number>;
}

/** Errors carry fs-style codes so the protocol handlers map them like local errors. */
export class CloudError extends Error {
  constructor(public code: 'ENOENT' | 'EEXIST' | 'ENOTEMPTY' | 'ENOTDIR' | 'EISDIR' | 'EIO', message?: string) {
    super(message || code);
  }
}

const CLOUD_PREFIX = 'cloud://';

export function isCloudPath(localPath: string | undefined | null): boolean {
  return typeof localPath === 'string' && localPath.startsWith(CLOUD_PREFIX);
}

/** "cloud://3/team/docs" -> { connectionId: 3, prefix: "team/docs" } */
export function parseCloudPath(localPath: string): { connectionId: number; prefix: string } | null {
  if (!isCloudPath(localPath)) return null;
  const m = /^cloud:\/\/(\d+)(?:\/(.*))?$/.exec(localPath);
  if (!m) return null;
  return { connectionId: Number(m[1]), prefix: cleanKey(m[2] || '') };
}

export function cloudPath(connectionId: number, prefix = ''): string {
  const key = cleanKey(prefix);
  return `${CLOUD_PREFIX}${connectionId}${key ? '/' + key : ''}`;
}

/** A key without leading/trailing slashes; ".." and "." segments are refused. */
export function cleanKey(key: string): string {
  const parts = key.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.includes('..')) throw new CloudError('ENOENT', 'Invalid path');
  return parts.join('/');
}

export function joinKey(...parts: string[]): string {
  return cleanKey(parts.filter(Boolean).join('/'));
}

/** Validate an admin-supplied connection; empty secrets keep the stored ones. */
export function normalizeConnection(input: any, existing?: StorageConnection): StorageConnection {
  const name = String(input?.name ?? existing?.name ?? '').trim();
  const type = String(input?.type ?? existing?.type ?? '') as StorageType;
  if (!name) throw new Error('A name is required');
  if (type !== 's3' && type !== 'azure') throw new Error('Type must be "s3" or "azure"');
  const old = existing?.type === type ? existing.config : {};
  const raw = { ...(input?.config || {}) };
  // fields left out keep their saved value; secrets left empty do too
  const str = (k: string) => (raw[k] === undefined || raw[k] === null ? String(old[k] ?? '') : String(raw[k]).trim());
  const secret = (k: string) => str(k) || old[k] || '';

  if (type === 's3') {
    const config = {
      bucket: str('bucket'),
      region: str('region') || 'us-east-1',
      endpoint: str('endpoint'),
      accessKeyId: str('accessKeyId'),
      secretAccessKey: secret('secretAccessKey'),
      forcePathStyle: raw.forcePathStyle === undefined ? !!old.forcePathStyle : raw.forcePathStyle === true || raw.forcePathStyle === 'true',
    };
    if (!/^[a-z0-9][a-z0-9.\-_]{1,61}[a-z0-9]$/i.test(config.bucket)) throw new Error('A valid bucket name is required');
    if (config.endpoint && !/^https?:\/\/[^\s]+$/i.test(config.endpoint)) throw new Error('The endpoint must start with http:// or https://');
    if (!config.accessKeyId || !config.secretAccessKey) throw new Error('An access key ID and secret access key are required');
    return { id: existing?.id, name, type, config };
  }

  const config = {
    container: str('container'),
    connectionString: secret('connectionString'),
    accountName: str('accountName'),
    accountKey: secret('accountKey'),
    endpoint: str('endpoint'),
  };
  if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(config.container)) throw new Error('A valid container name is required (lower-case letters, numbers and hyphens)');
  if (config.endpoint && !/^https?:\/\/[^\s]+$/i.test(config.endpoint)) throw new Error('The endpoint must start with http:// or https://');
  if (!config.connectionString && !(config.accountName && config.accountKey)) throw new Error('A connection string, or an account name and key, is required');
  return { id: existing?.id, name, type, config };
}

const SECRET_FIELDS = ['secretAccessKey', 'connectionString', 'accountKey'];

/** What the GUI may see: secrets are replaced by has<Field> flags. */
export function publicConnection(conn: StorageConnection) {
  const config: Record<string, any> = {};
  for (const [k, v] of Object.entries(conn.config || {})) {
    if (SECRET_FIELDS.includes(k)) config['has' + k[0].toUpperCase() + k.slice(1)] = !!v;
    else config[k] = v;
  }
  return { id: conn.id, name: conn.name, type: conn.type, config, createdAt: conn.createdAt, url: cloudPath(conn.id!) };
}

export function createBackend(conn: StorageConnection): CloudBackend {
  // loaded lazily: the SDKs are large and most installs never use them
  if (conn.type === 's3') return new (require('./cloud-s3').S3Backend)(conn.config);
  if (conn.type === 'azure') return new (require('./cloud-azure').AzureBackend)(conn.config);
  throw new Error(`Unknown storage type ${conn.type}`);
}

const backends = new Map<number, { signature: string; backend: CloudBackend }>();

export function getBackend(db: DatabaseManager, connectionId: number): CloudBackend {
  const conn = db.getStorageConnection(connectionId);
  if (!conn) throw new CloudError('ENOENT', 'Cloud storage connection not found');
  const signature = JSON.stringify([conn.type, conn.config]);
  const cached = backends.get(connectionId);
  if (cached && cached.signature === signature) return cached.backend;
  const backend = createBackend(conn);
  backends.set(connectionId, { signature, backend });
  return backend;
}

export interface CloudTarget {
  backend: CloudBackend;
  key: string;
  connectionId: number;
}

/**
 * Folders that virtual paths point at always exist (a bucket has no real
 * folders, so a fresh "users/alice" prefix would otherwise be "not found"),
 * and cannot be removed or renamed by the users working inside them.
 */
class RootAwareBackend implements CloudBackend {
  constructor(private inner: CloudBackend, private roots: Set<string>) {}

  private isRoot(key: string): boolean {
    return this.roots.has(cleanKey(key));
  }

  async stat(key: string): Promise<CloudEntry | null> {
    const entry = await this.inner.stat(key);
    if (entry || !this.isRoot(key)) return entry;
    const k = cleanKey(key);
    return { name: k.slice(k.lastIndexOf('/') + 1), isDir: true, size: 0, mtime: new Date(0) };
  }

  list(key: string): Promise<CloudEntry[]> {
    return this.inner.list(key).catch(err => {
      if (err?.code === 'ENOENT' && this.isRoot(key)) return [];
      throw err;
    });
  }

  read(key: string, start?: number) { return this.inner.read(key, start); }
  write(key: string, body: Readable) { return this.inner.write(key, body); }
  remove(key: string) { return this.inner.remove(key); }
  usage(key: string) { return this.inner.usage(key); }

  async mkdir(key: string): Promise<void> {
    if (this.isRoot(key)) return;
    return this.inner.mkdir(key);
  }

  async rmdir(key: string): Promise<void> {
    if (this.isRoot(key)) throw new CloudError('ENOTEMPTY', 'Cannot remove a shared root folder');
    return this.inner.rmdir(key);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.isRoot(from) || this.isRoot(to)) throw new CloudError('EIO', 'Cannot rename a shared root folder');
    return this.inner.rename(from, to);
  }
}

/** Prefixes that virtual paths on a connection point at. */
function connectionRoots(db: DatabaseManager, connectionId: number): Set<string> {
  const roots = new Set<string>();
  for (const localPath of db.getCloudVirtualPathTargets()) {
    try {
      const parsed = parseCloudPath(localPath);
      if (parsed?.connectionId === connectionId) roots.add(parsed.prefix);
    } catch { /* invalid stored path: never resolves anyway */ }
  }
  return roots;
}

/** The backend and object key for a resolved cloud local path. */
export function cloudTarget(db: DatabaseManager, localPath: string): CloudTarget | null {
  const parsed = parseCloudPath(localPath);
  if (!parsed) return null;
  const backend = new RootAwareBackend(getBackend(db, parsed.connectionId), connectionRoots(db, parsed.connectionId));
  return { backend, key: parsed.prefix, connectionId: parsed.connectionId };
}

/** "Test connection": list the root, then write, read back and delete a probe object. */
export async function testConnection(conn: StorageConnection): Promise<{ ok: boolean; message: string }> {
  try {
    const backend = createBackend(conn);
    await backend.list('');
    const probe = `.slightsftp-probe-${crypto.randomBytes(6).toString('hex')}`;
    await backend.write(probe, Readable.from([Buffer.from('ok')]));
    const body = await readAll(await backend.read(probe));
    await backend.remove(probe);
    if (body.toString() !== 'ok') return { ok: false, message: 'Read back different data than was written' };
    return { ok: true, message: 'Connected: listing, upload, download and delete all work' };
  } catch (err: any) {
    return { ok: false, message: String(err?.message || err?.name || err) };
  }
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Where cloud files are staged while SFTP clients read or write them. */
export function stagingDir(): string {
  const dir = path.join(os.tmpdir(), 'slightsftp-cloud');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stagingFile(): string {
  return path.join(stagingDir(), crypto.randomBytes(12).toString('hex'));
}

/**
 * A cloud object being downloaded into a local staging file. SFTP reads at
 * any offset wait until the download has got that far, so a transfer starts
 * as soon as the first bytes arrive.
 */
export class StagedDownload {
  written = 0;
  done = false;
  error: Error | null = null;
  private waiters: Array<() => void> = [];
  private source: Readable;
  private cancelled = false;

  constructor(public fd: number, source: Readable) {
    this.source = source;
    source.on('data', (chunk: Buffer) => {
      // never write after cancel(): the descriptor may be closed and reused
      if (this.cancelled) return;
      fs.writeSync(this.fd, chunk, 0, chunk.length, this.written);
      this.written += chunk.length;
      this.wake();
    });
    source.once('end', () => { this.done = true; this.wake(); });
    source.once('error', err => { this.error = err; this.done = true; this.wake(); });
  }

  /** Resolves once bytes up to `end` are on disk (or the download finished). */
  ready(end: number): Promise<void> {
    if (this.done || this.written >= end) return this.error ? Promise.reject(this.error) : Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push(() => {
        if (this.error) reject(this.error);
        else resolve();
      });
    }).then(() => this.ready(end));
  }

  cancel(): void {
    this.cancelled = true;
    if (!this.done) this.source.destroy();
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** Fake fs.Stats-like values for listings (protocol handlers expect a mode). */
export function entryMode(entry: CloudEntry): number {
  return entry.isDir ? (fs.constants.S_IFDIR | 0o755) : (fs.constants.S_IFREG | 0o644);
}

/** Send a cloud file as an HTTP download (optionally through a bandwidth limiter). */
export async function sendCloudFile(
  res: import('express').Response,
  backend: CloudBackend,
  key: string,
  entry: CloudEntry,
  limiter: import('./bandwidth').RateLimiter | null
): Promise<void> {
  const { pipeline } = await import('stream/promises');
  const { throttle } = await import('./bandwidth');
  const source = await backend.read(key);
  res.attachment(entry.name || 'download');
  res.setHeader('Content-Length', String(entry.size));
  if (limiter) await pipeline(source, throttle(limiter), res);
  else await pipeline(source, res);
}

/**
 * Store an HTTP request body (through optional stages such as quota and speed
 * limits) as a cloud object. Returns the size and SHA-256 of what was stored;
 * a failed or aborted upload stores nothing.
 */
export async function receiveCloudFile(
  req: Readable,
  stages: NodeJS.ReadWriteStream[],
  backend: CloudBackend,
  key: string
): Promise<{ size: number; sha256: string }> {
  const { pipeline } = await import('stream/promises');
  const { PassThrough, Transform } = await import('stream');
  const hash = crypto.createHash('sha256');
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const body = new PassThrough();
  const upload = backend.write(key, body);
  // if the bucket refuses the upload, stop reading the request instead of stalling
  upload.catch(err => body.destroy(err));
  try {
    await (pipeline as any)(req, ...stages, measure, body);
  } catch (err) {
    body.destroy(err as Error);
    await upload.catch(() => undefined);
    throw err;
  }
  await upload;
  return { size, sha256: hash.digest('hex') };
}

/** The parent folder's key ("" for the root). */
export function parentKey(key: string): string {
  const k = cleanKey(key);
  return k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '';
}

/** Stat a local or cloud:// path (null when it does not exist). */
export async function statPath(db: DatabaseManager, localPath: string): Promise<{ isDir: boolean; size: number; mtime: Date; name: string } | null> {
  const cloud = cloudTarget(db, localPath);
  if (cloud) {
    const entry = await cloud.backend.stat(cloud.key);
    return entry && { isDir: entry.isDir, size: entry.size, mtime: entry.mtime, name: entry.name || path.posix.basename(cloud.key) };
  }
  const st = await fs.promises.stat(localPath).catch(() => null);
  return st && { isDir: st.isDirectory(), size: st.size, mtime: st.mtime, name: path.basename(localPath) };
}

// ── administration (shared by the REST API and the desktop app) ───────────

/** "user → /virtual" for every virtual path that uses a connection. */
export function connectionUsage(db: DatabaseManager, id: number): string[] {
  const out: string[] = [];
  for (const user of db.getAllUsers()) {
    for (const vp of db.getVirtualPaths(user.id!)) {
      if (parseCloudPath(vp.localPath)?.connectionId === id) out.push(`${user.username} → ${vp.virtualPath}`);
    }
  }
  return out;
}

export function listConnectionsForAdmin(db: DatabaseManager) {
  return db.listStorageConnections().map(c => ({ ...publicConnection(c), usedBy: connectionUsage(db, c.id!) }));
}

export function saveConnection(db: DatabaseManager, input: any, id?: number) {
  const existing = id === undefined ? undefined : db.getStorageConnection(id);
  if (id !== undefined && !existing) throw new Error('Connection not found');
  const conn = normalizeConnection(input, existing);
  if (existing) db.updateStorageConnection(id!, conn);
  else conn.id = db.createStorageConnection(conn);
  backends.delete(conn.id!);
  return publicConnection(db.getStorageConnection(conn.id!)!);
}

export function deleteConnection(db: DatabaseManager, id: number): StorageConnection {
  const existing = db.getStorageConnection(id);
  if (!existing) throw new Error('Connection not found');
  const used = connectionUsage(db, id);
  if (used.length) throw new Error(`Still used by ${used.join(', ')}`);
  db.deleteStorageConnection(id);
  backends.delete(id);
  return existing;
}

/** Test unsaved form values (secrets left empty fall back to the saved connection). */
export function testConnectionInput(db: DatabaseManager, input: any, id?: number) {
  const existing = id === undefined || id === null ? undefined : db.getStorageConnection(Number(id));
  let conn: StorageConnection;
  try {
    conn = normalizeConnection(input?.type || input?.config ? input : { ...existing, ...input }, existing);
  } catch (err: any) {
    return Promise.resolve({ ok: false, message: err.message });
  }
  return testConnection(conn);
}

/** Refuse virtual paths that point at a connection that does not exist. */
export function assertCloudTarget(db: DatabaseManager, localPath: string): void {
  if (!isCloudPath(localPath)) return;
  let parsed: ReturnType<typeof parseCloudPath>;
  try {
    parsed = parseCloudPath(localPath);
  } catch {
    parsed = null;
  }
  if (!parsed || !db.getStorageConnection(parsed.connectionId)) throw new Error(`Unknown cloud storage location: ${localPath}`);
}
