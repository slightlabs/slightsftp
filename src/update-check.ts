/**
 * Update notifications: ask GitHub Releases for the latest version and tell
 * the admin when a newer one exists. (In-place auto-update is not possible
 * for the MSI / .deb packages, so the dashboard links to the download.)
 */
import { DatabaseManager } from './database';

export const RELEASES_API = 'https://api.github.com/repos/slightlabs/slightsftp/releases/latest';
const CACHE_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  url: string | null;
  checkedAt: string | null;
  error?: string;
}

/** Compare "1.10.0" vs "1.9.3" (a leading "v" and pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let cache: { at: number; info: UpdateInfo } | null = null;

export function updateChecksEnabled(db: DatabaseManager): boolean {
  if (process.env.SLIGHTSFTP_NO_UPDATE_CHECK === '1') return false; // offline installs / test runs
  return db.getSetting('updateCheck') !== 'false';
}

export async function checkForUpdate(
  db: DatabaseManager,
  currentVersion: string,
  options: { force?: boolean; url?: string; timeoutMs?: number } = {}
): Promise<UpdateInfo> {
  const none: UpdateInfo = { currentVersion, latestVersion: null, updateAvailable: false, url: null, checkedAt: null };
  if (!updateChecksEnabled(db)) return none;
  if (!options.force && cache && Date.now() - cache.at < CACHE_MS && cache.info.currentVersion === currentVersion) return cache.info;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const res = await fetch(options.url || RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `SLightSFTP/${currentVersion}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release: any = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+/.test(latest)) throw new Error('Unexpected release data');
    const info: UpdateInfo = {
      currentVersion,
      latestVersion: latest,
      updateAvailable: compareVersions(latest, currentVersion) > 0,
      url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : null,
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), info };
    return info;
  } catch (err: any) {
    return { ...none, error: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** For tests. */
export function resetUpdateCache(): void {
  cache = null;
}
