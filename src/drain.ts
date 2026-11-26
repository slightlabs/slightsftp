/**
 * Wait until `idle()` is true (checked every 100 ms) or `graceMs` has passed:
 * lets transfers in progress finish before a listener disconnects its clients.
 * Resolves true when idle in time.
 */
export function waitUntilIdle(idle: () => boolean, graceMs: number): Promise<boolean> {
  if (graceMs <= 0 || idle()) return Promise.resolve(idle());
  return new Promise(resolve => {
    const deadline = Date.now() + graceMs;
    const timer = setInterval(() => {
      if (idle()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
    timer.unref?.();
  });
}

/** How long a stopping server waits for clients to hang up before cutting them off. */
export const FORCE_CLOSE_AFTER_MS = 2000;
