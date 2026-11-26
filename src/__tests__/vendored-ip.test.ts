/**
 * vendor/ip replaces the unmaintained `ip` package (GHSA-2p57-rm9w-gvfp)
 * under ftp-srv, which uses only isEqual() to check that FTP data
 * connections come from the same client as the control connection.
 */
import * as path from 'path';

const ftpSrvDir = path.dirname(require.resolve('ftp-srv/package.json'));
const ip = require(require.resolve('ip', { paths: [ftpSrvDir] }));

describe('vendored ip (as ftp-srv resolves it)', () => {
  test('is the vendored replacement, not the advisory-affected package', () => {
    const pkg = require(require.resolve('ip/package.json', { paths: [ftpSrvDir] }));
    expect(pkg.version).toMatch(/-slightsftp\./);
  });

  test.each([
    ['127.0.0.1', '127.0.0.1', true],
    ['127.0.0.1', '127.0.0.2', false],
    ['127.0.0.1', '::ffff:127.0.0.1', true],   // Node reports IPv4 clients this way on dual-stack sockets
    ['::ffff:127.0.0.1', '127.0.0.1', true],
    ['::ffff:c000:201', '192.0.2.1', true],
    ['10.0.0.1', '::10.0.0.1', true],          // IPv4-compatible form, as in the original
    ['10.0.0.1', '1::10.0.0.1', false],
    ['10.0.0.1', '::fffe:10.0.0.1', false],
    ['::1', '0:0:0:0:0:0:0:1', true],
    ['::1', '::2', false],
    ['2001:db8::1', '2001:0DB8:0:0:0:0:0:1', true],
    ['fe80::1%eth0', 'fe80::1', true],
    ['2001:db8::', '2001:db8::0', true],
  ])('isEqual(%s, %s) is %s', (a, b, expected) => {
    expect(ip.isEqual(a, b)).toBe(expected);
  });

  test('malformed addresses throw instead of being half-parsed', () => {
    expect(() => ip.isEqual('not-an-ip', '127.0.0.1')).toThrow('Invalid ip address');
    expect(() => ip.isEqual('127.0.0.1', '1.2.3')).toThrow('Invalid ip address');
  });
});
