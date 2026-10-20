/**
 * OfflineMutationQueue — the central write-path primitive.
 *
 * Persists queued mutations to IDB and replays them on reconnect.
 * The queue itself is network-agnostic; the replay loop (replay.ts)
 * drives network I/O and event listener wiring.
 */
import { observeEnqueue, observeQueue } from './telemetry.ts';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { mutationIdempotencyKey, queuedMutationId } from './identity.ts';
import type { QueuedMutationId } from './identity.ts';
import type { QueuedMutation, EnqueueReceipt } from './model.ts';
import { QueueAcceptanceUnconfirmed, QueuePersistenceUnconfirmed } from './failures.ts';
import type { EnqueueFailure, DrainFailure, QueueStorageFailure, OfflineQueueFailure } from './failures.ts';

import type { Identified, InputOf, Operation } from '@arki/contracts/orpc';
import { operationOf } from '@arki/contracts/orpc';

import { getLogger } from '@arki/log';

import type { OfflineSafeMeta } from '../orpc/offline-safe-marker.ts';

import { createLastActorStore, createQueueStorage } from './storage.ts';
import type { LastActorStore, QueueStorage } from './storage.ts';
import { createDeadLetterStore } from './dead-letter.ts';
import type { DeadLetterStore } from './dead-letter.ts';
import { createReplayLoop } from './replay.ts';
import type { ReplayLoop } from './replay.ts';

const log = getLogger('arki:offline:mutations');

function reportListenerError(): void {
  // Observer defects cannot replace the operation's reconciliation identity.
  try {
    void Promise.resolve(log.debug('Queue subscriber failed: {code}', { code: UnexpectedDefect.code })).catch(() => {
      // Even an asynchronous logger defect stays outside the operation outcome.
    });
  } catch { /* Reporting cannot revoke acceptance. */ }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { QueuedMutation, QueueErrorCode, EnqueueReceipt } from './model.ts';

export type QueueEvent =
  | { type: 'enqueued'; entry: QueuedMutation }
  | { type: 'sent'; entry: QueuedMutation }
  | { type: 'dead-letter'; entry: QueuedMutation; error: Error }
  | { type: 'failure'; failure: OfflineQueueFailure }
  | { type: 'drained' }
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
  ): Promise<EnqueueReceipt | EnqueueFailure>;

  status(): QueueSnapshot;

  drain(): Promise<void | DrainFailure>;

  deadLetter: {
    list(): Promise<readonly QueuedMutation[] | QueueStorageFailure>;
    retry(id: QueuedMutationId): Promise<void | DrainFailure>;
    discard(id: QueuedMutationId): Promise<void | QueueStorageFailure>;
  };

  subscribe(listener: (event: QueueEvent) => void): () => void;

  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal state — not exported
// ---------------------------------------------------------------------------

export type QueueSnapshot = {
  queued: number;
  sending: boolean;
  deadLettered: number;
  failure: OfflineQueueFailure | null;
};

