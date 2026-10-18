/**
 * Browser file portal: end users sign in at /files and manage their files with
 * the same virtual paths and virtual-path permissions they have over SFTP/FTP.
 *
 * Portal sessions use their own cookie and never grant access to the admin API.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import express, { Request, Response, NextFunction } from 'express';
import { DatabaseManager } from './database';
import { resolveUserPath, ResolvedUserPath } from './path-utils';
import { requiresPasswordChange, validateNewPassword } from './password';
import { User, VirtualPath } from './types';
import logger from './logger';
import QRCode from 'qrcode';
import { createShare, describeShare, shareUrl, ShareError } from './shares';
import { getLoginGuard, TOO_MANY_ATTEMPTS, userIpAllowed } from './login-guard';
import { beginTotpSetup, checkSecondFactor, confirmTotpSetup, disableTotp } from './two-factor';

export const PORTAL_COOKIE = 'portalSession';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type VpPermission = 'canRead' | 'canWrite' | 'canDelete' | 'canList' | 'canCreateDir' | 'canRename';

interface PortalSession {
  username: string;
  createdAt: number;
  mustChangePassword: boolean;
}

export interface PortalOptions {
  /** record an activity entry (and push it to admin GUIs) */
  logActivity: (username: string, action: string, filePath: string, success: boolean) => void;
  secureCookies: () => boolean;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Virtual paths loaded from the database always carry explicit booleans
const allowed = (vp: VirtualPath, perm: VpPermission) => !!vp[perm];

function normalizeVirtual(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) return '/';
  const posix = p.replace(/\\/g, '/');
  if (posix.split('/').includes('..')) throw new HttpError(403, 'No access to this path');
  return path.posix.normalize('/' + posix).replace(/(.)\/$/, '$1');
}

