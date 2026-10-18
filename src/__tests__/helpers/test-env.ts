/**
 * Shared helpers for integration / end-to-end tests.
 * Not a test file itself (jest only runs *.test.ts).
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Ask the OS for an unused TCP port on 127.0.0.1. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Create a unique temp directory for a test suite. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `slightsftp-${prefix}-`));
}

export function removeDir(dir: string | undefined): void {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}`);
}

export const FULL_VPATH_PERMS = {
  canRead: true,
  canWrite: true,
  canAppend: true,
  canDelete: true,
  canList: true,
  canCreateDir: true,
  canRename: true,
  applyToSubdirs: true,
};
