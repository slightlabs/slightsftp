/**
 * Per-user storage quotas. A user's usage is the total size of the files in
 * the local folders their virtual paths map to (each folder counted once).
 * Usage is measured on demand, cached briefly, and adjusted as uploads land.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from './database';
import { User } from './types';

const CACHE_MS = 30_000;

export class QuotaExceededError extends Error {
  code = 'EQUOTA';
  constructor(public quotaBytes: number) {
    super(`Storage quota exceeded (limit ${formatQuota(quotaBytes)})`);
  }
}

export function formatQuota(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += (await fs.promises.stat(full).catch(() => ({ size: 0 }))).size;
      // symlinks are not followed
    }
  }
  return total;
}

/** Roots that are not inside another root, so nothing is counted twice. */
function distinctRoots(localPaths: string[]): string[] {
  const resolved = Array.from(new Set(localPaths.map(p => path.resolve(p)))).sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of resolved) {
    if (!out.some(r => p === r || p.startsWith(r + path.sep))) out.push(p);
  }
  return out;
}

export interface QuotaUsage {
  usedBytes: number;
  quotaBytes: number | null;
}

export class QuotaManager {
  private cache = new Map<string, { used: number; at: number }>();

  constructor(private db: DatabaseManager) {}

  async usage(user: User): Promise<QuotaUsage> {
    const cached = this.cache.get(user.username);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return { usedBytes: cached.used, quotaBytes: user.quotaBytes ?? null };
    }
    const roots = distinctRoots(this.db.getVirtualPaths(user.id!).map(vp => vp.localPath));
    let used = 0;
    for (const root of roots) used += await folderSize(root);
    this.cache.set(user.username, { used, at: Date.now() });
    return { usedBytes: used, quotaBytes: user.quotaBytes ?? null };
  }

  /** Throws QuotaExceededError when adding `bytes` would go over the user's quota. */
  async assertRoom(user: User, bytes: number): Promise<void> {
    if (!user.quotaBytes) return;
    const { usedBytes } = await this.usage(user);
    if (usedBytes + Math.max(0, bytes) > user.quotaBytes) throw new QuotaExceededError(user.quotaBytes);
  }

  /** Synchronous check against the cached usage (for per-chunk SFTP / FTP writes). */
  wouldExceed(user: User, additionalBytes: number): boolean {
    if (!user.quotaBytes) return false;
    const cached = this.cache.get(user.username);
    return (cached?.used ?? 0) + additionalBytes > user.quotaBytes;
  }

  /** Record bytes added (or removed, when negative) without re-scanning. */
  adjust(username: string, delta: number): void {
    const cached = this.cache.get(username);
    if (cached) cached.used = Math.max(0, cached.used + delta);
  }

  /** Forget cached usage (e.g. after deletes / quota changes). */
  invalidate(username?: string): void {
    if (username) this.cache.delete(username);
    else this.cache.clear();
  }
}

const managers = new WeakMap<DatabaseManager, QuotaManager>();

export function getQuotaManager(db: DatabaseManager): QuotaManager {
  let m = managers.get(db);
  if (!m) {
    m = new QuotaManager(db);
    managers.set(db, m);
  }
  return m;
}

/** Parse a quota from a form: megabytes (number / string) → bytes, empty → null. */
export function quotaFromMegabytes(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('Quota must be a positive number of megabytes');
  return Math.round(mb * 1024 * 1024);
}

/**
 * A pass-through stream for HTTP uploads that fails with QuotaExceededError as
 * soon as the upload would exceed the user's quota.
 */
export function quotaLimiter(manager: QuotaManager, user: User, replacedBytes = 0): import('stream').Transform {
  const { Transform } = require('stream') as typeof import('stream');
  let credit = replacedBytes; // an overwritten file's old size is freed first
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const fromCredit = Math.min(credit, chunk.length);
      credit -= fromCredit;
      const growth = chunk.length - fromCredit;
      if (growth && manager.wouldExceed(user, growth)) return cb(new QuotaExceededError(user.quotaBytes!));
      if (growth) manager.adjust(user.username, growth);
      cb(null, chunk);
    },
  });
}
