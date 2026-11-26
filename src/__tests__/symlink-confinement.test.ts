/**
 * Symlinks inside a user's folder must not lead out of it: "..", which the
 * lexical checks already refuse, is not the only way out of a folder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client as FtpClient } from 'basic-ftp';
import { DatabaseManager } from '../database';
import { FTPServer } from '../ftp-server';
import { SFTPServer } from '../sftp-server';
import { escapesRoot, resolveUserPath } from '../path-utils';
import { VirtualPath } from '../types';
const SftpClient = require('ssh2-sftp-client');

// creating symlinks on Windows needs administrator rights or developer mode
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('symlink confinement', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-symlink-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'docs', 'ok.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'escape'));                       // folder link out
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt')); // file link out
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(root, 'dangling.txt'));  // dangling link out
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'docs-link'));    // link that stays inside
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  describe('escapesRoot', () => {
    it('allows real files, missing files and links that stay inside', () => {
      expect(escapesRoot(root, path.join(root, 'docs', 'ok.txt'))).toBe(false);
      expect(escapesRoot(root, path.join(root, 'docs', 'new', 'deeper.txt'))).toBe(false);
      expect(escapesRoot(root, path.join(root, 'docs-link', 'ok.txt'))).toBe(false);
      expect(escapesRoot(root, root)).toBe(false);
    });

    it('refuses folder links, file links and dangling links that lead out', () => {
      expect(escapesRoot(root, path.join(root, 'escape'))).toBe(true);
      expect(escapesRoot(root, path.join(root, 'escape', 'secret.txt'))).toBe(true);
      expect(escapesRoot(root, path.join(root, 'escape', 'not-yet.txt'))).toBe(true);
      expect(escapesRoot(root, path.join(root, 'secret.txt'))).toBe(true);
      expect(escapesRoot(root, path.join(root, 'dangling.txt'))).toBe(true);
    });

    it('accepts a root that is itself a symlink (an admin choice)', () => {
      const linkedRoot = path.join(base, 'linked-root');
      fs.symlinkSync(root, linkedRoot);
      expect(escapesRoot(linkedRoot, path.join(linkedRoot, 'docs', 'ok.txt'))).toBe(false);
      expect(escapesRoot(linkedRoot, path.join(linkedRoot, 'escape', 'secret.txt'))).toBe(true);
    });

    it('treats a root that does not exist yet as having nothing to escape through', () => {
      expect(escapesRoot(path.join(base, 'missing'), path.join(base, 'missing', 'a.txt'))).toBe(false);
    });
  });

  describe('resolveUserPath', () => {
    const vps = (): VirtualPath[] => [{ userId: 1, virtualPath: '/', localPath: root } as VirtualPath];

    it('resolves paths inside the folder', () => {
      expect(resolveUserPath(vps(), '/docs/ok.txt')?.localPath).toBe(path.join(root, 'docs', 'ok.txt'));
      expect(resolveUserPath(vps(), '/docs-link/ok.txt')).not.toBeNull();
    });

    it('refuses paths that a symlink leads out of the folder (portal, share links, web API)', () => {
      expect(resolveUserPath(vps(), '/escape/secret.txt')).toBeNull();
      expect(resolveUserPath(vps(), '/escape')).toBeNull();
      expect(resolveUserPath(vps(), '/secret.txt')).toBeNull();
      expect(resolveUserPath(vps(), '/dangling.txt')).toBeNull();
    });
  });

  describe('over SFTP and FTP', () => {
    const SFTP_PORT = 22231;
    const FTP_PORT = 21231;
    let db: DatabaseManager;
    let sftp: SFTPServer;
    let ftp: FTPServer;

    beforeAll(async () => {
      db = new DatabaseManager(path.join(base, 'test.db'));
      await db.init();
      db.createUser({ username: 'linker', password: 'linkpass', passwordEnabled: true, publicKey: '', guiEnabled: false });
      const user = db.getUser('linker')!;
      db.addVirtualPath({
        userId: user.id!, virtualPath: '/', localPath: root,
        canRead: true, canWrite: true, canAppend: true, canDelete: true, canList: true,
        canCreateDir: true, canRename: true, applyToSubdirs: true,
      } as any);
      for (const [protocol, port] of [['SFTP', SFTP_PORT], ['FTP', FTP_PORT]] as const) {
        const id = db.createListener({ name: protocol, protocol, bindingIp: '127.0.0.1', port, enabled: true });
        db.subscribeUserToListener(user.id!, id);
        db.setPermission({
          userId: user.id!, listenerId: id, canRead: true, canCreate: true, canEdit: true, canAppend: true,
          canDelete: true, canList: true, canCreateDir: true, canRename: true,
        });
      }
      const listeners = db.getAllListeners();
      sftp = new SFTPServer(listeners.find(l => l.protocol === 'SFTP')!, db);
      ftp = new FTPServer(listeners.find(l => l.protocol === 'FTP')!, db);
      await sftp.start();
      await ftp.start();
    });

    afterAll(async () => {
      await Promise.allSettled([sftp?.stop(), ftp?.stop()]);
      db?.close();
    });

    it('SFTP: files inside stay reachable, links out are refused', async () => {
      const client = new SftpClient();
      await client.connect({ host: '127.0.0.1', port: SFTP_PORT, username: 'linker', password: 'linkpass' });
      try {
        expect((await client.get('/docs/ok.txt')).toString()).toBe('inside');
        await expect(client.get('/escape/secret.txt')).rejects.toThrow();
        await expect(client.get('/secret.txt')).rejects.toThrow();
        await expect(client.list('/escape')).rejects.toThrow();
        await expect(client.put(Buffer.from('x'), '/escape/planted.txt')).rejects.toThrow();
        await expect(client.put(Buffer.from('x'), '/dangling.txt')).rejects.toThrow();
        await expect(client.mkdir('/escape/sub')).rejects.toThrow();
      } finally {
        await client.end();
      }
      expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'sub'))).toBe(false);
    });

    it('FTP: files inside stay reachable, links out are refused', async () => {
      const client = new FtpClient(10000);
      await client.access({ host: '127.0.0.1', port: FTP_PORT, user: 'linker', password: 'linkpass' });
      const chunks: Buffer[] = [];
      const sink = new (require('stream').Writable)({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(c); cb(); } });
      try {
        await client.downloadTo(sink, '/docs/ok.txt');
        expect(Buffer.concat(chunks).toString()).toBe('inside');
        await expect(client.downloadTo(new (require('stream').PassThrough)(), '/escape/secret.txt')).rejects.toThrow();
        await expect(client.downloadTo(new (require('stream').PassThrough)(), '/secret.txt')).rejects.toThrow();
        await expect(client.uploadFrom(require('stream').Readable.from(['x']), '/escape/planted.txt')).rejects.toThrow();
        await expect(client.uploadFrom(require('stream').Readable.from(['x']), '/dangling.txt')).rejects.toThrow();
      } finally {
        client.close();
      }
      expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
    });
  });
});
