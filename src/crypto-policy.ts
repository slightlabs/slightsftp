/**
 * Which cryptographic algorithms the listeners offer.
 *
 * SSH (setting sshAlgorithms):
 *   modern      (default) what ssh-audit and Mozilla's OpenSSH guidelines
 *               recommend: no SHA-1 anywhere (no "ssh-rsa" host key
 *               signatures, which OpenSSH itself turned off in 8.8, and no
 *               hmac-sha1), only curve25519 / large-group key exchange,
 *               AEAD or CTR ciphers with encrypt-then-MAC. Every OpenSSH
 *               since 7.2, PuTTY 0.75, WinSCP 5.18 and FileZilla 3.53 qualify.
 *   compatible  the ssh2 library's defaults, adding SHA-1 host key
 *               signatures and MACs and NIST curves for older clients and
 *               embedded devices.
 *
 * TLS for HTTPS and FTPS (setting tlsMinVersion): TLSv1.2 (default, Node's
 * own minimum) or TLSv1.3.
 */
import type { TLSSocket } from 'tls';

export type SshAlgorithmProfile = 'modern' | 'compatible';
export type TlsMinVersion = 'TLSv1.2' | 'TLSv1.3';

interface SettingsReader {
  getSetting(key: string): string | undefined;
}

export const MODERN_SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group-exchange-sha256',
  ],
  serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256'],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
  ],
  hmac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512', 'hmac-sha2-256'],
  compress: ['none', 'zlib@openssh.com', 'zlib'],
};

export function sshAlgorithmProfile(db: SettingsReader): SshAlgorithmProfile {
  return db.getSetting('sshAlgorithms') === 'compatible' ? 'compatible' : 'modern';
}

/** The `algorithms` option for ssh2.Server, or undefined for the library defaults. */
export function sshServerAlgorithms(db: SettingsReader): typeof MODERN_SSH_ALGORITHMS | undefined {
  return sshAlgorithmProfile(db) === 'modern' ? MODERN_SSH_ALGORITHMS : undefined;
}

export function tlsMinVersion(db: SettingsReader): TlsMinVersion {
  return db.getSetting('tlsMinVersion') === 'TLSv1.3' ? 'TLSv1.3' : 'TLSv1.2';
}

/** Options shared by the HTTPS server and FTPS listeners. */
export function tlsServerOptions(db: SettingsReader): { minVersion: TlsMinVersion; honorCipherOrder: true } {
  return { minVersion: tlsMinVersion(db), honorCipherOrder: true };
}

export type { TLSSocket };
