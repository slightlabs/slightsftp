import * as path from 'path';
import { VirtualPath } from './types';

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
 * The most specific (longest) virtual path wins.
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
    const root = path.resolve(vp.localPath);
    const localPath = path.resolve(root, '.' + (relative || '/'));
    if (localPath !== root && !localPath.startsWith(root + path.sep)) return null;

    return { virtualPath: vp, localPath };
  }

  return null;
}
