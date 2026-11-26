import * as fs from 'fs';
import * as path from 'path';
import { VirtualPath } from './types';
import { cloudPath, isCloudPath, joinKey, parseCloudPath } from './cloud-storage';

export interface ResolvedUserPath {
  virtualPath: VirtualPath;
  localPath: string;
}

/**
 * Map a client-supplied virtual path (e.g. "/docs/a.txt") onto the local
 * filesystem using the user's virtual path table.
 *
 * Returns null when no virtual path matches, when the request contains ".."
 * segments, or when the resolved path would escape the matched local root.
 * The most specific (longest) virtual path wins. Cloud virtual paths resolve
 * to "cloud://<connectionId>/<key>" (see cloud-storage.ts).
 */
export function resolveUserPath(virtualPaths: VirtualPath[], requestedPath: string): ResolvedUserPath | null {
  const raw = (requestedPath || '/').replace(/\\/g, '/');
  if (raw.split('/').includes('..')) return null;

  const normalized = path.posix.normalize('/' + raw);
  const candidates = [...virtualPaths].sort((a, b) => b.virtualPath.length - a.virtualPath.length);

  for (const vp of candidates) {
    const vpNorm = path.posix.normalize('/' + vp.virtualPath).replace(/(.)\/$/, '$1');
    const matches = vpNorm === '/' || normalized === vpNorm || normalized.startsWith(vpNorm + '/');
    if (!matches) continue;

    const relative = vpNorm === '/' ? normalized : normalized.slice(vpNorm.length);
    if (isCloudPath(vp.localPath)) {
      // cloud folders: "cloud://<id>/<prefix>/<relative>" (".." was refused above)
      const cloud = parseCloudPath(vp.localPath);
      if (!cloud) return null;
      return { virtualPath: vp, localPath: cloudPath(cloud.connectionId, joinKey(cloud.prefix, relative)) };
    }
    const root = path.resolve(vp.localPath);
    const localPath = path.resolve(root, '.' + (relative || '/'));
    if (localPath !== root && !localPath.startsWith(root + path.sep)) return null;
    if (escapesRoot(root, localPath)) return null;

    return { virtualPath: vp, localPath };
  }

  return null;
}

/** Thrown when a path resolves (through a symlink) outside the user's folders. */
export class PathEscapeError extends Error {
  constructor(public readonly localPath: string) {
    super('Permission denied');
    this.name = 'PathEscapeError';
  }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * True when localPath, once symlinks are followed, lies outside root.
 *
 * The lexical check in resolveUserPath stops "..", but a symlink inside a
 * shared folder (e.g. docs/etc -> /etc) would still lead out of it. Resolve
 * the real path of the deepest part of localPath that exists (the rest is
 * about to be created) and compare it with the real path of root. A dangling
 * symlink counts as an escape: writing through it would create its target.
 * A root that does not exist yet cannot contain links, so nothing escapes it.
 */
export function escapesRoot(root: string, localPath: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return false;
  }
  let current = path.resolve(localPath);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return !inside(realRoot, path.join(real, ...rest));
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return true;
      // exists as an entry but can't be resolved: a dangling (or looping) link
      try {
        fs.lstatSync(current);
        return true;
      } catch { /* really missing: look at its parent */ }
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    rest.unshift(path.basename(current));
    current = parent;
  }
}

/** Throw PathEscapeError when localPath leads outside root through a symlink. */
export function assertInsideRoot(root: string, localPath: string): string {
  if (escapesRoot(root, localPath)) throw new PathEscapeError(localPath);
  return localPath;
}
