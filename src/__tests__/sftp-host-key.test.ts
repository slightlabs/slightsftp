/**
 * sftp-host-key.test.ts — the SFTP server identity must survive restarts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'ssh2';
import { DatabaseManager } from '../database';
import { SFTPServer } from '../sftp-server';
import { SSH_HOST_KEY_FILE, hostKeyFingerprint, setCertificateDir } from '../tls';
import { getFreePort, makeTempDir, removeDir } from './helpers/test-env';
import * as crypto from 'crypto';

jest.setTimeout(30000);

/** Connect and return the SHA-256 fingerprint of the host key the server presents. */
function presentedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fp = '';
    conn.on('error', () => resolve(fp)); // auth fails; we only want the host key
    conn.on('close', () => resolve(fp));
    conn.connect({
      host: '127.0.0.1', port, username: 'nobody', password: 'x', readyTimeout: 5000,
      hostVerifier: (key: Buffer) => {
        fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        return true;
      },
    });
    setTimeout(() => { conn.end(); reject(new Error('timeout')); }, 8000).unref();
  });
}

describe('SFTP host key', () => {
  let dir: string;
  let db: DatabaseManager;

  beforeAll(async () => {
    dir = makeTempDir('hostkey');
    setCertificateDir(dir);
    db = new DatabaseManager(path.join(dir, 'config.db'));
    await db.init();
  });

  afterAll(() => { db.close(); removeDir(dir); });

  test('is generated once, stored privately, and reused by every listener and restart', async () => {
    const fingerprints: string[] = [];
    for (let i = 0; i < 2; i++) {
      const port = await getFreePort();
      const server = new SFTPServer({ id: 100 + i, name: `S${i}`, protocol: 'SFTP', bindingIp: '127.0.0.1', port, enabled: true }, db);
      await server.start();
      fingerprints.push(await presentedFingerprint(port));
      await server.stop();
    }

    expect(fingerprints[0]).toMatch(/^SHA256:/);
    expect(fingerprints[1]).toBe(fingerprints[0]);
    expect(hostKeyFingerprint(dir)).toBe(fingerprints[0]);

    const file = path.join(dir, SSH_HOST_KEY_FILE);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/BEGIN RSA PRIVATE KEY/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });
});
