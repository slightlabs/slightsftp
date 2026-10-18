/**
 * Per-user bandwidth limits. Each user has one limiter per direction shared
 * by all of their sessions (SFTP, FTP, portal, share links), so opening more
 * connections does not multiply their allowance.
 */
import { Transform } from 'stream';
import { DatabaseManager } from './database';
import { User } from './types';

export type Direction = 'upload' | 'download';

/**
 * A pacing scheduler: every transfer of `bytes` is assigned the next free
 * slot on a virtual clock that advances at `bytesPerSecond`.
 */
export class RateLimiter {
  private nextFree = 0;

  constructor(public bytesPerSecond: number) {}

  /** Milliseconds the caller should wait before sending `bytes`. */
  delayFor(bytes: number, now = Date.now()): number {
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + (bytes / this.bytesPerSecond) * 1000;
    return start - now;
  }
}

const limiters = new WeakMap<DatabaseManager, Map<string, RateLimiter>>();

function limitOf(user: User, direction: Direction): number {
  const kbps = direction === 'upload' ? user.uploadLimitKBps : user.downloadLimitKBps;
  return kbps && kbps > 0 ? kbps * 1024 : 0;
}

/** The user's limiter for a direction, or null when unlimited. */
export function getLimiter(db: DatabaseManager, user: User | undefined, direction: Direction): RateLimiter | null {
  if (!user) return null;
  const rate = limitOf(user, direction);
  if (!rate) return null;
  let byUser = limiters.get(db);
  if (!byUser) {
    byUser = new Map();
    limiters.set(db, byUser);
  }
  const key = `${user.username}:${direction}`;
  let limiter = byUser.get(key);
  if (!limiter) {
    limiter = new RateLimiter(rate);
    byUser.set(key, limiter);
  }
  limiter.bytesPerSecond = rate; // follow changes made by an admin
  return limiter;
}

/** A Transform that paces data through a limiter (HTTP uploads / downloads). */
export function throttle(limiter: RateLimiter | null): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const wait = limiter ? limiter.delayFor(chunk.length) : 0;
      if (wait > 0) setTimeout(() => cb(null, chunk), wait);
      else cb(null, chunk);
    },
  });
}

/** Parse a KB/s limit from a form ("" → unlimited). */
export function limitFromForm(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Speed limits must be a positive number of KB/s');
  return Math.round(n);
}

/** Send a file as a download, paced by the limiter when there is one. */
export async function sendFileThrottled(res: import('express').Response, filePath: string, name: string, limiter: RateLimiter | null): Promise<void> {
  if (!limiter) {
    res.download(filePath, name);
    return;
  }
  const fs = await import('fs');
  const { pipeline } = await import('stream/promises');
  const stat = await fs.promises.stat(filePath);
  res.attachment(name);
  res.setHeader('Content-Length', String(stat.size));
  await pipeline(fs.createReadStream(filePath), throttle(limiter), res);
}
