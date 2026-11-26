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

/**
 * The session methods of DatabaseManager, kept in a Map, for tests that hand
 * WebServer a mocked database: spread into the mock (`{ ...sessionMethods(), ... }`).
 */
export function sessionMethods() {
  const rows = new Map<string, any>();
  const key = (kind: string, hash: string) => `${kind}:${hash}`;
  return {
    createSession: jest.fn((s: any) => { rows.set(key(s.kind, s.tokenHash), { ...s }); }),
    getSession: jest.fn((kind: string, hash: string) => rows.get(key(kind, hash))),
    updateSession: jest.fn((kind: string, hash: string, fields: any) => {
      const row = rows.get(key(kind, hash));
      if (row) Object.assign(row, fields);
    }),
    deleteSession: jest.fn((kind: string, hash: string) => { rows.delete(key(kind, hash)); }),
    deleteSessionsForUser: jest.fn((kind: string, username: string, except?: string) => {
      for (const [k, row] of rows) if (row.kind === kind && row.username === username && row.tokenHash !== except) rows.delete(k);
    }),
    deleteSessionsBefore: jest.fn((kind: string, before: number) => {
      for (const [k, row] of rows) if (row.kind === kind && row.createdAt < before) rows.delete(k);
    }),
  };
}
