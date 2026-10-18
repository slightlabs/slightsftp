/**
 * Share links (/s/<token>): download links for a file or folder, and upload-only
 * "drop box" links into a folder. Links can expire, be password protected,
 * have a download limit and be revoked.
 *
 * Every request re-checks the owner's *current* access, so removing a user's
 * permissions (or the user) also disables their links.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import express, { Request, Response } from 'express';
import { DatabaseManager } from './database';
import { resolveUserPath } from './path-utils';
import { hashPassword, verifyPasswordHash } from './password';
import { Share, ShareType, User } from './types';
import logger from './logger';

const UNLOCK_TTL_MS = 60 * 60 * 1000;

export class ShareError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function newShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function shareUrl(req: Request, token: string): string {
  return `${req.protocol}://${req.get('host')}/s/${token}`;
}

export interface CreateShareInput {
  path: string;
  type: ShareType;
  password?: string;
  expiresInDays?: number;
  maxDownloads?: number;
}

/** Validate and store a new share for `owner`. Throws ShareError on bad input. */
export function createShare(db: DatabaseManager, owner: User, input: CreateShareInput): Share {
  const type: ShareType = input.type === 'upload' ? 'upload' : 'download';
  const virtual = normalizeVirtual(input.path);
  const resolved = resolveUserPath(db.getVirtualPaths(owner.id!), virtual);
  if (!resolved || !fs.existsSync(resolved.localPath)) throw new ShareError(404, 'File or folder not found');
  const isDir = fs.statSync(resolved.localPath).isDirectory();

  if (type === 'upload') {
    if (!isDir) throw new ShareError(400, 'Upload links must point to a folder');
    if (!resolved.virtualPath.canWrite) throw new ShareError(403, 'You cannot upload to this folder');
  } else {
    if (!resolved.virtualPath.canRead || (isDir && !resolved.virtualPath.canList)) throw new ShareError(403, 'You cannot share this item');
  }

  const days = input.expiresInDays === undefined || input.expiresInDays === null ? undefined : Number(input.expiresInDays);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > 3650)) throw new ShareError(400, 'Expiry must be between 1 and 3650 days');
  const maxDownloads = input.maxDownloads === undefined || input.maxDownloads === null ? null : Number(input.maxDownloads);
  if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1)) throw new ShareError(400, 'Download limit must be a positive whole number');
  if (input.password !== undefined && input.password !== '' && String(input.password).length < 4) throw new ShareError(400, 'Link passwords need at least 4 characters');

  const share: Share = {
    token: newShareToken(),
    owner: owner.username,
    type,
    virtualPath: virtual,
    passwordHash: input.password ? hashPassword(String(input.password)) : null,
    expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    maxDownloads: type === 'download' ? maxDownloads : null,
  };
  share.id = db.createShare(share);
  return db.getShare(share.id)!;
}

/** Public view of a share (never includes the password hash). */
export function describeShare(share: Share, url?: string) {
  const { passwordHash, ...rest } = share;
  return { ...rest, url, hasPassword: !!passwordHash, status: shareStatus(share) };
}

export function shareStatus(share: Share): 'active' | 'revoked' | 'expired' | 'exhausted' {
  if (share.revoked) return 'revoked';
  if (share.expiresAt && Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  if (share.type === 'download' && share.maxDownloads && (share.downloadCount || 0) >= share.maxDownloads) return 'exhausted';
  return 'active';
}

function normalizeVirtual(p: unknown): string {
  if (typeof p !== 'string' || !p) return '/';
  const posix = p.replace(/\\/g, '/');
  if (posix.split('/').includes('..')) throw new ShareError(403, 'Invalid path');
  return path.posix.normalize('/' + posix).replace(/(.)\/$/, '$1');
}

/** A safe single file name for uploads: no separators, no dot names, no control characters. */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const base = name.replace(/\\/g, '/').split('/').pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!base || base === '.' || base === '..' || base.length > 255) return null;
  return base;
}

export interface ShareRouteOptions {
  logActivity: (username: string, action: string, filePath: string, success: boolean) => void;
  secureCookies: () => boolean;
}