interface QueueState {
  sending: boolean;
  queuedCount: number;
  deadLetteredCount: number;
  failure: OfflineQueueFailure | null;
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
    if (typeof id === 'string') void lastActor.remember(id).then(reportOutcome);
    else if (id === null) void lastActor.forget().then(reportOutcome);
    return id;
  }
  const dlStore: DeadLetterStore = createDeadLetterStore(deadLetterStorageKey);

  const listeners = new Set<(event: QueueEvent) => void>();
  const state: QueueState = { sending: false, queuedCount: 0, deadLetteredCount: 0, failure: null };

  // IDB access is browser-only. The factory may be evaluated during SSR
  // (e.g. when an app constructs the runtime at module top level) — in that
  // case the resulting queue is a transient stub that no caller ever uses
  // before the request ends, so skipping the bootstrap reads is safe.
  const isBrowser = typeof window !== 'undefined';

  function reportOutcome(result: void | OfflineQueueFailure): void {
    if (isFailure(result)) emit({ type: 'failure', failure: result });
  }

  function reportStorageFailure(error: unknown): void {
    emit({ type: 'failure', failure: UnexpectedDefect({ cause: error }) });
  }

  // Sync counts on startup (fire-and-forget; acceptable startup race)
  if (isBrowser) {
    void storage.read().then((items) => {
      if (isFailure(items)) emit({ type: 'failure', failure: items });
      else state.queuedCount = items.length;
    }).catch(error => reportStorageFailure(error));
    void dlStore.list().then((items) => {
      if (isFailure(items)) emit({ type: 'failure', failure: items });
      else state.deadLetteredCount = items.length;
    }).catch(error => reportStorageFailure(error));
  }

  // Keep dead-letter count in sync whenever the dead-letter store changes.
  // The subscribe callback only fires after `dlStore.add` succeeded, so by
  // definition IDB was reachable — no `isBrowser` guard needed here.
  const unsubscribeDL = dlStore.subscribe(() => {
    void dlStore.list().then((items) => {
      if (isFailure(items)) emit({ type: 'failure', failure: items });
      else state.deadLetteredCount = items.length;
    }).catch(error => reportStorageFailure(error));
  });

  function emit(event: QueueEvent): void {
    if (event.type === 'failure') state.failure = event.failure;
    // Update queued count based on observable events
    if (event.type === 'enqueued') state.queuedCount++;
    if (event.type === 'sent') state.queuedCount = Math.max(0, state.queuedCount - 1);
    if (event.type === 'dead-letter') state.queuedCount = Math.max(0, state.queuedCount - 1);


    for (const listener of listeners) {
      try { void Promise.resolve(listener(event)).catch(reportListenerError); }
      catch { reportListenerError(); }
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
  ): Promise<EnqueueReceipt | EnqueueFailure> {
    // Checked at run time too: plain JavaScript callers and forged objects get no compiler.
    const op = operationOf(carrier);
    const marked: unknown = op.meta.offlineSafe;
    if (marked !== true) {
      throw new TypeError(`${op.name} is not marked offlineSafe on its contract, so it cannot be queued offline.`);
    }
    const id = queuedMutationId.create();
    if (isFailure(id)) return id;
    const idempotencyKey = mutationIdempotencyKey.schema.parse(id);
    const now = signedInActor();
    const bound = now === undefined ? await lastActor.read() : now;
    if (isFailure(bound)) return bound;
    const current = await storage.read();
    if (isFailure(current)) return current;
    const entry: QueuedMutation = {
      id, idempotencyKey, procedurePath: op.path, input, actorId: bound,
      enqueuedAt: Date.now(), attempts: 0,
    };
    const persisted = await storage.write([...current, entry]);
    if (isFailure(persisted)) {
      if (!QueuePersistenceUnconfirmed.is(persisted)) return persisted;
      // IDB can report failure after committing. Preserve the reconciliation identity.
      return QueueAcceptanceUnconfirmed({ id, idempotencyKey }, { cause: persisted });
    }
    emit({ type: 'enqueued', entry });
    let status: EnqueueReceipt['status'] = 'queued';
    const observeOutcome = (event: QueueEvent) => {
      if ((event.type === 'sent' || event.type === 'dead-letter') && event.entry.id === id) status = event.type;
    };
    listeners.add(observeOutcome);
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const drained = await loop.drainNow();
        if (isFailure(drained)) return QueueAcceptanceUnconfirmed({ id, idempotencyKey }, { cause: drained });
      } catch (error) {
        return QueueAcceptanceUnconfirmed({ id, idempotencyKey }, { cause: error });
      } finally {
        listeners.delete(observeOutcome);
      }
    } else {
      listeners.delete(observeOutcome);
    }
    return { idempotencyKey, status };
  }

  function status(): QueueSnapshot {
    // Returns an in-memory snapshot. Bootstrapped from IDB on startup,
    // then kept live via event tracking in emit().
    // The hooks use subscribe() + useSyncExternalStore for reactive updates.
    return {
      queued: state.queuedCount,
      sending: state.sending,
      deadLettered: state.deadLetteredCount,
      failure: state.failure,
    };
  }

  async function drain(): Promise<void | DrainFailure> {
    const result = await loop.drainNow();
    if (isFailure(result)) reportOutcome(result);
    else { state.failure = null; emit({ type: 'drained' }); }
    return result;
  }

  const deadLetterApi = {
    list(): Promise<readonly QueuedMutation[] | QueueStorageFailure> {
      return dlStore.list();
    },

    async retry(id: QueuedMutationId): Promise<void | DrainFailure> {
      const items = await dlStore.list();
      if (isFailure(items)) return items;
      const mutation = items.find((m) => m.id === id);
      if (!mutation) return;

      // Reset attempts, re-enqueue, remove from dead-letter. The entry keeps
      // its actorId: a retry never rebinds a write to whoever is signed in now.
      const reset: QueuedMutation = { ...mutation, attempts: 0, lastError: undefined };
      const current = await storage.read();
      if (isFailure(current)) return current;
      const queued = await storage.write([...current.filter(entry => entry.id !== id), reset]);
      if (isFailure(queued)) return queued;
      const removed = await dlStore.remove(id);
      if (isFailure(removed)) return removed;
      emit({ type: 'enqueued', entry: reset });

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        return drain();
      }
    },

    async discard(id: QueuedMutationId): Promise<void | QueueStorageFailure> {
      return dlStore.remove(id);
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
    async enqueue(carrier, input) {
      // Contract misuse remains a static definition error, before owned execution.
      const op = operationOf(carrier);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JavaScript callers can omit the static offline-safe declaration.
      if (op.meta.offlineSafe !== true) throw new TypeError(`${op.name} is not marked offlineSafe on its contract, so it cannot be queued offline.`);
      return observeEnqueue(async () => {
        try { return await enqueue(carrier, input); }
        catch (error) { return UnexpectedDefect({ cause: error }); }
      });
    },
    status,
    drain,
    deadLetter: {
      list: () => deadLetterApi.list(),
      retry: id => observeQueue('offline.queue.retry', () => deadLetterApi.retry(id)),
      discard: id => observeQueue('offline.queue.discard', () => deadLetterApi.discard(id)),
    },
    subscribe,
    dispose,
  };
}
