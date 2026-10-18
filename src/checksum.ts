import * as crypto from 'crypto';
import * as fs from 'fs';
import { DatabaseManager } from './database';

/** SHA-256 (hex) of a file, streamed so large uploads don't load into memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Upload checksums are on unless the `checksumUploads` setting is "false". */
export function checksumsEnabled(db: DatabaseManager): boolean {
  try {
    return db.getSetting('checksumUploads') !== 'false';
  } catch {
    return false;
  }
}

/** Checksum for an upload's activity entry, or undefined when disabled / unreadable. */
export async function uploadChecksum(db: DatabaseManager, filePath: string): Promise<string | undefined> {
  if (!checksumsEnabled(db)) return undefined;
  return sha256File(filePath).catch(() => undefined);
}