export function registerShareRoutes(app: express.Application, db: DatabaseManager, options: ShareRouteOptions): void {
  const unlocked = new Map<string, { shareId: number; expires: number }>();
  const router = express.Router({ mergeParams: true });

  /** Look the share up and confirm it is usable right now. */
  const load = (req: Request, opts: { unlock?: boolean } = {}) => {
    const share = db.getShareByToken(String(req.params.token));
    if (!share || share.revoked) throw new ShareError(404, 'This link does not exist or was revoked');
    const status = shareStatus(share);
    if (status === 'expired') throw new ShareError(410, 'This link has expired');
    if (status === 'exhausted') throw new ShareError(410, 'This link has reached its download limit');

    const owner = db.getUser(share.owner);
    const resolved = owner ? resolveUserPath(db.getVirtualPaths(owner.id!), share.virtualPath) : null;
    const stillAllowed = resolved && (share.type === 'upload' ? resolved.virtualPath.canWrite : resolved.virtualPath.canRead);
    if (!owner || !resolved || !stillAllowed || !fs.existsSync(resolved.localPath)) {
      throw new ShareError(404, 'This link is no longer available');
    }

    if (opts.unlock !== false && share.passwordHash) {
      const session = unlocked.get(req.cookies?.[`share_${share.id}`] || '');
      if (!session || session.shareId !== share.id || session.expires < Date.now()) {
        throw new ShareError(401, 'Password required');
      }
    }
    return { share, owner, resolved, isDir: fs.statSync(resolved.localPath).isDirectory() };
  };

  /** Map a path inside a shared folder to disk, refusing anything outside it. */
  const inside = (ctx: ReturnType<typeof load>, rel: unknown) => {
    const relative = normalizeVirtual(rel);
    if (!ctx.isDir) return { virtual: ctx.share.virtualPath, localPath: ctx.resolved.localPath, relative: '/' };
    const virtual = path.posix.join(ctx.share.virtualPath, relative);
    const target = resolveUserPath(db.getVirtualPaths(ctx.owner.id!), virtual);
    const root = path.resolve(ctx.resolved.localPath);
    if (!target || (target.localPath !== root && !target.localPath.startsWith(root + path.sep))) {
      throw new ShareError(403, 'Invalid path');
    }
    return { virtual, localPath: target.localPath, relative };
  };

  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof ShareError) res.status(err.status).json({ error: err.message });
      else if (err?.code === 'ENOENT') res.status(404).json({ error: 'Not found' });
      else {
        logger.error('Share error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };

  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'share.html'));
  });

  router.get('/info', handle((req, res) => {
    const ctx = load(req, { unlock: false });
    const locked = !!ctx.share.passwordHash && (() => { try { load(req); return false; } catch { return true; } })();
    const stat = fs.statSync(ctx.resolved.localPath);
    res.json({
      type: ctx.share.type,
      name: path.basename(ctx.resolved.localPath) || ctx.share.virtualPath,
      isDirectory: ctx.isDir,
      size: ctx.isDir ? null : stat.size,
      owner: ctx.share.owner,
      expiresAt: ctx.share.expiresAt,
      remainingDownloads: ctx.share.maxDownloads ? ctx.share.maxDownloads - (ctx.share.downloadCount || 0) : null,
      requiresPassword: !!ctx.share.passwordHash,
      locked,
    });
  }));

  router.post('/unlock', handle((req, res) => {
    const ctx = load(req, { unlock: false });
    if (!ctx.share.passwordHash) {
      res.json({ success: true });
      return;
    }
    if (!verifyPasswordHash(ctx.share.passwordHash, String(req.body?.password || '')).valid) {
      options.logActivity(ctx.share.owner, 'SHARE_UNLOCK_FAILED', ctx.share.virtualPath, false);
      throw new ShareError(401, 'Wrong password');
    }
    const id = crypto.randomBytes(24).toString('hex');
    unlocked.set(id, { shareId: ctx.share.id!, expires: Date.now() + UNLOCK_TTL_MS });
    res.cookie(`share_${ctx.share.id}`, id, { httpOnly: true, sameSite: 'lax', secure: options.secureCookies(), maxAge: UNLOCK_TTL_MS, path: `/s/${ctx.share.token}` });
    res.json({ success: true });
  }));

  router.get('/list', handle(async (req, res) => {
    const ctx = load(req);
    if (ctx.share.type !== 'download' || !ctx.isDir) throw new ShareError(400, 'Not a shared folder');
    const target = inside(ctx, req.query.path);
    const names = await fs.promises.readdir(target.localPath);
    const files = [];
    for (const name of names) {
      const st = await fs.promises.stat(path.join(target.localPath, name)).catch(() => null);
      if (st) files.push({ name, type: st.isDirectory() ? 'directory' : 'file', size: st.isDirectory() ? 0 : st.size, modified: st.mtime });
    }
    files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    res.json({ path: target.relative, files });
  }));

  router.get('/download', handle(async (req, res) => {
    const ctx = load(req);
    if (ctx.share.type !== 'download') throw new ShareError(400, 'This is an upload link');
    const target = inside(ctx, req.query.path);
    const stat = await fs.promises.stat(target.localPath);
    if (stat.isDirectory()) throw new ShareError(400, 'Cannot download a folder');
    db.recordShareDownload(ctx.share.id!);
    options.logActivity(ctx.share.owner, 'SHARE_DOWNLOAD', target.virtual, true);
    res.download(target.localPath, path.basename(target.localPath));
  }));

  router.put('/upload', handle(async (req, res) => {
    const ctx = load(req);
    if (ctx.share.type !== 'upload') throw new ShareError(400, 'This link does not accept uploads');
    const name = safeFileName(req.query.name);
    if (!name) throw new ShareError(400, 'A valid file name is required');

    // Never overwrite: "report.pdf" becomes "report (1).pdf", ...
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let finalName = name;
    for (let i = 1; fs.existsSync(path.join(ctx.resolved.localPath, finalName)); i++) finalName = `${stem} (${i})${ext}`;

    const finalPath = path.join(ctx.resolved.localPath, finalName);
    const temp = path.join(ctx.resolved.localPath, `.${finalName}.${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      await pipeline(req, fs.createWriteStream(temp, { flags: 'wx' }));
      await fs.promises.rename(temp, finalPath);
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      throw err;
    }
    options.logActivity(ctx.share.owner, 'SHARE_UPLOAD', path.posix.join(ctx.share.virtualPath, finalName), true);
    res.status(201).json({ success: true, name: finalName, size: fs.statSync(finalPath).size });
  }));

  app.use('/s/:token', router);
}
