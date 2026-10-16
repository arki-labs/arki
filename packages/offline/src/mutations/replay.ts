/**
 * Replay loop — drains the mutation queue on reconnect.
 *
 * Listens to navigator.onLine events and replays queued mutations
 * in FIFO order with idempotency keys. Handles 401 (auth halt),
 * 4xx (dead-letter), and 5xx / network errors (backoff + retry).
 *
 * Each entry is sent only while the actor it was queued under is signed in.
 * Nobody signed in: the pass stops and emits `auth-required`, entries stay.
 * Another actor signed in: the entry is dead-lettered unsent (`ACTOR_MISMATCH`).
 */
import { sleep } from '@arki/async';

import type { QueueStorage } from './storage.ts';
import type { DeadLetterStore } from './dead-letter.ts';
import type { AnyRpcClient, QueuedMutation, QueueEvent } from './queue.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayLoopOptions {
  storage: QueueStorage;
  dlStore: DeadLetterStore;
  rpc: AnyRpcClient;
  /** Who is signed in now (`null`: nobody; `undefined`: not known yet). Read right before every send attempt. */
  actorId: () => string | null | undefined;
  maxRetries: number;
  backoff: (attempt: number) => number;
  onDeadLetter?: (entry: QueuedMutation, error: Error) => void;
  onStateChange: (sending: boolean) => void;
  emit: (event: QueueEvent) => void;
}

export interface ReplayLoop {
  start(): void;
  stop(): void;
  drainNow(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHttpStatus(error: unknown): number | null {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const s = (error as Record<string, unknown>)['status'];
    if (typeof s === 'number') return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReplayLoop(options: ReplayLoopOptions): ReplayLoop {
  const { storage, dlStore, rpc, actorId, maxRetries, backoff, onDeadLetter, onStateChange, emit } =
    options;

  let draining = false;
  let halted = false; // auth-required state
  let drainPromise: Promise<void> | null = null;

  /**
   * Try sending one mutation. Returns:
   * - 'sent'        — success; remove from queue
   * - 'dead-letter' — 4xx non-auth; move to dead-letter
   * - 'retry'       — 5xx / network error; increment attempts, backoff, retry
   * - 'halt'        — 401; stop loop without dead-lettering
   */
  async function trySend(
    entry: QueuedMutation,
  ): Promise<'sent' | 'dead-letter' | 'retry' | 'halt'> {
    try {
      await rpc.call(entry.procedurePath, entry.input, {
        'Idempotency-Key': entry.idempotencyKey,
      });
      return 'sent';
    } catch (error) {
      const status = getHttpStatus(error);

      if (status === 401) {
        return 'halt';
      }

      if (status !== null && status >= 400 && status < 500) {
        // 4xx non-auth — dead-letter immediately
        return 'dead-letter';
      }

      // 5xx or network error
      return 'retry';
    }
  }

  /** Remove an entry from the queue and park it in the dead-letter store. */
  async function deadLetter(entry: QueuedMutation, error: Error): Promise<void> {
    const after = await storage.read();
    await storage.write(after.filter((m) => m.id !== entry.id));
    await dlStore.add(entry, error);
    emit({ type: 'dead-letter', entry, error });
    onDeadLetter?.(entry, error);
  }

  /**
   * Send one entry with retries and backoff.
   * Returns true if the entry was processed (sent or dead-lettered),
   * false if the loop should halt (401).
   */
  async function processEntry(entry: QueuedMutation): Promise<boolean> {
    let current = entry;

    while (true) {
      // The request carries the session signed in at this moment, not the one
      // that queued the write. Read it right before every attempt (a retry
      // backoff can span an account switch) and never send under another actor.
      const signedIn = actorId();
      if (current.actorId !== signedIn) {
        if (signedIn === null || signedIn === undefined) {
          // Signed out or not known yet: wait for a sign-in; `drain()` after it resumes.
          emit({ type: 'auth-required' });
          return false;
        }
        const message = 'Queued under another account; not sent under the account signed in now';
        await deadLetter({ ...current, lastError: { code: 'ACTOR_MISMATCH', message } }, new Error(message));
        return true;
      }

      const result = await trySend(current);

      if (result === 'sent') {
        const after = await storage.read();
        await storage.write(after.filter((m) => m.id !== entry.id));
        emit({ type: 'sent', entry: current });
        return true;
      }

      if (result === 'halt') {
        halted = true;
        emit({ type: 'auth-required' });
        return false;
      }

      if (result === 'dead-letter') {
        await deadLetter(current, new Error('Request failed with 4xx status'));
        return true;
      }

      // result === 'retry'
      const nextAttempts = current.attempts + 1;

      if (nextAttempts > maxRetries) {
        // Exhausted — dead-letter
        const finalError = new Error('Max retries exceeded');
        const updated: QueuedMutation = {
          ...current,
          attempts: nextAttempts,
          lastError: { code: 'MAX_RETRIES', message: finalError.message },
        };
        await deadLetter(updated, finalError);
        return true;
      }

      // Update attempts in storage before sleeping
      current = {
        ...current,
        attempts: nextAttempts,
        lastError: { code: 'RETRY', message: 'Transient failure, retrying' },
      };
      await updateEntry(current);

      const delay = backoff(nextAttempts);
      await sleep(delay);
    }
  }

  async function drain(): Promise<void> {
    if (draining || halted) return;
    draining = true;
    onStateChange(true);

    try {
      // Process entries one at a time in FIFO order.
      // Re-read the head of the queue before each entry so late-enqueuers
      // are included in the same drain pass.
      const entries = await storage.read();

      for (const snapshot of entries) {
        if (halted) break;

        // Verify the entry is still present (could be removed by a parallel caller)
        const current = await storage.read();
        const live = current.find((m) => m.id === snapshot.id);
        if (!live) continue;

        const shouldContinue = await processEntry(live);
        if (!shouldContinue) break;
      }
    } finally {
      draining = false;
      onStateChange(false);
    }
  }

  async function updateEntry(updated: QueuedMutation): Promise<void> {
    const current = await storage.read();
    await storage.write(current.map((m) => (m.id === updated.id ? updated : m)));
  }

  // Serialise concurrent drain calls — only one drain runs at a time.
  function scheduleDrain(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = drain().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  function handleOnline(): void {
    halted = false; // reset auth halt on re-connect
    emit({ type: 'online' });
    void scheduleDrain();
  }

  function handleOffline(): void {
    emit({ type: 'offline' });
  }

  return {
    start(): void {
      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
      }
    },

    stop(): void {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    },

    drainNow(): Promise<void> {
      return scheduleDrain();
    },
  };
}
