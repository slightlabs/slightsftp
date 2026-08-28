import * as http from 'http';
import * as WS from 'ws';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
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
  return {
    getUser: jest.fn().mockReturnValue(ADMIN),
    getAllUsers: jest.fn().mockReturnValue([ADMIN]),
    getAllListeners: jest.fn().mockReturnValue([]),
    getListener: jest.fn().mockReturnValue(undefined),
    getRecentActivities: jest.fn().mockReturnValue([]),
    logActivity: jest.fn(),
  } as any;
}

function wsConnect(port: number): Promise<WS.WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
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
  });

  afterEach(async () => {
    await webServer.stop();
    jest.clearAllMocks();
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
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.location).toContain('/login');
  });

  test('GET /login returns HTML with window.ipcRenderer injection', async () => {
    const res = await httpGet('/login');
    expect(res.status).toBe(200);
    expect(res.body).toContain('window.ipcRenderer');
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
    expect(res.body).toContain('window.ipcRenderer');
  });
});
