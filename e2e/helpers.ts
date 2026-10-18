import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export const ROOT = path.resolve(__dirname, '..');
export const DIST = path.join(ROOT, 'dist');

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `slightsftp-e2e-${prefix}-`));
}

export function httpStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, res => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
  });
}

export async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await httpStatus(url)) < 500) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Start the real headless entrypoint (dist/web-only.js) in an isolated working directory. */
export async function startWebOnlyServer(cwd: string, port: number): Promise<ChildProcess> {
  if (!fs.existsSync(path.join(DIST, 'web-only.js'))) {
    throw new Error('dist/ is missing — run `npm run build` (or `npm run test:e2e`) first');
  }
  const child = spawn(process.execPath, [path.join(DIST, 'web-only.js')], {
    cwd,
    env: { ...process.env, WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', d => { output += d; });
  child.stderr!.on('data', d => { output += d; });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/login`);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${(err as Error).message}\n--- server output ---\n${output}`);
  }
  return child;
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
