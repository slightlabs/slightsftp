/**
 * e2e-web-gui.test.ts — End-to-end tests for the web-based GUI
 * Tests complete user workflows through the web server API
 */

import { WebServer } from '../web-server';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Web GUI End-to-End Workflows', () => {
  let webServer: WebServer;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let testDir: string;
  let app: any;
  const TEST_PORT = 13456;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `e2e-gui-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const dbPath = path.join(testDir, 'test.db');
    db = new DatabaseManager(dbPath);
    await db.init();

    // Create initial admin user
    db.createUser({
      username: 'admin',
      password: 'Admin#2026',
      passwordEnabled: true,
      publicKey: '',
      guiEnabled: true
    });

    serverManager = new ServerManager(db);
    webServer = new WebServer(db, serverManager, TEST_PORT);
    app = (webServer as any).app;

    await webServer.start();
  }, 30000);

  afterAll(async () => {
    try {
      if (webServer) {
        try {
          await webServer.stop();
        } catch (e) {
          // Ignore if server not running
        }
      }
      if (db) db.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Silent cleanup
    }
  }, 30000);

  describe('Authentication Workflow', () => {
    let sessionId: string;

    test('should login with valid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.username).toBe('admin');

      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    test('should get authenticated user', async () => {
      const response = await request(app)
        .get('/api/user')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.username).toBe('admin');
    });

    test('should logout', async () => {
      const response = await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test('should reject login with invalid credentials', async () => {
      const response = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'wrongpassword' });

      expect(response.status).toBe(401);
    });

    test('should reject requests without authentication', async () => {
      const response = await request(app)
        .get('/api/user');

      expect(response.status).toBe(401);
    });
  });

  describe('User Management Workflow', () => {
    let sessionId: string;

    beforeAll(async () => {
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should create a new user', async () => {
      const response = await request(app)
        .post('/api/users')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          username: 'testuser',
          password: 'testpass123',
          passwordEnabled: true,
          guiEnabled: true
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    test('should list all users', async () => {
      const response = await request(app)
        .get('/api/users')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.some((u: any) => u.username === 'admin')).toBe(true);
      expect(response.body.some((u: any) => u.username === 'testuser')).toBe(true);
    });

    test('should get specific user', async () => {
      const response = await request(app)
        .get('/api/users/testuser')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.username).toBe('testuser');
    });

    test('should update user', async () => {
      const response = await request(app)
        .put('/api/users/testuser')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          passwordEnabled: false,
          guiEnabled: true
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    test('should delete user', async () => {
      const response = await request(app)
        .delete('/api/users/testuser')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });

  describe('Listener Management Workflow', () => {
    let sessionId: string;
    let listenerId: number;

    beforeAll(async () => {
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should create a new listener', async () => {
      const response = await request(app)
        .post('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'Test SFTP Server',
          protocol: 'SFTP',
          bindingIp: '127.0.0.1',
          port: 12222,
          enabled: false
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();

      // Get the listener ID
      const listeners = await request(app)
        .get('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`);
      const newListener = listeners.body.find((l: any) => l.name === 'Test SFTP Server');
      listenerId = newListener ? newListener.id : 1;
    });

    test('should list all listeners', async () => {
      const response = await request(app)
        .get('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.some((l: any) => l.name === 'Test SFTP Server')).toBe(true);
    });

    test('should get specific listener', async () => {
      const response = await request(app)
        .get(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(listenerId);
    });

    test('should update listener', async () => {
      const response = await request(app)
        .put(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'Updated SFTP Server',
          bindingIp: '0.0.0.0',
          port: 12223,
          enabled: false
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    test('should delete listener', async () => {
      const response = await request(app)
        .delete(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });

  describe('Virtual Path Management Workflow', () => {
    let sessionId: string;
    let userId: number;
    let listenerId: number;
    let virtualPathId: number;

    beforeAll(async () => {
      userId = db.createUser({
        username: 'vpuser',
        password: 'vppass',
        passwordEnabled: true,
        guiEnabled: true
      });

      listenerId = db.createListener({
        name: 'VP Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12224,
        enabled: false
      });

      db.subscribeUserToListener(userId, listenerId);

      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should add virtual path to user', async () => {
      const response = await request(app)
        .post('/api/users/vpuser/virtual-paths')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          virtualPath: '/data',
          localPath: path.join(testDir, 'data'),
          canRead: true,
          canWrite: true,
          canList: true
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();

      // Get the virtual path ID
      const vps = await request(app)
        .get('/api/users/vpuser/virtual-paths')
        .set('Cookie', `sessionId=${sessionId}`);
      const newVp = vps.body.find((vp: any) => vp.virtualPath === '/data');
      virtualPathId = newVp ? newVp.id : 1;
    });

    test('should get user virtual paths', async () => {
      const response = await request(app)
        .get('/api/users/vpuser/virtual-paths')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(1);
    });

    test('should delete virtual path', async () => {
      const response = await request(app)
        .delete(`/api/users/vpuser/virtual-paths/${virtualPathId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });

  describe('Activity Monitoring Workflow', () => {
    let sessionId: string;

    beforeAll(async () => {
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should get recent activities', async () => {
      // Generate some activity
      await request(app)
        .get('/api/users')
        .set('Cookie', `sessionId=${sessionId}`);

      const response = await request(app)
        .get('/api/activity')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('should clear activities by date', async () => {
      const response = await request(app)
        .delete('/api/activity')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({ beforeDate: new Date().toISOString() });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });

  describe('Session Management Workflow', () => {
    let sessionId: string;

    beforeAll(async () => {
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should get all active sessions', async () => {
      const response = await request(app)
        .get('/api/sessions')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('should get listener statuses', async () => {
      const response = await request(app)
        .get('/api/listener-statuses')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('User Subscription Workflow', () => {
    let sessionId: string;
    let userId: number;
    let listenerId: number;

    beforeAll(async () => {
      userId = db.createUser({
        username: 'subuser',
        password: 'subpass',
        passwordEnabled: true,
        guiEnabled: true
      });

      listenerId = db.createListener({
        name: 'Sub Test Listener',
        protocol: 'SFTP',
        bindingIp: '127.0.0.1',
        port: 12225,
        enabled: false
      });

      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];
    });

    afterAll(async () => {
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });

    test('should subscribe user to listener', async () => {
      const response = await request(app)
        .post('/api/users/subuser/subscriptions')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({ listenerId: listenerId });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    test('should get user subscriptions', async () => {
      const response = await request(app)
        .get('/api/users/subuser/subscriptions')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('should unsubscribe user from listener', async () => {
      const response = await request(app)
        .delete(`/api/users/subuser/subscriptions/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });
});
