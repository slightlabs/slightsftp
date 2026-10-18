/**
 * Event rules & webhooks: POST a JSON (or Slack / Teams compatible) message when
 * files are uploaded, downloaded or deleted, users sign in, or share links are
 * created / revoked. Optionally filtered by user and path prefix, and signed
 * with HMAC-SHA256.
 */
import * as crypto from 'crypto';
import { DatabaseManager } from './database';
import { ServerActivity, Webhook, WebhookEvent } from './types';
import logger from './logger';

export const WEBHOOK_EVENTS: WebhookEvent[] = ['upload', 'download', 'delete', 'login', 'login_failed', 'share'];

/** Map an activity log entry to a webhook event type (null = not interesting). */
export function classifyActivity(activity: Pick<ServerActivity, 'action' | 'success'>): WebhookEvent | null {
  const action = activity.action || '';
  const word = action.split(/[\s(]/)[0];
  if (/^(UPLOAD|PORTAL_UPLOAD|SHARE_UPLOAD)$/.test(word)) return activity.success ? 'upload' : null;
  if (/^(DOWNLOAD|PORTAL_DOWNLOAD|SHARE_DOWNLOAD)$/.test(word)) return activity.success ? 'download' : null;
  if (/^(REMOVE|RMDIR|DELETE|PORTAL_DELETE)$/.test(word)) return activity.success ? 'delete' : null;
  if (/^(LOGIN_FAILED|PORTAL_LOGIN_FAILED|WEB_LOGIN_FAILED|SHARE_UNLOCK_FAILED|IP_BANNED)$/.test(word)) return 'login_failed';
  if (/^(LOGIN|PORTAL_LOGIN|WEB_LOGIN_SUCCESS|GUI_LOGIN)$/.test(word)) return activity.success ? 'login' : 'login_failed';
  if (/^SHARE_(CREATED|CREATED_UPLOAD|REVOKED)$/.test(word) || word === 'WEB_SHARE_REVOKED') return 'share';
  return null;
}

export function matchesWebhook(hook: Webhook, event: WebhookEvent, activity: ServerActivity): boolean {
  if (!hook.enabled || !hook.events.includes(event)) return false;
  if (hook.usernameFilter && hook.usernameFilter !== activity.username) return false;
  if (hook.pathPrefix) {
    const prefix = hook.pathPrefix.endsWith('/') ? hook.pathPrefix : hook.pathPrefix + '/';
    if (activity.path !== hook.pathPrefix && !String(activity.path).startsWith(prefix)) return false;
  }
  return true;
}

const EVENT_LABELS: Record<WebhookEvent, string> = {
  upload: '⬆️ Upload', download: '⬇️ Download', delete: '🗑️ Delete',
  login: '🔑 Sign-in', login_failed: '⚠️ Failed sign-in', share: '🔗 Share link',
};

export function buildPayload(hook: Webhook, event: WebhookEvent | 'test', activity: ServerActivity): string {
  const data = {
    event,
    username: activity.username,
    action: activity.action,
    path: activity.path,
    bytes: activity.bytes ?? null,
    success: activity.success,
    listenerId: activity.listenerId,
    timestamp: activity.timestamp || new Date().toISOString(),
    server: 'SLightSFTP',
  };
  if (hook.format === 'slack') {
    const label = event === 'test' ? '✅ Test' : EVENT_LABELS[event];
    const size = activity.bytes ? ` (${activity.bytes} bytes)` : '';
    return JSON.stringify({ text: `${label}: *${data.username}* ${data.action} \`${data.path}\`${size}` });
  }
  return JSON.stringify(data);
}

export function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export interface DeliveryResult { ok: boolean; status?: number; error?: string; attempts: number }

export interface DispatcherOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class WebhookDispatcher {
  private unsubscribe: () => void;
  private inflight = new Set<Promise<unknown>>();
  private opts: Required<DispatcherOptions>;

  constructor(private db: DatabaseManager, options: DispatcherOptions = {}) {
    this.opts = { timeoutMs: 5000, retries: 2, retryDelayMs: 1000, ...options };
    this.unsubscribe = db.onActivity(activity => this.handle(activity));
  }

  stop(): void {
    this.unsubscribe();
  }

  /** Wait for deliveries in progress (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private handle(activity: ServerActivity): void {
    const event = classifyActivity(activity);
    if (!event) return;
    for (const hook of this.db.listWebhooks()) {
      if (!matchesWebhook(hook, event, activity)) continue;
      const delivery = this.deliver(hook, event, activity).finally(() => this.inflight.delete(delivery));
      this.inflight.add(delivery);
    }
  }

  /** Send a sample event to check a webhook's URL. */
  test(hook: Webhook, username = 'admin'): Promise<DeliveryResult> {
    return this.deliver(hook, 'test', { listenerId: null, username, action: 'TEST', path: '/', success: true, timestamp: new Date().toISOString() }, 0);
  }

  async deliver(hook: Webhook, event: WebhookEvent | 'test', activity: ServerActivity, retries = this.opts.retries): Promise<DeliveryResult> {
    const body = buildPayload(hook, event, activity);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'SLightSFTP-Webhook',
      'X-SLightSFTP-Event': event,
      'X-SLightSFTP-Delivery': crypto.randomUUID(),
    };
    if (hook.secret) headers['X-SLightSFTP-Signature'] = signPayload(hook.secret, body);

    let result: DeliveryResult = { ok: false, attempts: 0 };
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await fetch(hook.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
        result = { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}`, attempts: attempt };
        // 4xx (other than 429) will not get better by retrying
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break;
      } catch (err: any) {
        result = { ok: false, error: err?.name === 'AbortError' ? `Timed out after ${this.opts.timeoutMs} ms` : String(err?.cause?.code || err?.message || err), attempts: attempt };
      } finally {
        clearTimeout(timer);
      }
      if (attempt <= retries) await new Promise(r => setTimeout(r, this.opts.retryDelayMs * attempt));
    }

    if (hook.id && this.db.getWebhook(hook.id)) {
      this.db.recordWebhookDelivery(hook.id, result.ok ? `OK ${result.status}` : (result.error || 'failed'));
    }
    if (!result.ok) logger.warn(`Webhook "${hook.name}" delivery failed: ${result.error}`);
    return result;
  }
}

/** Validate user input for a webhook; returns cleaned fields or throws. */
export function validateWebhookInput(input: any, partial = false): Partial<Webhook> {
  const out: Partial<Webhook> = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('A name is required');
    out.name = input.name.trim();
  }
  if (!partial || input.url !== undefined) {
    let url: URL;
    try { url = new URL(String(input.url)); } catch { throw new Error('The URL is not valid'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) URLs are supported');
    out.url = url.toString();
  }
  if (!partial || input.events !== undefined) {
    const events = Array.isArray(input.events) ? input.events : String(input.events || '').split(',');
    const clean = events.map((e: string) => String(e).trim()).filter((e: string) => (WEBHOOK_EVENTS as string[]).includes(e));
    if (!clean.length) throw new Error('Choose at least one event');
    out.events = Array.from(new Set(clean)) as WebhookEvent[];
  }
  if (input.format !== undefined) out.format = input.format === 'slack' ? 'slack' : 'json';
  if (input.usernameFilter !== undefined) out.usernameFilter = String(input.usernameFilter || '').trim() || null;
  if (input.pathPrefix !== undefined) {
    const p = String(input.pathPrefix || '').trim();
    out.pathPrefix = p ? (p.startsWith('/') ? p : '/' + p) : null;
  }
  if (input.secret !== undefined) out.secret = String(input.secret || '') || null;
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  return out;
}

/** What clients may see: never the signing secret. */
export function describeWebhook(hook: Webhook) {
  const { secret, ...rest } = hook;
  return { ...rest, hasSecret: !!secret };
}
