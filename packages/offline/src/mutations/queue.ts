/**
 * OfflineMutationQueue — the central write-path primitive.
 *
 * Persists queued mutations to IDB and replays them on reconnect.
 * The queue itself is network-agnostic; the replay loop (replay.ts)
 * drives network I/O and event listener wiring.
 */
import { nanoid } from 'nanoid';

import type { OfflineSafeProcedure, InferOfflineSafeInput } from '../orpc/offline-safe-marker.ts';
import { createQueueStorage } from './storage.ts';
import type { QueueStorage } from './storage.ts';
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
  enqueuedAt: number;
  attempts: number;
  lastError?: { code: string; message: string };
}

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
  maxRetries?: number;
  backoff?: (attempt: number) => number;
  onDeadLetter?: (entry: QueuedMutation, error: Error) => void;
}

export interface OfflineMutationQueue {
  enqueue<TProc extends OfflineSafeProcedure>(
    procedure: TProc,
    input: InferOfflineSafeInput<TProc>,
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
    maxRetries = 5,
    backoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** attempt),
    onDeadLetter,
  } = options;

  const storage: QueueStorage = createQueueStorage(storageKey);
  const dlStore: DeadLetterStore = createDeadLetterStore(deadLetterStorageKey);

  const listeners = new Set<(event: QueueEvent) => void>();
  const state: QueueState = { sending: false, queuedCount: 0, deadLetteredCount: 0 };

  // Sync counts on startup (fire-and-forget; acceptable startup race)
  void storage.read().then((items) => {
    state.queuedCount = items.length;
  });
  void dlStore.list().then((items) => {
    state.deadLetteredCount = items.length;
  });

  // Keep dead-letter count in sync whenever the dead-letter store changes
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

  async function enqueue<TProc extends OfflineSafeProcedure>(
    procedure: TProc,
    input: InferOfflineSafeInput<TProc>,
  ): Promise<{ idempotencyKey: string; status: 'queued' | 'sent' }> {
    const id = nanoid();
    const entry: QueuedMutation = {
      id,
      idempotencyKey: id,
      // Extract the procedure path from the procedure object.
      // oRPC procedures expose their route as `~orpc.path`; we fall back to
      // an empty array — callers using the type-safe API should not hit this.
      procedurePath: getProcedurePath(procedure),
      input,
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

      // Reset attempts, re-enqueue, remove from dead-letter
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProcedurePath(procedure: unknown): readonly string[] {
  if (
    procedure !== null &&
    typeof procedure === 'object' &&
    '~orpc' in procedure &&
    typeof (procedure as Record<string, unknown>)['~orpc'] === 'object'
  ) {
    const orpc = (procedure as Record<string, unknown>)['~orpc'] as Record<string, unknown>;
    if (Array.isArray(orpc['path'])) {
      return orpc['path'] as string[];
    }
  }
  return [];
}
