/**
 * Logging for operations: JSON lines on request (LOG_FORMAT=json), no colour
 * codes outside a terminal, a request id on every web request and on what is
 * logged while handling it, and no process exit from the logger itself.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import request from 'supertest';
import express from 'express';

jest.setTimeout(30000);

const root = path.join(__dirname, '..', '..');

/** Run a snippet that imports the logger in a fresh process with the given environment. */
function runLogger(env: Record<string, string>, code: string) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    env: { ...process.env, LOG_FILES: 'false', ...env },
    encoding: 'utf8',
  });
}

describe('logger output', () => {
  // the compiled logger is not available under ts-jest; transpile it on the fly
  const ts = require('typescript');
  const fs = require('fs');
  const source = fs.readFileSync(path.join(root, 'src', 'logger.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  // inside the project, so the snippet resolves winston from node_modules
  const tmp = path.join(root, 'node_modules', '.cache', `slightsftp-logger-${process.pid}.js`);
  beforeAll(() => {
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, js);
  });
  afterAll(() => fs.rmSync(tmp, { force: true }));

  test('LOG_FORMAT=json writes one JSON object per line, with ISO timestamps and error stacks', () => {
    const out = runLogger({ LOG_FORMAT: 'json' }, `
      const logger = require(${JSON.stringify(tmp)}).default;
      logger.info('listener started', { port: 2222 });
      logger.error('it broke', new Error('boom'));
    `);
    const lines = out.stdout.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toMatchObject({ level: 'info', message: 'listener started', port: 2222 });
    expect(lines[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(lines[1]).toMatchObject({ level: 'error' });
    expect(lines[1].message).toContain('it broke');
    expect(lines[1].stack).toContain('Error: boom');
  });

  test('text output has no colour codes when stdout is not a terminal', () => {
    const out = runLogger({}, `require(${JSON.stringify(tmp)}).default.warn('careful');`);
    expect(out.stdout).toMatch(/\[warn\]: careful/);
    expect(out.stdout).not.toMatch(/\u001b\[/);
  });

  test('an uncaught exception is not turned into an immediate exit by the logger', () => {
    // with winston's exception handlers this process would exit with code 1 before the timer fires
    const out = runLogger({}, `
      require(${JSON.stringify(tmp)});
      process.on('uncaughtException', () => { setTimeout(() => { console.log('still running'); process.exit(0); }, 50); });
      setTimeout(() => { throw new Error('stray'); }, 10);
    `);
    expect(out.stdout).toContain('still running');
    expect(out.status).toBe(0);
  });
});

describe('request ids', () => {
  const { DatabaseManager } = require('../database');
  const { ServerManager } = require('../server-manager');
  const { WebServer } = require('../web-server');
  const logger = require('../logger').default;
  const { getFreePort, makeTempDir, removeDir } = require('./helpers/test-env');
  let dir: string;
  let db: any;
  let web: any;
  let base: string;

  beforeAll(async () => {
    dir = makeTempDir('logging');
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
    const port = await getFreePort();
    web = new WebServer(db, new ServerManager(db), port);
    await web.start();
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await web.stop();
    db.close();
    removeDir(dir);
  });

  test('every response carries X-Request-Id; a sane incoming id is kept, anything else replaced', async () => {
    const own = await request(base).get('/healthz').expect(200);
    expect(own.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await request(base).get('/healthz').set('X-Request-Id', 'lb-7f3a.42').expect(200);
    expect(kept.headers['x-request-id']).toBe('lb-7f3a.42');
    const replaced = await request(base).get('/healthz').set('X-Request-Id', 'bad id with spaces').expect(200);
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('requests are logged at the "http" level with id, status and timing, without the query string', async () => {
    const log = jest.spyOn(logger, 'log');
    const res = await request(base).get('/api/users?token=secret').expect(401);
    const entry = log.mock.calls.find(c => c[0] === 'http' && (c[2] as any)?.path === '/api/users');
    expect(entry).toBeDefined();
    expect(entry![2]).toMatchObject({ requestId: res.headers['x-request-id'], method: 'GET', status: 401 });
    expect(JSON.stringify(entry)).not.toContain('secret');
    log.mockRestore();
  });

  test('messages logged while handling a request carry its id', async () => {
    const app = express();
    const { requestContext } = require('../logger');
    app.use((req, res, next) => requestContext.run({ requestId: 'abc-123' }, () => next()));
    app.get('/x', async (req, res) => {
      await new Promise(r => setTimeout(r, 5));
      res.json({ id: requestContext.getStore()?.requestId });
    });
    const res = await request(app).get('/x').expect(200);
    expect(res.body.id).toBe('abc-123');
  });
});
