/**
 * Azure Blob Storage (and the Azurite emulator).
 */
import { Readable } from 'stream';
import { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { CloudBackend, CloudEntry, CloudError, cleanKey } from './cloud-storage';

export class AzureBackend implements CloudBackend {
  private container: ContainerClient;

  constructor(config: Record<string, any>) {
    const service = config.connectionString
      ? BlobServiceClient.fromConnectionString(config.connectionString)
      : new BlobServiceClient(
        config.endpoint || `https://${config.accountName}.blob.core.windows.net`,
        new StorageSharedKeyCredential(config.accountName, config.accountKey)
      );
    this.container = service.getContainerClient(config.container);
  }

  private async head(key: string): Promise<CloudEntry | null> {
    try {
      const p = await this.container.getBlobClient(key).getProperties();
      return { name: baseName(key), isDir: false, size: Number(p.contentLength || 0), mtime: p.lastModified || new Date(0) };
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  private async keysUnder(prefix: string, max?: number): Promise<Array<{ key: string; size: number }>> {
    const out: Array<{ key: string; size: number }> = [];
    for await (const page of this.container.listBlobsFlat({ prefix }).byPage({ maxPageSize: max ? Math.min(max, 5000) : 5000 })) {
      for (const b of page.segment.blobItems) out.push({ key: b.name, size: Number(b.properties.contentLength || 0) });
      if (max && out.length >= max) break;
    }
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
    let any = false;
    for await (const item of this.container.listBlobsByHierarchy('/', { prefix })) {
      any = true;
      if (item.kind === 'prefix') {
        const name = item.name.slice(prefix.length).replace(/\/$/, '');
        if (name) entries.push({ name, isDir: true, size: 0, mtime: new Date(0) });
      } else {
        const name = item.name.slice(prefix.length);
        if (name && !name.includes('/')) {
          entries.push({ name, isDir: false, size: Number(item.properties.contentLength || 0), mtime: item.properties.lastModified || new Date(0) });
        }
      }
    }
    if (!any && key) {
      if (await this.head(key)) throw new CloudError('ENOTDIR');
      throw new CloudError('ENOENT');
    }
    return entries;
  }

  async read(key: string, start?: number): Promise<Readable> {
    key = cleanKey(key);
    const blob = this.container.getBlobClient(key);
    try {
      if (start) {
        const size = Number((await blob.getProperties()).contentLength || 0);
        if (start >= size) return Readable.from([]);
      }
      const res = await blob.download(start || 0);
      return res.readableStreamBody as unknown as Readable;
    } catch (err: any) {
      if (err?.statusCode === 404) throw new CloudError('ENOENT');
      throw err;
    }
  }

  async write(key: string, body: Readable): Promise<void> {
    key = cleanKey(key);
    if (!key) throw new CloudError('EISDIR');
    await this.container.getBlockBlobClient(key).uploadStream(body, 4 * 1024 * 1024, 4);
  }

  async remove(key: string): Promise<void> {
    key = cleanKey(key);
    try {
      await this.container.getBlobClient(key).delete();
    } catch (err: any) {
      if (err?.statusCode === 404) throw new CloudError('ENOENT');
      throw err;
    }
  }

  async mkdir(key: string): Promise<void> {
    key = cleanKey(key);
    if (!key) return;
    if (await this.head(key)) throw new CloudError('EEXIST');
    await this.container.getBlockBlobClient(key + '/').upload('', 0);
  }

  async rmdir(key: string): Promise<void> {
    key = cleanKey(key);
    if (!key) throw new CloudError('ENOTEMPTY', 'Cannot remove the storage root');
    const under = await this.keysUnder(key + '/', 2);
    if (!under.length) throw new CloudError('ENOENT');
    if (under.some(o => o.key !== key + '/')) throw new CloudError('ENOTEMPTY');
    await this.container.getBlobClient(key + '/').delete();
  }

  private async copy(from: string, to: string): Promise<void> {
    const poller = await this.container.getBlobClient(to).beginCopyFromURL(this.container.getBlobClient(from).url);
    await poller.pollUntilDone();
  }

  async rename(from: string, to: string): Promise<void> {
    from = cleanKey(from);
    to = cleanKey(to);
    if (!from || !to) throw new CloudError('EIO', 'Cannot rename the storage root');
    if (from === to) return;
    if (await this.stat(to)) throw new CloudError('EEXIST');
    if (await this.head(from)) {
      await this.copy(from, to);
      await this.container.getBlobClient(from).delete();
      return;
    }
    if (to.startsWith(from + '/')) throw new CloudError('EIO', 'Cannot move a folder into itself');
    const under = await this.keysUnder(from + '/');
    if (!under.length) throw new CloudError('ENOENT');
    for (const o of under) await this.copy(o.key, to + '/' + o.key.slice(from.length + 1));
    for (const o of under) await this.container.getBlobClient(o.key).delete();
  }

  async usage(key: string): Promise<number> {
    key = cleanKey(key);
    const blobs = await this.keysUnder(key ? key + '/' : '');
    return blobs.reduce((sum, b) => sum + b.size, 0);
  }
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}
