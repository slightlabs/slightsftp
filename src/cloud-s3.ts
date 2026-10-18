/**
 * Amazon S3 and S3-compatible storage (MinIO, Wasabi, Cloudflare R2,
 * Backblaze B2, DigitalOcean Spaces, ...).
 */
import { Readable } from 'stream';
import {
  S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand,
  PutObjectCommand, DeleteObjectCommand, CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { CloudBackend, CloudEntry, CloudError, cleanKey } from './cloud-storage';

const COPY_LIMIT = 5 * 1024 ** 3; // CopyObject's single-request limit

export class S3Backend implements CloudBackend {
  private client: S3Client;
  private bucket: string;

  constructor(config: Record<string, any>) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint || undefined,
      forcePathStyle: !!config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // many S3-compatible services reject the newer default checksum headers
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  private async head(key: string): Promise<CloudEntry | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { name: baseName(key), isDir: false, size: Number(res.ContentLength || 0), mtime: res.LastModified || new Date(0) };
    } catch (err: any) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async keysUnder(prefix: string, max?: number): Promise<Array<{ key: string; size: number }>> {
    const out: Array<{ key: string; size: number }> = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: max ? Math.min(max, 1000) : undefined,
      }));
      for (const o of res.Contents || []) out.push({ key: o.Key!, size: Number(o.Size || 0) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && (!max || out.length < max));
    return out;
  }

  async stat(key: string): Promise<CloudEntry | null> {
    key = cleanKey(key);
    if (!key) return { name: '', isDir: true, size: 0, mtime: new Date(0) };
    const file = await this.head(key);
    if (file) return file;
    const under = await this.keysUnder(key + '/', 1);
    return under.length ? { name: baseName(key), isDir: true, size: 0, mtime: new Date(0) } : null;
  }

  async list(key: string): Promise<CloudEntry[]> {
    key = cleanKey(key);
    const prefix = key ? key + '/' : '';
    const entries: CloudEntry[] = [];
    let token: string | undefined;
    let any = false;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
      for (const p of res.CommonPrefixes || []) {
        any = true;
        const name = p.Prefix!.slice(prefix.length).replace(/\/$/, '');
        if (name) entries.push({ name, isDir: true, size: 0, mtime: new Date(0) });
      }
      for (const o of res.Contents || []) {
        any = true;
        const name = o.Key!.slice(prefix.length);
        if (name && !name.includes('/')) entries.push({ name, isDir: false, size: Number(o.Size || 0), mtime: o.LastModified || new Date(0) });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    if (!any && key) {
      if (await this.head(key)) throw new CloudError('ENOTDIR');
      throw new CloudError('ENOENT');
    }
    return entries;
  }

  async read(key: string, start?: number): Promise<Readable> {
    key = cleanKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: start ? `bytes=${start}-` : undefined }));
      return res.Body as Readable;
    } catch (err: any) {
      if (isNotFound(err)) throw new CloudError('ENOENT');
      if (err?.name === 'InvalidRange') return Readable.from([]);
      throw err;
    }
  }

  async write(key: string, body: Readable): Promise<void> {
    key = cleanKey(key);
    if (!key) throw new CloudError('EISDIR');
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body } }).done();
  }

  async remove(key: string): Promise<void> {
    key = cleanKey(key);
    if (!(await this.head(key))) throw new CloudError('ENOENT');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async mkdir(key: string): Promise<void> {
    key = cleanKey(key);
    if (!key) return;
    if (await this.head(key)) throw new CloudError('EEXIST');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key + '/', Body: '' }));
  }

  async rmdir(key: string): Promise<void> {
    key = cleanKey(key);
    if (!key) throw new CloudError('ENOTEMPTY', 'Cannot remove the storage root');
    const under = await this.keysUnder(key + '/', 2);
    if (!under.length) throw new CloudError('ENOENT');
    if (under.some(o => o.key !== key + '/')) throw new CloudError('ENOTEMPTY');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key + '/' }));
  }

  private async copy(from: string, to: string, size: number): Promise<void> {
    if (size > COPY_LIMIT) {
      await this.write(to, await this.read(from));
      return;
    }
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
    }));
  }

  async rename(from: string, to: string): Promise<void> {
    from = cleanKey(from);
    to = cleanKey(to);
    if (!from || !to) throw new CloudError('EIO', 'Cannot rename the storage root');
    if (from === to) return;
    if (await this.stat(to)) throw new CloudError('EEXIST');
    const file = await this.head(from);
    if (file) {
      await this.copy(from, to, file.size);
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
      return;
    }
    if (to.startsWith(from + '/')) throw new CloudError('EIO', 'Cannot move a folder into itself');
    const under = await this.keysUnder(from + '/');
    if (!under.length) throw new CloudError('ENOENT');
    for (const o of under) await this.copy(o.key, to + '/' + o.key.slice(from.length + 1), o.size);
    for (const o of under) await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: o.key }));
  }

  async usage(key: string): Promise<number> {
    key = cleanKey(key);
    const objects = await this.keysUnder(key ? key + '/' : '');
    return objects.reduce((sum, o) => sum + o.size, 0);
  }
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

function isNotFound(err: any): boolean {
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}
