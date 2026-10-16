/**
 * OfflineMutationQueue — the central write-path primitive.
 *
 * Persists queued mutations to IDB and replays them on reconnect.
 * The queue itself is network-agnostic; the replay loop (replay.ts)
 * drives network I/O and event listener wiring.
 */
import { nanoid } from 'nanoid';

import type { Identified, InputOf, Operation } from '@arki/contracts/orpc';
import { operationOf } from '@arki/contracts/orpc';

import type { OfflineSafeMeta } from '../orpc/offline-safe-marker.ts';

import { createLastActorStore, createQueueStorage } from './storage.ts';
import type { LastActorStore, QueueStorage } from './storage.ts';
import { createDeadLetterStore } from './dead-letter.ts';
import type { DeadLetterStore } from './dead-letter.ts';
import { createReplayLoop } from './replay.ts';
import type { ReplayLoop } from './replay.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueuedMutation {
  id: string;
  idempotencyKey: string;
  procedurePath: readonly string[];
  input: unknown;
  /**
   * Who was signed in when the call was queued (`actorId()` at enqueue). When
   * the session was unknown (`null`), the last actor signed in on this device;
   * `null` only when there was none. Replay sends the call only while this same actor
   * is signed in, so a queued write never runs under another account.
   */
  actorId: string | null;
  enqueuedAt: number;
  attempts: number;
  lastError?: { code: QueueErrorCode; message: string };
}

/**
 * Why a mutation last failed. `ACTOR_MISMATCH`: another account was signed in
 * at replay, so the call was dead-lettered unsent.
 */
export type QueueErrorCode = 'RETRY' | 'MAX_RETRIES' | 'ACTOR_MISMATCH';

export type QueueEvent =
  | { type: 'enqueued'; entry: QueuedMutation }
  | { type: 'sent'; entry: QueuedMutation }
  | { type: 'dead-letter'; entry: QueuedMutation; error: Error }
  | { type: 'auth-required' }
  | { type: 'online' }
  | { type: 'offline' };

/**
 * Structural RPC client interface. Apps adapt their oRPC client to this shape.
 * @arki/offline never imports oRPC directly.
 */
export interface AnyRpcClient {
  call(
    procedurePath: readonly string[],
    input: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown>;
}

export interface OfflineMutationQueueOptions {
  storageKey?: string;
  deadLetterStorageKey?: string;
  rpc: AnyRpcClient;
  /**
   * Who is signed in right now: their id, `null` when the session says nobody
   * is (signed out), or `undefined` while the session is not known yet (an
   * offline reload). Read at enqueue (the entry is bound to it) and right
   * before every send attempt. An id is remembered on the device as its last
   * actor; `null` forgets it; only `undefined` falls back to it. It must
   * answer synchronously from local state: it runs offline.
   */
  actorId: () => string | null | undefined;
  maxRetries?: number;
  backoff?: (attempt: number) => number;
  onDeadLetter?: (entry: QueuedMutation, error: Error) => void;
}

/** An operation whose contract meta says `offlineSafe: true` (see `offlineSafe(p)` in `@arki/offline/orpc`). */
export type OfflineSafeOperation = Operation<unknown, unknown, unknown, OfflineSafeMeta>;

export interface OfflineMutationQueue {
  /**
   * Queue a call to an offline-safe procedure. `carrier` is its utils leaf
   * (`orpc.posts.create` from `createOrpcUtils`): it carries the procedure's
   * path, and the compiler accepts it only when the contract marked it
   * `offlineSafe`. The input is serialisable; the replay loop sends it back
   * through `rpc.call(path, input, headers)`.
   */
  enqueue<Op extends OfflineSafeOperation>(
    carrier: Identified<Op>,
    input: InputOf<Op>,
  ): Promise<{ idempotencyKey: string; status: 'queued' | 'sent' }>;

  status(): { queued: number; sending: boolean; deadLettered: number };

  drain(): Promise<void>;

  deadLetter: {
    list(): Promise<readonly QueuedMutation[]>;
    retry(id: string): Promise<void>;
    discard(id: string): Promise<void>;
  };

  subscribe(listener: (event: QueueEvent) => void): () => void;

  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal state — not exported
// ---------------------------------------------------------------------------

interface QueueState {
  sending: boolean;
  queuedCount: number;
  deadLetteredCount: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOfflineMutationQueue(
  options: OfflineMutationQueueOptions,
): OfflineMutationQueue {
  const {
    storageKey = 'arki-offline-mutations',
    deadLetterStorageKey = 'arki-offline-mutations-dead',
    rpc,
    actorId,
    maxRetries = 5,
    backoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** attempt),
    onDeadLetter,
  } = options;

  const storage: QueueStorage = createQueueStorage(storageKey);
  const lastActor: LastActorStore = createLastActorStore(`${storageKey}:last-actor`);

  /** Who is signed in now. An id is remembered as this device's last actor; a sign-out forgets it. */
  function signedInActor(): string | null | undefined {
    const id = actorId();
    if (typeof id === 'string') void lastActor.remember(id);
    else if (id === null) void lastActor.forget();
    return id;
  }
  const dlStore: DeadLetterStore = createDeadLetterStore(deadLetterStorageKey);

