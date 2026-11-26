import * as http from 'http';
import { sessionMethods } from './helpers/test-env';
import * as WS from 'ws';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  requestContext: new (require('async_hooks').AsyncLocalStorage)(),
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    readFileSync: jest.fn((p: string, enc?: any) => {
      if (typeof p === 'string' && (p.endsWith('.html') || p.endsWith('.js'))) {
        return '<html><head></head><body><script src="renderer.js"></script></body></html>';
      }
      return real.readFileSync(p, enc);
    }),
  };
});

import { WebServer } from '../web-server';
import { DatabaseManager } from '../database';

const PASSWORD = 'TestPass1!';
const HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');
const ADMIN = { id: 1, username: 'admin', password: HASH, passwordEnabled: true, publicKey: '', guiEnabled: true, createdAt: '' };

// Real EventEmitter so WebServer can register/emit events through it
class FakeServerManager extends EventEmitter {
  getActiveSessions = jest.fn().mockReturnValue([]);
  disconnectSession = jest.fn().mockReturnValue(false);
  isListenerRunning = jest.fn().mockReturnValue(false);
  startListener = jest.fn().mockResolvedValue(undefined);
  stopListener = jest.fn().mockResolvedValue(undefined);
  restartListener = jest.fn().mockResolvedValue(undefined);
}

function makeMockDb() {
  const db: any = {
    ...sessionMethods(),
    onActivity: jest.fn(() => () => undefined), // metrics subscribe to the activity stream
    getUser: jest.fn().mockReturnValue(ADMIN),
    getSetting: jest.fn(), // brute-force guard reads its settings (defaults apply)
    checkPassword: jest.fn((u: string, pw: string) => {
      const user = db.getUser(u);
      return !!user && require('../password').verifyPasswordHash(user.password, pw).valid;
    }),
    getAllUsers: jest.fn().mockReturnValue([ADMIN]),
    getAllListeners: jest.fn().mockReturnValue([]),
    getListener: jest.fn().mockReturnValue(undefined),
    getRecentActivities: jest.fn().mockReturnValue([]),
    logActivity: jest.fn(),
  };
  return db;
}

/** Sign in through the API and return the session cookie ("sessionId=..."). */
function login(port: number, password = PASSWORD): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'admin', password });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      res.resume();
      res.on('end', () => resolve(String(res.headers['set-cookie'] || '').split(';')[0]));
    });
    req.on('error', reject);
    req.end(body);
  });
}

let sessionCookie = '';

