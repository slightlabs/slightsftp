/**
 * Live transfer tracking for the dashboard: what each session is moving right
 * now, how fast, and how much it has moved in total.
 */
export type TransferDirection = 'upload' | 'download';

export interface LiveTransfer {
  path: string;
  direction: TransferDirection;
  bytes: number;
  startedAt: string;
  /** average speed since the transfer started, bytes per second */
  bytesPerSecond: number;
}

export interface SessionTransferStats {
  uploadedBytes: number;
  downloadedBytes: number;
  transfers: LiveTransfer[];
}

interface Active { path: string; direction: TransferDirection; bytes: number; started: number }

export interface TransferHandle {
  add(bytes: number): void;
  end(): void;
}

export class TransferTracker {
  private active = new Map<string, Set<Active>>();
  private totals = new Map<string, { up: number; down: number }>();

  start(sessionId: string, path: string, direction: TransferDirection): TransferHandle {
    const entry: Active = { path, direction, bytes: 0, started: Date.now() };
    if (!this.active.has(sessionId)) this.active.set(sessionId, new Set());
    this.active.get(sessionId)!.add(entry);
    let done = false;
    return {
      add: (bytes: number) => {
        if (done || !bytes) return;
        entry.bytes += bytes;
        const t = this.totals.get(sessionId) || { up: 0, down: 0 };
        if (direction === 'upload') t.up += bytes; else t.down += bytes;
        this.totals.set(sessionId, t);
      },
      end: () => {
        if (done) return;
        done = true;
        this.active.get(sessionId)?.delete(entry);
      },
    };
  }

  stats(sessionId: string, now = Date.now()): SessionTransferStats {
    const t = this.totals.get(sessionId) || { up: 0, down: 0 };
    const transfers = Array.from(this.active.get(sessionId) || []).map(a => ({
      path: a.path,
      direction: a.direction,
      bytes: a.bytes,
      startedAt: new Date(a.started).toISOString(),
      bytesPerSecond: Math.round(a.bytes / Math.max((now - a.started) / 1000, 0.001)),
    }));
    return { uploadedBytes: t.up, downloadedBytes: t.down, transfers };
  }

  endSession(sessionId: string): void {
    this.active.delete(sessionId);
    this.totals.delete(sessionId);
  }
}
