/**
 * In-process hold store. Mutex only for now. Portable: no `node:*`, no timers.
 * Waiters wake in the order they began to wait, so contended work runs FIFO.
 */
import type { AcquireRequest, Grant, Guarantees, Key, ReleaseOutcome, Store } from './types.js';

const guarantees = {
  kind: 'hold',
  scope: 'process',
  wait: 'wake',
  shared: false,
  permits: false,
  fence: 'process',
  releasedOnCrash: 'immediate',
  clock: 'none',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno', 'browser', 'hermes'],
} as const satisfies Guarantees;

export type MemoryGuarantees = typeof guarantees;

/** What `peek` shows about a held key. A copy: changing it changes nothing. */
export type MemoryEntry = {
  readonly owner: string;
  readonly fence: bigint;
  readonly expiresAt?: number;
  readonly mode?: 'read' | 'write';
  readonly permits?: number;
};

export type MemoryStore = Store<MemoryGuarantees> & {
  /** Resolves when the key is released, or when `signal` aborts. */
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
  /** The current holder of `key`, if any. For tests and debugging. */
  peek(key: Key): MemoryEntry | undefined;
};

type Waiter = () => void;

export function memoryStore(): MemoryStore {
  const held = new Map<string, MemoryEntry>();
  const waiters = new Map<string, Waiter[]>();
  let lastFence = 0n;

  function wakeAll(fullKey: string): void {
    const queue = waiters.get(fullKey);
    if (queue === undefined) return;
    waiters.delete(fullKey);
    for (const wake of queue) wake();
  }

  return {
    name: 'memory',
    guarantees,
    acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      let grant: Grant | undefined;
      if (!held.has(key.full)) {
        lastFence += 1n;
        held.set(key.full, { owner: req.token, fence: lastFence });
        grant = { key, token: req.token, fence: lastFence };
      }
      return Promise.resolve(grant);
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      if (held.get(grant.key.full)?.owner !== grant.token) return Promise.resolve('not-owner');
      held.delete(grant.key.full);
      wakeAll(grant.key.full);
      return Promise.resolve('released');
    },
    waitFor(key: Key, signal: AbortSignal): Promise<void> {
      if (!held.has(key.full) || signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const queue = waiters.get(key.full) ?? [];
        const wake = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const index = queue.indexOf(wake);
          if (index !== -1) queue.splice(index, 1);
          resolve();
        };
        queue.push(wake);
        waiters.set(key.full, queue);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    peek(key: Key): MemoryEntry | undefined {
      const entry = held.get(key.full);
      return entry === undefined ? undefined : { ...entry };
    },
  };
}