  const listeners = new Set<(event: QueueEvent) => void>();
  const state: QueueState = { sending: false, queuedCount: 0, deadLetteredCount: 0 };

  // IDB access is browser-only. The factory may be evaluated during SSR
  // (e.g. when an app constructs the runtime at module top level) — in that
  // case the resulting queue is a transient stub that no caller ever uses
  // before the request ends, so skipping the bootstrap reads is safe.
  const isBrowser = typeof window !== 'undefined';

  // Sync counts on startup (fire-and-forget; acceptable startup race)
  if (isBrowser) {
    void storage.read().then((items) => {
      state.queuedCount = items.length;
    });
    void dlStore.list().then((items) => {
      state.deadLetteredCount = items.length;
    });
  }

  // Keep dead-letter count in sync whenever the dead-letter store changes.
  // The subscribe callback only fires after `dlStore.add` succeeded, so by
  // definition IDB was reachable — no `isBrowser` guard needed here.
  const unsubscribeDL = dlStore.subscribe(() => {
    void dlStore.list().then((items) => {
      state.deadLetteredCount = items.length;
    });
  });

  function emit(event: QueueEvent): void {
    // Update queued count based on observable events
    if (event.type === 'enqueued') state.queuedCount++;
    if (event.type === 'sent') state.queuedCount = Math.max(0, state.queuedCount - 1);
    if (event.type === 'dead-letter') state.queuedCount = Math.max(0, state.queuedCount - 1);

    for (const listener of listeners) {
      listener(event);
    }
  }

  // -------------------------------------------------------------------------
  // Replay loop (wires navigator.onLine events)
  // -------------------------------------------------------------------------

  const loop: ReplayLoop = createReplayLoop({
    storage,
    dlStore,
    rpc,
    actorId: signedInActor,
    maxRetries,
    backoff,
    onDeadLetter,
    onStateChange: (sending: boolean) => {
      state.sending = sending;
    },
    emit,
  });

  loop.start();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function enqueue<Op extends OfflineSafeOperation>(
    carrier: Identified<Op>,
    input: InputOf<Op>,
  ): Promise<{ idempotencyKey: string; status: 'queued' | 'sent' }> {
    // Checked at run time too: plain JavaScript callers and forged objects get no compiler.
    const op = operationOf(carrier);
    const marked: unknown = op.meta.offlineSafe;
    if (marked !== true) {
      throw new TypeError(`${op.name} is not marked offlineSafe on its contract, so it cannot be queued offline.`);
    }
    const id = nanoid();
    // Session unknown (e.g. an offline reload): bind to this device's last
    // actor. Replay still sends it only while that same actor is signed in.
    // Signed out (`null`) binds to nobody, so no account can ever replay it.
    const now = signedInActor();
    const bound = now === undefined ? await lastActor.read() : now;
    const entry: QueuedMutation = {
      id,
      idempotencyKey: id,
      procedurePath: op.path,
      input,
      actorId: bound,
      enqueuedAt: Date.now(),
      attempts: 0,
    };

    const current = await storage.read();
    await storage.write([...current, entry]);
    emit({ type: 'enqueued', entry });

    // Opportunistically drain if we are online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        await loop.drainNow();
        // After drain, check if this entry was sent (it won't be in storage)
        const remaining = await storage.read();
        const stillQueued = remaining.some((m) => m.id === id);
        return { idempotencyKey: id, status: stillQueued ? 'queued' : 'sent' };
      } catch {
        // Drain failed — entry stays in queue
        return { idempotencyKey: id, status: 'queued' };
      }
    }

    return { idempotencyKey: id, status: 'queued' };
  }

  function status(): { queued: number; sending: boolean; deadLettered: number } {
    // Returns an in-memory snapshot. Bootstrapped from IDB on startup,
    // then kept live via event tracking in emit().
    // The hooks use subscribe() + useSyncExternalStore for reactive updates.
    return {
      queued: state.queuedCount,
      sending: state.sending,
      deadLettered: state.deadLetteredCount,
    };
  }

  async function drain(): Promise<void> {
    return loop.drainNow();
  }

  const deadLetterApi = {
    list(): Promise<readonly QueuedMutation[]> {
      return dlStore.list();
    },

    async retry(id: string): Promise<void> {
      const items = await dlStore.list();
      const mutation = items.find((m) => m.id === id);
      if (!mutation) return;

      // Reset attempts, re-enqueue, remove from dead-letter. The entry keeps
      // its actorId: a retry never rebinds a write to whoever is signed in now.
      const reset: QueuedMutation = { ...mutation, attempts: 0, lastError: undefined };
      const current = await storage.read();
      await storage.write([...current, reset]);
      await dlStore.remove(id);
      emit({ type: 'enqueued', entry: reset });

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        await loop.drainNow();
      }
    },

    async discard(id: string): Promise<void> {
      await dlStore.remove(id);
    },
  };

  function subscribe(listener: (event: QueueEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    loop.stop();
    unsubscribeDL();
    listeners.clear();
  }

  return {
    enqueue,
    status,
    drain,
    deadLetter: deadLetterApi,
    subscribe,
    dispose,
  };
}