export function registerPortalRoutes(app: express.Application, db: DatabaseManager, options: PortalOptions): void {
  const sessions = new Map<string, PortalSession>();
  const router = express.Router();

  const currentUser = (req: Request): { session: PortalSession; user: User } | null => {
    const id = req.cookies?.[PORTAL_COOKIE];
    const session = id ? sessions.get(id) : undefined;
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      return null;
    }
    const user = db.getUser(session.username);
    if (!user || !user.portalEnabled) {
      sessions.delete(id);
      return null;
    }
    return { session, user };
  };

  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    const current = currentUser(req);
    if (!current) {
      res.status(401).json({ error: 'Please sign in' });
      return;
    }
    if (current.session.mustChangePassword && req.path !== '/change-password' && req.path !== '/me' && req.path !== '/logout') {
      res.status(403).json({ error: 'Password change required', requirePasswordChange: true });
      return;
    }
    (req as any).portalUser = current.user;
    (req as any).portalSession = current.session;
    next();
  };

  /** Resolve a client path and check one virtual-path permission. */
  const resolveFor = (user: User, rawPath: unknown, perm: VpPermission): ResolvedUserPath & { virtual: string } => {
    const virtual = normalizeVirtual(rawPath);
    const resolved = resolveUserPath(db.getVirtualPaths(user.id!), virtual);
    if (!resolved) throw new HttpError(403, 'No access to this path');
    if (!allowed(resolved.virtualPath, perm)) throw new HttpError(403, 'Permission denied');
    return { ...resolved, virtual };
  };

  const permissionsAt = (user: User, virtual: string) => {
    const resolved = resolveUserPath(db.getVirtualPaths(user.id!), virtual);
    const vp = resolved?.virtualPath;
    const perms: Record<VpPermission, boolean> = { canRead: false, canWrite: false, canDelete: false, canList: false, canCreateDir: false, canRename: false };
    if (vp) (Object.keys(perms) as VpPermission[]).forEach(k => { perms[k] = allowed(vp, k); });
    return perms;
  };

  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
      } else if (err?.code === 'ENOENT') {
        res.status(404).json({ error: 'Not found' });
      } else if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') {
        res.status(409).json({ error: err.code === 'EEXIST' ? 'Already exists' : 'Folder is not empty' });
      } else {
        logger.error('Portal error:', err);
        res.status(500).json({ error: 'Internal error' });
      }
    }
  };

  // ── auth ────────────────────────────────────────────────────────────────
  router.post('/login', handle((req, res) => {
    const { username, password } = req.body || {};
    const guard = getLoginGuard(db);
    const ip = req.socket.remoteAddress;
    if (guard.isBanned(ip)) throw new HttpError(429, TOO_MANY_ATTEMPTS);
    const user = typeof username === 'string' ? db.getUser(username) : undefined;
    if (!user || !user.portalEnabled || !user.passwordEnabled || !userIpAllowed(user, ip) || typeof password !== 'string' || !db.checkPassword(user.username, password)) {
      options.logActivity(String(username || 'unknown'), 'PORTAL_LOGIN_FAILED', '/', false);
      guard.recordFailure(ip, 'file portal', String(username || ''));
      throw new HttpError(401, 'Invalid username or password');
    }
    const second = checkSecondFactor(db, user, req.body?.totp);
    if (second !== 'ok') {
      if (second === 'invalid') {
        options.logActivity(user.username, 'PORTAL_LOGIN_FAILED', 'Invalid two-factor code', false);
        guard.recordFailure(ip, 'file portal', user.username);
      }
      res.status(401).json({ error: second === 'required' ? 'Enter the code from your authenticator app' : 'Invalid two-factor code', requireTotp: true });
      return;
    }
    guard.recordSuccess(ip);
    const id = crypto.randomBytes(32).toString('hex');
    const mustChangePassword = requiresPasswordChange(user, password);
    sessions.set(id, { username: user.username, createdAt: Date.now(), mustChangePassword });
    res.cookie(PORTAL_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: options.secureCookies(), maxAge: SESSION_TTL_MS, path: '/' });
    options.logActivity(user.username, 'PORTAL_LOGIN', '/', true);
    res.json(mustChangePassword ? { success: true, username: user.username, requirePasswordChange: true } : { success: true, username: user.username });
  }));

  router.post('/logout', (req, res) => {
    const id = req.cookies?.[PORTAL_COOKIE];
    if (id) sessions.delete(id);
    res.clearCookie(PORTAL_COOKIE, { path: '/' });
    res.json({ success: true });
  });

  router.use(requireUser);

  router.get('/me', (req, res) => {
    const user: User = (req as any).portalUser;
    res.json({
      username: user.username,
      requirePasswordChange: (req as any).portalSession.mustChangePassword,
      totpEnabled: !!user.totpEnabled,
      roots: db.getVirtualPaths(user.id!).map(vp => vp.virtualPath),
    });
  });

  router.post('/change-password', handle((req, res) => {
    const user: User = (req as any).portalUser;
    const session: PortalSession = (req as any).portalSession;
    const { newPassword, currentPassword } = req.body || {};
    if (!session.mustChangePassword && !db.checkPassword(user.username, currentPassword || '')) {
      throw new HttpError(401, 'Current password is incorrect');
    }
    const problem = validateNewPassword(newPassword);
    if (problem) throw new HttpError(400, problem);
    if (db.checkPassword(user.username, newPassword)) throw new HttpError(400, 'The new password must be different from the current one');
    db.updateUser(user.username, { password: newPassword, mustChangePassword: false });
    session.mustChangePassword = false;
    options.logActivity(user.username, 'PORTAL_PASSWORD_CHANGED', '/', true);
    res.json({ success: true });
  }));

  // ── two-factor sign-in ─────────────────────────────────────────────────
  router.post('/2fa/setup', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    res.json(await beginTotpSetup(db, user.username));
  }));

  router.post('/2fa/enable', handle((req, res) => {
    const user: User = (req as any).portalUser;
    if (!confirmTotpSetup(db, user.username, req.body?.code)) throw new HttpError(400, 'That code is not valid. Check the time on your phone and try again.');
    options.logActivity(user.username, 'PORTAL_2FA_ENABLED', '/', true);
    res.json({ success: true });
  }));

  router.post('/2fa/disable', handle((req, res) => {
    const user: User = (req as any).portalUser;
    if (!disableTotp(db, user.username, req.body?.code)) throw new HttpError(400, 'Invalid two-factor code');
    options.logActivity(user.username, 'PORTAL_2FA_DISABLED', '/', true);
    res.json({ success: true });
  }));

  // ── files ───────────────────────────────────────────────────────────────
  router.get('/list', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const virtual = normalizeVirtual(req.query.path);
    const vps = db.getVirtualPaths(user.id!);

    // Users without a "/" mapping see their mapped folders as the top level
    if (virtual === '/' && !resolveUserPath(vps, '/')) {
      const tops = Array.from(new Set(vps.map(vp => vp.virtualPath.split('/').filter(Boolean)[0]).filter(Boolean)));
      res.json({ path: '/', permissions: permissionsAt(user, '/'), files: tops.map(name => ({ name, type: 'directory', size: 0, modified: null })) });
      return;
    }

    const target = resolveFor(user, virtual, 'canList');
    const stat = await fs.promises.stat(target.localPath);
    if (!stat.isDirectory()) throw new HttpError(400, 'Not a folder');
    const names = await fs.promises.readdir(target.localPath);
    const files = [];
    for (const name of names) {
      try {
        const st = await fs.promises.stat(path.join(target.localPath, name));
        files.push({ name, type: st.isDirectory() ? 'directory' : 'file', size: st.isDirectory() ? 0 : st.size, modified: st.mtime });
      } catch { /* vanished or unreadable entry */ }
    }
    files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    options.logActivity(user.username, 'PORTAL_LIST', virtual, true);
    res.json({ path: virtual, permissions: permissionsAt(user, virtual), files });
  }));

  router.get('/download', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const target = resolveFor(user, req.query.path, 'canRead');
    const stat = await fs.promises.stat(target.localPath);
    if (stat.isDirectory()) throw new HttpError(400, 'Cannot download a folder');
    options.logActivity(user.username, 'PORTAL_DOWNLOAD', target.virtual, true);
    res.download(target.localPath, path.basename(target.localPath));
  }));

  router.put('/upload', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const target = resolveFor(user, req.query.path, 'canWrite');
    if (target.virtual === '/' || path.basename(target.localPath) === '') throw new HttpError(400, 'A file name is required');
    const parent = path.dirname(target.localPath);
    if (!(await fs.promises.stat(parent).catch(() => null))?.isDirectory()) throw new HttpError(404, 'Folder not found');
    if ((await fs.promises.stat(target.localPath).catch(() => null))?.isDirectory()) throw new HttpError(409, 'A folder with that name exists');

    // Write to a temp file first so an aborted upload never leaves a truncated file
    const temp = path.join(parent, `.${path.basename(target.localPath)}.${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      await pipeline(req, fs.createWriteStream(temp, { flags: 'wx' }));
      await fs.promises.rename(temp, target.localPath);
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      throw err;
    }
    const size = (await fs.promises.stat(target.localPath)).size;
    options.logActivity(user.username, 'PORTAL_UPLOAD', target.virtual, true);
    res.status(201).json({ success: true, path: target.virtual, size });
  }));

  router.post('/mkdir', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const target = resolveFor(user, req.body?.path, 'canCreateDir');
    await fs.promises.mkdir(target.localPath);
    options.logActivity(user.username, 'PORTAL_MKDIR', target.virtual, true);
    res.status(201).json({ success: true });
  }));

  router.post('/rename', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const from = resolveFor(user, req.body?.from, 'canRename');
    const to = resolveFor(user, req.body?.to, 'canRename');
    if (await fs.promises.stat(to.localPath).catch(() => null)) throw new HttpError(409, 'Already exists');
    await fs.promises.rename(from.localPath, to.localPath);
    options.logActivity(user.username, 'PORTAL_RENAME', `${from.virtual} -> ${to.virtual}`, true);
    res.json({ success: true });
  }));

  router.delete('/file', handle(async (req, res) => {
    const user: User = (req as any).portalUser;
    const target = resolveFor(user, req.query.path, 'canDelete');
    if (target.localPath === path.resolve(target.virtualPath.localPath)) throw new HttpError(403, 'Cannot delete a shared root folder');
    const stat = await fs.promises.stat(target.localPath);
    if (stat.isDirectory()) {
      await fs.promises.rmdir(target.localPath);
    } else {
      await fs.promises.unlink(target.localPath);
    }
    options.logActivity(user.username, 'PORTAL_DELETE', target.virtual, true);
    res.json({ success: true });
  }));

  // ── share links ─────────────────────────────────────────────────────────
  router.get('/shares', (req, res) => {
    const user: User = (req as any).portalUser;
    res.json(db.listShares(user.username).map(sh => describeShare(sh, shareUrl(req, sh.token))));
  });

  router.post('/shares', handle((req, res) => {
    const user: User = (req as any).portalUser;
    try {
      const share = createShare(db, user, req.body || {});
      options.logActivity(user.username, share.type === 'upload' ? 'SHARE_CREATED_UPLOAD' : 'SHARE_CREATED', share.virtualPath, true);
      res.status(201).json(describeShare(share, shareUrl(req, share.token)));
    } catch (err) {
      if (err instanceof ShareError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }));

  const ownShare = (req: Request) => {
    const user: User = (req as any).portalUser;
    const share = db.getShare(Number(req.params.id));
    if (!share || share.owner !== user.username) throw new HttpError(404, 'Link not found');
    return share;
  };

  router.delete('/shares/:id', handle((req, res) => {
    const share = ownShare(req);
    db.revokeShare(share.id!);
    options.logActivity(share.owner, 'SHARE_REVOKED', share.virtualPath, true);
    res.json({ success: true });
  }));

  router.get('/shares/:id/qr.svg', handle(async (req, res) => {
    const share = ownShare(req);
    const svg = await QRCode.toString(shareUrl(req, share.token), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  }));

  app.use('/portal/api', router);
}
