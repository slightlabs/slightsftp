import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from './logger';

/**
 * Server certificate used by HTTPS (web GUI) and FTPS listeners.
 *
 * By default a self-signed certificate is generated once and stored next to
 * config.db as `server.crt` / `server.key`. Users can supply their own
 * certificate through the `tlsCertPath` / `tlsKeyPath` settings.
 */
export interface ServerCertificate {
  key: string;
  cert: string;
  fingerprint256: string;
  subject: string;
  validTo: string;
  selfSigned: boolean;
}

export const CERT_FILE = 'server.crt';
export const KEY_FILE = 'server.key';

// SLIGHTSFTP_CERT_DIR overrides the default (working directory) for headless setups and tests
let certificateDir = process.env.SLIGHTSFTP_CERT_DIR || process.cwd();
let cached: ServerCertificate | null = null;
let pending: Promise<ServerCertificate> | null = null;

/** Where the generated certificate lives (the app's config directory). */
export function setCertificateDir(dir: string): void {
  certificateDir = dir;
  cached = null;
  pending = null;
}

export function getCertificateDir(): string {
  return certificateDir;
}

function describe(key: string, cert: string, selfSigned: boolean): ServerCertificate {
  const x509 = new crypto.X509Certificate(cert);
  // fail early on a key that does not belong to the certificate
  if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) {
    throw new Error('The TLS private key does not match the certificate');
  }
  return { key, cert, fingerprint256: x509.fingerprint256, subject: x509.subject, validTo: x509.validTo, selfSigned };
}

export async function generateSelfSigned(hostnames: string[] = []): Promise<{ key: string; cert: string }> {
  const selfsigned = require('selfsigned');
  const names = Array.from(new Set(['localhost', os.hostname(), ...hostnames].filter(Boolean)));
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + 825); // max lifetime browsers accept

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'SLightSFTP' }, { name: 'organizationName', value: 'SLightSFTP' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...names.map(value => ({ type: 2, value })),
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

/**
 * Load the configured certificate, or create (once) and reuse a self-signed one.
 * `custom` paths win when both are given.
 */
export async function getServerCertificate(custom?: { certPath?: string; keyPath?: string }): Promise<ServerCertificate> {
  if (custom?.certPath && custom?.keyPath) {
    return describe(fs.readFileSync(custom.keyPath, 'utf8'), fs.readFileSync(custom.certPath, 'utf8'), false);
  }
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const certPath = path.join(certificateDir, CERT_FILE);
    const keyPath = path.join(certificateDir, KEY_FILE);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      cached = describe(fs.readFileSync(keyPath, 'utf8'), fs.readFileSync(certPath, 'utf8'), true);
      return cached;
    }

    const { key, cert } = await generateSelfSigned();
    fs.mkdirSync(certificateDir, { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.writeFileSync(certPath, cert);
    logger.info(`Generated self-signed TLS certificate in ${certificateDir}`);
    cached = describe(key, cert, true);
    return cached;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

export const SSH_HOST_KEY_FILE = 'ssh_host_rsa_key';
const hostKeyCache = new Map<string, Buffer>();

/**
 * The SFTP server's RSA host key, created once in the certificate directory and
 * shared by every SFTP listener so the server identity never changes.
 */
export function loadOrCreateHostKey(dir: string = certificateDir): Buffer {
  const file = path.join(dir, SSH_HOST_KEY_FILE);
  const cachedKey = hostKeyCache.get(file);
  if (cachedKey) return cachedKey;

  let pem: string;
  if (fs.existsSync(file)) {
    pem = fs.readFileSync(file, 'utf8');
  } else {
    pem = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
    }).privateKey;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, pem, { mode: 0o600 });
    logger.info(`Generated SFTP host key ${file}`);
  }

  const key = Buffer.from(pem);
  hostKeyCache.set(file, key);
  return key;
}

/** SHA-256 fingerprint of the host key in OpenSSH notation ("SHA256:..."). */
export function hostKeyFingerprint(dir: string = certificateDir): string {
  const ssh2 = require('ssh2');
  const parsed = ssh2.utils.parseKey(loadOrCreateHostKey(dir));
  const publicSsh: Buffer = parsed.getPublicSSH();
  return 'SHA256:' + crypto.createHash('sha256').update(publicSsh).digest('base64').replace(/=+$/, '');
}
