'use strict';
/**
 * Drop-in for the parts of the `ip` package that ftp-srv uses: isEqual().
 *
 * `ip` is unmaintained and carries an advisory (GHSA-2p57-rm9w-gvfp, in
 * isPublic(), which ftp-srv never calls). Rather than ship it, package.json
 * overrides `ip` with this file. Addresses are parsed with node:net, so
 * malformed input throws instead of being half-parsed.
 */
const net = require('net');

function v4Bytes(address) {
  return address.split('.').map(Number);
}

/** 4 bytes for IPv4, 16 for IPv6 (a zone index such as %eth0 is ignored). */
function toBytes(address) {
  const text = String(address).trim().replace(/%.*$/, '');
  const family = net.isIP(text);
  if (family === 4) return v4Bytes(text);
  if (family !== 6) throw new Error(`Invalid ip address: ${address}`);

  let head = text;
  let tail = [];
  const lastColon = head.lastIndexOf(':');
  if (head.includes('.', lastColon)) {
    // embedded IPv4 at the end, e.g. ::ffff:192.0.2.1
    const v4 = v4Bytes(head.slice(lastColon + 1));
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = head.slice(0, lastColon + 1) + '0:0';
  }
  const [left, right] = head.includes('::') ? head.split('::') : [head, undefined];
  const parse = (part) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  let words = parse(left);
  if (right !== undefined) {
    const rightWords = parse(right);
    words = words.concat(new Array(8 - words.length - rightWords.length).fill(0), rightWords);
  }
  if (tail.length) words.splice(6, 2, ...tail);
  const bytes = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

/**
 * True when a and b are the same address. An IPv4 address equals its
 * IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) IPv6 forms,
 * as in the original package.
 */
function isEqual(a, b) {
  let x = toBytes(a);
  let y = toBytes(b);
  if (x.length === y.length) return x.every((byte, i) => byte === y[i]);
  if (y.length === 4) [x, y] = [y, x];
  // x: IPv4, y: IPv6
  for (let i = 0; i < 10; i++) if (y[i] !== 0) return false;
  const word = (y[10] << 8) | y[11];
  if (word !== 0 && word !== 0xffff) return false;
  return x.every((byte, i) => byte === y[12 + i]);
}

module.exports = { isEqual, toBuffer: (address) => Buffer.from(toBytes(address)) };
