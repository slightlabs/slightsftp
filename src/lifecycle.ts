/**
 * Process lifecycle for the headless server: graceful shutdown on SIGTERM /
 * SIGINT (what `docker stop`, systemd and Ctrl+C send) and last-resort
 * handlers for errors nothing else caught.
 */

export interface Log {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

/** A shutdown step; graceMs is how long listeners may let transfers finish. */
export type ShutdownStep = [name: string, run: (graceMs: number) => Promise<unknown> | unknown];

export interface ShutdownOptions {
  graceMs: number;
  /** after this, exit even if a step hangs (default graceMs + 5 s) */
  hardTimeoutMs?: number;
  log: Log;
  exit?: (code: number) => void;
}

/**
 * Default grace period for transfers in progress: 5 s, so that with the
 * clean-up after it a stop fits inside Docker's default 10 s timeout.
 * SHUTDOWN_GRACE_MS overrides it (raise the container's stop_grace_period
 * along with it).
 */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SHUTDOWN_GRACE_MS);
  return env.SHUTDOWN_GRACE_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : 5000;
}

/**
 * Returns shutdown(reason, exitCode): runs the steps in order (a failing step
 * is logged and the rest still run), then exits. A second call while it runs
 * exits immediately, like pressing Ctrl+C twice.
 */
export function createShutdown(steps: ShutdownStep[], options: ShutdownOptions): (reason: string, exitCode?: number) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const hardTimeoutMs = options.hardTimeoutMs ?? options.graceMs + 5000;
  let running: Promise<void> | null = null;

  return (reason: string, exitCode = 0) => {
    if (running) {
      options.log.warn(`Stop requested again (${reason}): exiting now`);
      exit(1);
      return running;
    }
    options.log.info(`Shutting down (${reason})...`);
    const hard = setTimeout(() => {
      options.log.error(`Shutdown did not finish within ${Math.round(hardTimeoutMs / 1000)}s: exiting`);
      exit(1);
    }, hardTimeoutMs);
    hard.unref?.();

    running = (async () => {
      for (const [name, run] of steps) {
        try {
          await run(options.graceMs);
        } catch (err) {
          options.log.error(`Shutdown step "${name}" failed:`, err);
        }
      }
      clearTimeout(hard);
      exit(exitCode);
    })();
    return running;
  };
}

/**
 * SIGTERM / SIGINT shut down gracefully. An uncaught exception leaves the
 * process in an unknown state, so it shuts down with exit code 1 (the
 * container / service manager restarts it); an unhandled promise rejection
 * is logged and the server keeps running.
 */
export function installProcessHandlers(
  shutdown: (reason: string, exitCode?: number) => unknown,
  log: Log,
  proc: Pick<NodeJS.Process, 'on'> = process,
): void {
  proc.on('SIGTERM', () => { shutdown('SIGTERM'); });
  proc.on('SIGINT', () => { shutdown('SIGINT'); });
  proc.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception, shutting down:', err);
    shutdown('uncaught exception', 1);
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection:', reason);
  });
}