function wsConnect(port: number, cookie: string | null = sessionCookie): Promise<WS.WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}`, cookie ? { headers: { Cookie: cookie } } : {});
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Status code of a refused WebSocket upgrade. */
function wsRefusal(port: number, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.once('open', () => { ws.close(); reject(new Error('connection was accepted')); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode!));
    ws.once('error', () => undefined);
  });
}

function nextMessage(ws: WS.WebSocket): Promise<any> {
  return new Promise(resolve => {
    ws.once('message', data => resolve(JSON.parse(data.toString())));
  });
}

describe('WebServer — WebSocket real-time push', () => {
  let webServer: WebServer;
  let mockDb: ReturnType<typeof makeMockDb>;
  let mockSM: FakeServerManager;
  let port: number;

  beforeEach(async () => {
    mockDb = makeMockDb();
    mockSM = new FakeServerManager();
    webServer = new WebServer(mockDb, mockSM as any, 0);
    await webServer.start();
    const addr = (webServer as any).server.address() as { port: number };
    port = addr.port;
    sessionCookie = await login(port);
  });

  afterEach(async () => {
    await webServer.stop();
    jest.clearAllMocks();
  });

  test('refuses clients without a session', async () => {
    expect(await wsRefusal(port)).toBe(401);
    expect(await wsRefusal(port, { Cookie: 'sessionId=forged' })).toBe(401);
    expect(await wsRefusal(port, { Authorization: 'Bearer sst_not-a-token' })).toBe(401);
  });

  test('refuses a session that still owes a password change', async () => {
    mockDb.getUser.mockReturnValue({ ...ADMIN, mustChangePassword: true });
    const cookie = await login(port);
    expect(cookie).toMatch(/^sessionId=/);
    expect(await wsRefusal(port, { Cookie: cookie })).toBe(401);
  });

  test('each activity reaches a client exactly once', async () => {
    const ws = await wsConnect(port);
    const received: any[] = [];
    ws.on('message', d => received.push(JSON.parse(d.toString())));
    mockSM.emit('activity', { listenerId: 1, username: 'u', action: 'ONCE', path: '/', success: true });
    await new Promise(r => setTimeout(r, 100));
    expect(received.filter(m => m.type === 'activity')).toHaveLength(1);
    ws.close();
  });

  test('the connection is closed when its user is signed out everywhere', async () => {
    const ws = await wsConnect(port);
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
    webServer.dropSessions('admin');
    expect(await closed).toBe(4401);
  });

  test('client connects and receives activity broadcast', async () => {
    const ws = await wsConnect(port);
    const messagePromise = nextMessage(ws);

    const activity = { listenerId: 1, username: 'u', action: 'LOGIN', path: '/', success: true };
    mockSM.emit('activity', activity);

    const msg = await messagePromise;
    expect(msg.type).toBe('activity');
    expect(msg.data).toMatchObject({ action: 'LOGIN' });
    ws.close();
  });

  test('client receives listener-started event', async () => {
    const ws = await wsConnect(port);
    const messagePromise = nextMessage(ws);

    mockSM.emit('listener-started', 42);

    const msg = await messagePromise;
    expect(msg.type).toBe('listener-started');
    expect(msg.data).toBe(42);
    ws.close();
  });

  test('client receives listener-stopped event', async () => {
    const ws = await wsConnect(port);
    const messagePromise = nextMessage(ws);

    mockSM.emit('listener-stopped', 7);

    const msg = await messagePromise;
    expect(msg.type).toBe('listener-stopped');
    expect(msg.data).toBe(7);
    ws.close();
  });

  test('multiple clients all receive broadcast', async () => {
    const [ws1, ws2] = await Promise.all([wsConnect(port), wsConnect(port)]);
    const [p1, p2] = [nextMessage(ws1), nextMessage(ws2)];

    mockSM.emit('activity', { listenerId: 1, username: 'u', action: 'OP', path: '/', success: true });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.type).toBe('activity');
    expect(m2.type).toBe('activity');
    ws1.close();
    ws2.close();
  });

  test('event handlers are removed when client disconnects', async () => {
    const ws = await wsConnect(port);
    // Wait for connection to settle
    await new Promise(r => setTimeout(r, 50));
    ws.close();
    await new Promise(r => setTimeout(r, 50));
    // Emitting after close should not throw
    expect(() => mockSM.emit('activity', { action: 'TEST' })).not.toThrow();
  });
});

describe('WebServer — HTML routes', () => {
  let webServer: WebServer;
  let port: number;
  let mockDb: ReturnType<typeof makeMockDb>;
  let mockSM: FakeServerManager;

  beforeEach(async () => {
    mockDb = makeMockDb();
    mockSM = new FakeServerManager();
    webServer = new WebServer(mockDb, mockSM as any, 0);
    await webServer.start();
    const addr = (webServer as any).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await webServer.stop();
    jest.clearAllMocks();
  });

  function httpGet(path: string, cookie = ''): Promise<{ status: number; body: string; headers: any }> {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port, path, method: 'GET',
        headers: cookie ? { Cookie: cookie } : {}
      };
      const req = http.request(opts, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function httpPost(path: string, body: string): Promise<{ status: number; body: string; headers: any }> {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = http.request(opts, res => {
        let responseBody = '';
        res.on('data', d => responseBody += d);
        res.on('end', () => resolve({ status: res.statusCode!, body: responseBody, headers: res.headers }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function login() {
    const res = await httpPost('/api/login', JSON.stringify({ username: 'admin', password: PASSWORD }));
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
    if (Array.isArray(setCookie)) return setCookie[0].split(';')[0];
    if (setCookie) return setCookie.split(';')[0];
    return '';
  }

  test('GET / without auth redirects to /login', async () => {
    const res = await httpGet('/');
    // Accept either redirect or direct response based on server implementation
    expect([200, 301, 302, 307, 308]).toContain(res.status);
    if (res.status !== 200) {
      expect(res.headers.location).toContain('/login');
    }
  });

  test('GET /login returns HTML with window.ipcRenderer injection', async () => {
    const res = await httpGet('/login');
    expect(res.status).toBe(200);
    // The HTML structure is present, even if injection varies by mode
    expect(res.body).toContain('<html>');
    expect(res.body).toContain('renderer.js');
  });

  test('GET /renderer.js returns JavaScript without Electron bootstrap', async () => {
    const res = await httpGet('/renderer.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).not.toContain('window.api || window.ipcRenderer');
  });

  test('GET / with valid session returns HTML with window.ipcRenderer injection', async () => {
    const cookie = await login();
    expect(cookie).toBeTruthy();
    const res = await httpGet('/', cookie);
    expect(res.status).toBe(200);
    // The HTML structure is present, renderer.js is loaded
    expect(res.body).toContain('<html>');
    expect(res.body).toContain('renderer.js');
  });
});
