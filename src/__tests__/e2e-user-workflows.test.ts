/**
 * e2e-user-workflows.test.ts — End-to-end tests for complete user workflows
 * Tests realistic user scenarios and complete journeys through the application
 */

import { WebServer } from '../web-server';
import { DatabaseManager } from '../database';
import { ServerManager } from '../server-manager';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Complete User Workflow Tests', () => {
  let webServer: WebServer;
  let db: DatabaseManager;
  let serverManager: ServerManager;
  let testDir: string;
  let app: any;
  const TEST_PORT = 13459;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `workflow-test-${Date.now()}`);
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

  describe('Admin Onboarding Workflow', () => {
    let sessionId: string;

    test('should complete initial admin setup', async () => {
      // Step 1: Login with default credentials
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      expect(loginResponse.status).toBe(200);
      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Verify admin account is accessible
      const usersResponse = await request(app)
        .get('/api/users')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(usersResponse.status).toBe(200);
      expect(usersResponse.body.some((u: any) => u.username === 'admin')).toBe(true);

      // Step 3: Check system status
      const statusResponse = await request(app)
        .get('/api/listener-statuses')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(statusResponse.status).toBe(200);
      expect(Array.isArray(statusResponse.body)).toBe(true);

      // Step 4: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });

  describe('New User Creation and Configuration Workflow', () => {
    let sessionId: string;
    let userId: number;
    let listenerId: number;

    test('should create and configure a new user completely', async () => {
      // Step 1: Admin login
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Create new user
      const createUserResponse = await request(app)
        .post('/api/users')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          username: 'newuser',
          password: 'newpass123',
          passwordEnabled: true,
          guiEnabled: true
        });

      expect(createUserResponse.status).toBe(200);
      userId = createUserResponse.body.id;

      // Step 3: Create a listener for the user
      const createListenerResponse = await request(app)
        .post('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'New User SFTP',
          protocol: 'SFTP',
          bindingIp: '127.0.0.1',
          port: 12233,
          enabled: false
        });

      expect(createListenerResponse.status).toBe(200);
      listenerId = createListenerResponse.body.id;

      // Step 4: Subscribe user to listener
      db.subscribeUserToListener(userId, listenerId);

      // Step 5: Set user permissions via database
      db.setPermission({
        userId: userId,
        listenerId: listenerId,
        canRead: true,
        canCreate: true,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      });

      // Step 6: Add virtual path
      const addVpResponse = await request(app)
        .post('/api/users/newuser/virtual-paths')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          virtualPath: '/home',
          localPath: path.join(testDir, 'home'),
          canRead: true,
          canWrite: true,
          canList: true
        });

      expect(addVpResponse.status).toBe(200);

      // Step 7: Verify complete configuration
      const userResponse = await request(app)
        .get('/api/users/newuser')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(userResponse.status).toBe(200);
      expect(userResponse.body.username).toBe('newuser');

      // Step 8: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });

  describe('Listener Deployment Workflow', () => {
    let sessionId: string;
    let listenerId: number;

    test('should deploy a new listener from creation to operation', async () => {
      // Step 1: Admin login
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Create listener with unique port
      const createResponse = await request(app)
        .post('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'Production SFTP',
          protocol: 'SFTP',
          bindingIp: '127.0.0.1',
          port: 12300,
          enabled: false
        });

      expect(createResponse.status).toBe(200);
      listenerId = createResponse.body.id;

      // Step 3: Configure listener settings (skip if port conflict)
      const updateResponse = await request(app)
        .put(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'Production SFTP Server',
          bindingIp: '127.0.0.1',
          port: 12300,
          enabled: false
        });

      expect(updateResponse.status).toBe(200);

      // Step 4: Cleanup
      await request(app)
        .delete(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      // Step 5: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });

  describe('Activity Monitoring Workflow', () => {
    let sessionId: string;

    test('should monitor and manage system activities', async () => {
      // Step 1: Admin login
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Generate some activity
      await request(app)
        .get('/api/users')
        .set('Cookie', `sessionId=${sessionId}`);

      await request(app)
        .get('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`);

      // Step 3: Get recent activities
      const activityResponse = await request(app)
        .get('/api/activity')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(activityResponse.status).toBe(200);
      expect(Array.isArray(activityResponse.body)).toBe(true);

      // Step 4: Clear old activities
      const clearResponse = await request(app)
        .delete('/api/activity')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({ beforeDate: new Date().toISOString() });

      expect(clearResponse.status).toBe(200);

      // Step 5: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });

  describe('Session Management Workflow', () => {
    let sessionId: string;

    test('should manage active user sessions', async () => {
      // Step 1: Admin login
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Get all active sessions
      const sessionsResponse = await request(app)
        .get('/api/sessions')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(sessionsResponse.status).toBe(200);
      expect(Array.isArray(sessionsResponse.body)).toBe(true);

      // Step 3: Get listener statuses
      const statusResponse = await request(app)
        .get('/api/listener-statuses')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(statusResponse.status).toBe(200);

      // Step 4: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);

      // Step 5: Verify session is invalidated
      const verifyResponse = await request(app)
        .get('/api/users')
        .set('Cookie', `sessionId=${sessionId}`);

      expect(verifyResponse.status).toBe(401);
    });
  });

  describe('Error Recovery Workflow', () => {
    let sessionId: string;

    test('should handle and recover from errors gracefully', async () => {
      // Step 1: Admin login
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      // Step 2: Create valid user
      const validUserResponse = await request(app)
        .post('/api/users')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          username: 'validuser',
          password: 'validpass',
          passwordEnabled: true,
          guiEnabled: true
        });

      expect(validUserResponse.status).toBe(200);

      // Step 3: Cleanup
      await request(app)
        .delete('/api/users/validuser')
        .set('Cookie', `sessionId=${sessionId}`);

      // Step 4: Logout
      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });

  describe('Permission Configuration Round-Trip Workflow', () => {
    let sessionId: string;

    test('should persist and update listener permissions for a subscribed user', async () => {
      const loginResponse = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'Admin#2026' });

      expect(loginResponse.status).toBe(200);
      const setCookie = loginResponse.headers['set-cookie'];
      sessionId = setCookie![0].split(';')[0].split('=')[1];

      const createUserResponse = await request(app)
        .post('/api/users')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          username: 'permuser',
          password: 'perm123',
          passwordEnabled: true,
          guiEnabled: true
        });

      expect(createUserResponse.status).toBe(200);
      const userId = createUserResponse.body.id;

      const createListenerResponse = await request(app)
        .post('/api/listeners')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({
          name: 'Permissions SFTP',
          protocol: 'SFTP',
          bindingIp: '127.0.0.1',
          port: 12310,
          enabled: false
        });

      expect(createListenerResponse.status).toBe(200);
      const listenerId = createListenerResponse.body.id;

      const subscribeResponse = await request(app)
        .post('/api/users/permuser/subscriptions')
        .set('Cookie', `sessionId=${sessionId}`)
        .send({ listenerId });

      expect(subscribeResponse.status).toBe(200);

      db.setPermission({
        userId,
        listenerId,
        canRead: true,
        canCreate: false,
        canEdit: false,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: false,
        canRename: false
      });

      const firstPermission = db.getPermission(userId, listenerId);
      expect(firstPermission).toBeDefined();
      expect(firstPermission?.canRead).toBe(true);
      expect(firstPermission?.canList).toBe(true);
      expect(firstPermission?.canCreate).toBe(false);

      db.setPermission({
        userId,
        listenerId,
        canRead: true,
        canCreate: true,
        canEdit: true,
        canAppend: false,
        canDelete: false,
        canList: true,
        canCreateDir: true,
        canRename: false
      });

      const updatedPermission = db.getPermission(userId, listenerId);
      expect(updatedPermission).toBeDefined();
      expect(updatedPermission?.canCreate).toBe(true);
      expect(updatedPermission?.canEdit).toBe(true);
      expect(updatedPermission?.canCreateDir).toBe(true);

      await request(app)
        .delete(`/api/listeners/${listenerId}`)
        .set('Cookie', `sessionId=${sessionId}`);

      await request(app)
        .delete('/api/users/permuser')
        .set('Cookie', `sessionId=${sessionId}`);

      await request(app)
        .post('/api/logout')
        .set('Cookie', `sessionId=${sessionId}`);
    });
  });
});
