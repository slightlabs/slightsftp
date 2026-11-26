/**
 * Prometheus metrics (GET /metrics, with an API token) and health checks
 * (GET /healthz, GET /readyz, no sign-in) for monitoring the server.
 *
 * Counters are fed from the activity stream (the same events the activity
 * log, webhooks and syslog see); gauges are read when Prometheus scrapes.
 */
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { getLoginGuard } from './login-guard';
import { classifyActivity } from './webhooks';
import { ServerActivity } from './types';

export interface HealthReport {
  status: 'ok' | 'unavailable';
  checks: { database: boolean; listeners: { enabled: number; running: number } };
}

export class Metrics {
  readonly registry = new Registry();
  private readonly unsubscribe: () => void;
  private readonly logins: Counter<'protocol' | 'result'>;
  private readonly transfers: Counter<'protocol' | 'direction'>;
  private readonly bytes: Counter<'protocol' | 'direction'>;
  private readonly deletes: Counter<'protocol'>;

  constructor(private readonly db: DatabaseManager, private readonly servers: ServerManager, version: string) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry, prefix: 'slightsftp_' });

    new Gauge({ name: 'slightsftp_info', help: 'Build information', labelNames: ['version'], registers }).set({ version }, 1);

    this.logins = new Counter({ name: 'slightsftp_logins_total', help: 'Sign-in attempts by protocol and result', labelNames: ['protocol', 'result'], registers });
    this.transfers = new Counter({ name: 'slightsftp_transfers_total', help: 'Completed file transfers', labelNames: ['protocol', 'direction'], registers });
    this.bytes = new Counter({ name: 'slightsftp_transfer_bytes_total', help: 'Bytes moved by completed transfers', labelNames: ['protocol', 'direction'], registers });
    this.deletes = new Counter({ name: 'slightsftp_deletes_total', help: 'Files and folders deleted', labelNames: ['protocol'], registers });

    const manager = this.servers;
    new Gauge({
      name: 'slightsftp_sessions',
      help: 'Connected SFTP / FTP sessions',
      labelNames: ['protocol'],
      registers,
      collect() {
        this.reset();
        const counts: Record<string, number> = { SFTP: 0, FTP: 0 };
        for (const s of manager.getActiveSessions()) counts[s.protocol] = (counts[s.protocol] || 0) + 1;
        for (const [protocol, n] of Object.entries(counts)) this.set({ protocol }, n);
      },
    });
    new Gauge({
      name: 'slightsftp_transfers_in_progress',
      help: 'Transfers in progress',
      registers,
      collect() {
        this.set(manager.getActiveSessions().reduce((n, s: any) => n + (s.transfers?.length || 0), 0));
      },
    });
    new Gauge({
      name: 'slightsftp_listener_up',
      help: 'Whether an enabled listener is accepting connections (1) or not (0)',
      labelNames: ['listener', 'protocol', 'port'],
      registers,
      collect() {
        this.reset();
        for (const { listener, running } of manager.getAllListenerStatuses()) {
          if (!listener.enabled) continue;
          this.set({ listener: listener.name, protocol: listener.protocol, port: String(listener.port) }, running ? 1 : 0);
        }
      },
    });
    new Gauge({
      name: 'slightsftp_ip_bans',
      help: 'Addresses currently banned by brute-force protection',
      registers,
      collect: () => {
        try {
          (this.registry.getSingleMetric('slightsftp_ip_bans') as Gauge).set(getLoginGuard(this.db).listBans().length);
        } catch { /* database closing */ }
      },
    });

    this.unsubscribe = db.onActivity(activity => this.count(activity));
  }

  /** Where an activity came from: the listener's protocol, or "web" for the GUI, portal and share links. */
  private protocolOf(activity: ServerActivity): string {
    if (activity.listenerId === null || activity.listenerId === undefined) return 'web';
    return this.db.getListener(activity.listenerId)?.protocol || 'unknown';
  }

  private count(activity: ServerActivity): void {
    const event = classifyActivity(activity);
    if (!event) return;
    const protocol = this.protocolOf(activity);
    switch (event) {
      case 'login':
        this.logins.inc({ protocol, result: 'success' });
        break;
      case 'login_failed':
        this.logins.inc({ protocol, result: 'failure' });
        break;
      case 'upload':
      case 'download':
        this.transfers.inc({ protocol, direction: event });
        if (activity.bytes) this.bytes.inc({ protocol, direction: event }, activity.bytes);
        break;
      case 'delete':
        this.deletes.inc({ protocol });
        break;
    }
  }

  /** Liveness and readiness: the database answers, and every enabled listener is running. */
  health(): HealthReport {
    let database = false;
    try {
      this.db.getSetting('logRetentionDays');
      database = true;
    } catch { /* closed or unreadable */ }
    let enabled = 0;
    let running = 0;
    try {
      for (const status of this.servers.getAllListenerStatuses()) {
        if (!status.listener.enabled) continue;
        enabled++;
        if (status.running) running++;
      }
    } catch { /* database unavailable: reported above */ }
    const ok = database && running === enabled;
    return { status: ok ? 'ok' : 'unavailable', checks: { database, listeners: { enabled, running } } };
  }

  stop(): void {
    this.unsubscribe();
  }
}
