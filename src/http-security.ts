/**
 * HTTP hardening shared by the web admin GUI, the file portal and share links:
 * trusted reverse proxies (so brute-force protection and IP allow-lists see
 * the real client address), security headers, and refusing cross-site
 * state-changing requests.
 */
import type { NextFunction, Request, Response } from 'express';
import type * as http from 'http';
import proxyaddr from 'proxy-addr';
import { parseCidrList } from './login-guard';

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Validate a trusted-proxy list: addresses / CIDR ranges and the keywords
 * loopback, linklocal, uniquelocal, comma separated. "Trust everyone" is
 * refused: it would let any client fake its address with X-Forwarded-For.
 * Returns the cleaned value ('' = no proxy) or throws.
 */
export function cleanTrustProxy(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text === 'false') return '';
  const entries = text.split(/[\s,;]+/).filter(Boolean);
  const invalid: string[] = [];
  const cleaned: string[] = [];
  for (const entry of entries) {
    if (PROXY_KEYWORDS.has(entry.toLowerCase())) {
      cleaned.push(entry.toLowerCase());
      continue;
    }
    const { entries: ok } = parseCidrList(entry);
    if (ok.length === 1) cleaned.push(entry);
    else invalid.push(entry);
  }
  if (invalid.length) throw new Error(`Invalid proxy address or range: ${invalid.join(', ')} (use addresses, CIDR ranges, loopback, linklocal or uniquelocal)`);
  return cleaned.join(', ');
}

/** Compiled trust function for a cleaned proxy list ('' trusts nobody). */
export function trustFunction(cleaned: string): (addr: string, i: number) => boolean {
  if (!cleaned) return () => false;
  return proxyaddr.compile(cleaned.split(/\s*,\s*/));
}

/** The client address of a raw request (e.g. a WebSocket upgrade) honouring trusted proxies. */
export function clientAddress(req: http.IncomingMessage, trust: (addr: string, i: number) => boolean): string | undefined {
  try {
    return proxyaddr(req, trust);
  } catch {
    return req.socket.remoteAddress;
  }
}

/** Content-Security-Policy for the GUI pages (they use inline scripts and styles, no third-party content). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuse state-changing requests sent by another site's page (CSRF). Browsers
 * send Origin (or at least Referer) on such requests; it must name this host.
 * Requests without either, and API-token requests, are not from a browser
 * session and pass.
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || /^Bearer\s+/i.test(req.headers.authorization || '')) {
    next();
    return;
  }
  const source = req.headers.origin || req.headers.referer;
  if (!source) {
    next();
    return;
  }
  let host: string | null = null;
  try {
    host = source === 'null' ? null : new URL(String(source)).host.toLowerCase();
  } catch {
    host = null;
  }
  const allowed = new Set([String(req.headers.host || '').toLowerCase()]);
  // behind a trusted proxy that rewrites Host, Express exposes the original via req.host
  if ((req as any).host) allowed.add(String((req as any).host).toLowerCase());
  if (host && allowed.has(host)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Cross-site request refused' });
}
