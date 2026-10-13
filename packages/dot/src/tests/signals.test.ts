/**
 * Tests for `hookSignals` — signal-driven graceful shutdown.
 *
 * All tests drive a fake `SignalTarget` so no real signals touch the test
 * runner. The contract under test: first signal drains and re-raises;
 * handlers are gone after the first signal (second signal falls through to
 * runtime defaults); the drain is bounded by `timeoutMs`; `unhook()`
 * detaches without disposing.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SignalTarget } from '../signals.js';
import { hookSignals } from '../signals.js';

type FakeProc = SignalTarget & {
  readonly killed: readonly [number, string | undefined][];
  emit(event: string): boolean;
  listenerCount(event: string): number;
};

/** Minimal `once`-semantics emitter standing in for `process`. */
function makeFakeProc(): FakeProc {
  const listeners = new Map<string, Set<() => void>>();
  const killed: [number, string | undefined][] = [];
  return {
    pid: 42,
    killed,
    once(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as () => void);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as () => void);
      return this;
    },
    kill(pid, signal) {
      killed.push([pid, signal]);
      return true;
    },
    emit(event) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return false;
      const current = [...set];
      set.clear(); // `once` semantics
      for (const listener of current) listener();
      return true;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('hookSignals', () => {
  it('first signal disposes the app, then re-raises the same signal', async () => {
    const proc = makeFakeProc();
    const dispose = vi.fn(() => Promise.resolve());
    hookSignals({ name: 'app', dispose }, { proc });

    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);

    proc.emit('SIGTERM');
    await flush();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(proc.killed).toEqual([[42, 'SIGTERM']]);
    // All handlers removed on the first signal — a second one falls through.
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  it('a slow dispose is bounded by timeoutMs — the process still terminates', async () => {
    const proc = makeFakeProc();
    const never = new Promise<void>(() => {
      /* never settles */
    });
    hookSignals({ name: 'app', dispose: () => never }, { proc, timeoutMs: 20 });

    proc.emit('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(proc.killed).toEqual([[42, 'SIGTERM']]);
  });

  it('a failing dispose still terminates', async () => {
    const proc = makeFakeProc();
    hookSignals(
      { name: 'app', dispose: () => Promise.reject(new Error('boom')) },
      { proc, signals: ['SIGINT'] },
    );

    proc.emit('SIGINT');
    await flush();

    expect(proc.killed).toEqual([[42, 'SIGINT']]);
  });

  it('unhook() detaches without disposing', async () => {
    const proc = makeFakeProc();
    const dispose = vi.fn(() => Promise.resolve());
    const unhook = hookSignals({ name: 'app', dispose }, { proc });

    unhook();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.emit('SIGTERM')).toBe(false);
    await flush();
    expect(dispose).not.toHaveBeenCalled();
    expect(proc.killed).toEqual([]);
  });
});
