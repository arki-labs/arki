/** TCP helpers for `dot dev`: is a port open, and wait until it is. */
import net from 'node:net';

/** Is `host:port` accepting connections within `timeoutMs`? Injectable in tests. */
export type Probe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** One TCP connect attempt; any error or the timeout counts as closed. */
export const probeTcp: Probe = (host, port, timeoutMs) =>
  new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });

/** The loopback addresses a local server may bind: Vite binds `localhost`, which can be either. */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

/** The loopback address that accepts connections on `port`, or null. */
export async function openLoopbackHost(port: number, probe: Probe = probeTcp): Promise<string | null> {
  for (const host of LOOPBACK_HOSTS) {
    if (await probe(host, port, 1000)) return host;
  }
  return null;
}

/** Resolves after `ms`, or early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Call `check` every `intervalMs` until it is true, `timeoutMs` passes or
 * `signal` aborts. Resolves to the last result.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  options: { readonly intervalMs: number; readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (options.signal?.aborted === true || Date.now() >= deadline) return false;
    await sleep(options.intervalMs, options.signal);
  }
}
