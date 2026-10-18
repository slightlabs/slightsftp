/**
 * Audit export: forward every activity entry to a syslog server / SIEM as
 * RFC 5424 messages over UDP or TCP (RFC 6587 octet-counting framing).
 */
import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';
import { DatabaseManager } from './database';
import { ServerActivity } from './types';
import logger from './logger';

export interface SyslogSettings {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
  /** syslog facility number; 16 = local0 */
  facility: number;
}

export const SYSLOG_DEFAULTS: SyslogSettings = { enabled: false, host: '', port: 514, protocol: 'udp', facility: 16 };

export function readSyslogSettings(db: DatabaseManager): SyslogSettings {
  const get = (k: string) => db.getSetting(k);
  const port = Number(get('syslogPort'));
  const facility = Number(get('syslogFacility'));
  return {
    enabled: get('syslogEnabled') === 'true',
    host: get('syslogHost') || '',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : SYSLOG_DEFAULTS.port,
    protocol: get('syslogProtocol') === 'tcp' ? 'tcp' : 'udp',
    facility: Number.isInteger(facility) && facility >= 0 && facility <= 23 ? facility : SYSLOG_DEFAULTS.facility,
  };
}

export function saveSyslogSettings(db: DatabaseManager, input: Partial<SyslogSettings>): void {
  if (input.port !== undefined && (!Number.isInteger(Number(input.port)) || Number(input.port) < 1 || Number(input.port) > 65535)) {
    throw new Error('Port must be between 1 and 65535');
  }
  if (input.facility !== undefined && (!Number.isInteger(Number(input.facility)) || Number(input.facility) < 0 || Number(input.facility) > 23)) {
    throw new Error('Facility must be between 0 and 23');
  }
  if (input.protocol !== undefined && input.protocol !== 'udp' && input.protocol !== 'tcp') throw new Error('Protocol must be udp or tcp');
  if (input.enabled && !(input.host ?? readSyslogSettings(db).host)) throw new Error('A syslog host is required');
  if (input.host !== undefined) db.setSetting('syslogHost', String(input.host).trim());
  if (input.port !== undefined) db.setSetting('syslogPort', String(Number(input.port)));
  if (input.protocol !== undefined) db.setSetting('syslogProtocol', input.protocol);
  if (input.facility !== undefined) db.setSetting('syslogFacility', String(Number(input.facility)));
  if (input.enabled !== undefined) db.setSetting('syslogEnabled', input.enabled ? 'true' : 'false');
}

/** Escape a structured-data parameter value (RFC 5424 §6.3.3). */
const sdValue = (v: unknown) => String(v ?? '').replace(/[\\"\]]/g, m => '\\' + m);

/** Build one RFC 5424 message for an activity entry. */
export function formatSyslog(activity: ServerActivity, facility = 16, hostname = os.hostname()): string {
  const severity = activity.success ? 6 : 4; // informational / warning
  const pri = facility * 8 + severity;
  const timestamp = activity.timestamp ? new Date(activity.timestamp.includes('T') ? activity.timestamp : activity.timestamp.replace(' ', 'T') + 'Z').toISOString() : new Date().toISOString();
  const msgid = (activity.action.split(/[\s(]/)[0] || '-').slice(0, 32);
  const params: Array<[string, unknown]> = [
    ['user', activity.username],
    ['action', activity.action],
    ['path', activity.path],
    ['success', activity.success ? 'true' : 'false'],
  ];
  if (activity.listenerId !== null && activity.listenerId !== undefined) params.push(['listener', activity.listenerId]);
  if (activity.bytes !== null && activity.bytes !== undefined) params.push(['bytes', activity.bytes]);
  if (activity.checksum) params.push(['sha256', activity.checksum]);
  const sd = `[slightsftp@32473 ${params.map(([k, v]) => `${k}="${sdValue(v)}"`).join(' ')}]`;
  const host = (hostname || '-').replace(/\s/g, '').slice(0, 255) || '-';
  return `<${pri}>1 ${timestamp} ${host} SLightSFTP ${process.pid} ${msgid} ${sd} ${activity.username} ${activity.action} ${activity.path}`;
}

export class SyslogForwarder {
  private unsubscribe: () => void;
  private udp: dgram.Socket | null = null;
  private tcp: net.Socket | null = null;
  private tcpReady: Promise<net.Socket> | null = null;
  private pending = new Set<Promise<void>>();

  constructor(private db: DatabaseManager) {
    this.unsubscribe = db.onActivity(activity => this.forward(activity));
  }

  stop(): void {
    this.unsubscribe();
    this.udp?.close();
    this.tcp?.destroy();
    this.udp = null;
    this.tcp = null;
    this.tcpReady = null;
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private forward(activity: ServerActivity): void {
    let settings: SyslogSettings;
    try {
      settings = readSyslogSettings(this.db);
    } catch {
      return;
    }
    if (!settings.enabled || !settings.host) return;
    const p: Promise<void> = this.send(formatSyslog(activity, settings.facility), settings)
      .catch(err => { logger.warn(`Syslog forwarding failed: ${err.message}`); })
      .finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  /** Send one message (also used by the "Send test message" button). */
  send(message: string, settings: SyslogSettings = readSyslogSettings(this.db)): Promise<void> {
    if (!settings.host) return Promise.reject(new Error('No syslog host configured'));
    const data = Buffer.from(message, 'utf8');
    if (settings.protocol === 'udp') {
      if (!this.udp) {
        this.udp = dgram.createSocket(net.isIPv6(settings.host) ? 'udp6' : 'udp4');
        this.udp.on('error', err => logger.warn(`Syslog UDP error: ${err.message}`));
        this.udp.unref();
      }
      return new Promise((resolve, reject) => this.udp!.send(data, settings.port, settings.host, err => (err ? reject(err) : resolve())));
    }
    return this.tcpSocket(settings).then(sock => new Promise<void>((resolve, reject) => {
      sock.write(Buffer.concat([Buffer.from(`${data.length} `), data]), err => (err ? reject(err) : resolve()));
    }));
  }

  private tcpSocket(settings: SyslogSettings): Promise<net.Socket> {
    if (this.tcp && !this.tcp.destroyed && this.tcpReady) return this.tcpReady;
    this.tcpReady = new Promise((resolve, reject) => {
      const sock = net.connect({ host: settings.host, port: settings.port });
      sock.setTimeout(5000, () => sock.destroy(new Error('Syslog TCP connect timed out')));
      sock.once('connect', () => { sock.setTimeout(0); resolve(sock); });
      sock.once('error', err => { this.tcp = null; this.tcpReady = null; reject(err); });
      sock.once('close', () => { this.tcp = null; this.tcpReady = null; });
      sock.unref();
      this.tcp = sock;
    });
    return this.tcpReady;
  }
}
