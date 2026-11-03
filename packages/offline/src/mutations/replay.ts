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
import { z } from 'zod';

import { Cancelled, sleep } from '@arki/async';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import type { Backoff } from '@arki/resilience';
import { is } from '@arki/schema';

import type { DeadLetterStore } from './dead-letter.js';
import type { DrainFailure, QueueStorageFailure } from './failures.js';
import type { AnyRpcClient, QueuedMutation, QueueEvent } from './queue.js';
import type { QueueStorage } from './storage.js';
import { QueueEffectUnconfirmed, QueueTransportUnavailable } from './failures.js';
import { observeQueue } from './telemetry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplayLoopOptions = {
  storage: QueueStorage;
  dlStore: DeadLetterStore;
  rpc: AnyRpcClient;
  /** Who is signed in now (`null`: nobody; `undefined`: not known yet). Read right before every send attempt. */
  actorId: () => string | null | undefined;
  /**
   * When to retry a send that failed for a transient reason (5xx, network), and when to give up and
   * dead-letter the entry. `retry.delay(n, ...)` is the wait before retry `n`; `undefined` ends the retries.
   */
  retry: Backoff;
  onDeadLetter?: (entry: QueuedMutation, error: Error) => void;
  onStateChange: (sending: boolean) => void;
  emit: (event: QueueEvent) => void;
}

export type ReplayLoop = {
  start(): void;
  stop(): void;
  drainNow(): Promise<void | DrainFailure>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Observers report state; they cannot gate a drain or replace its persistence outcome. */
function notify(report: () => void): void {
  try {
    void Promise.resolve(report()).catch(() => {
      // A rejected observer cannot replace a typed replay outcome.
    });
  } catch {
    // A failed observer does not own the queue operation.
  }
}

/** A thrown error that carries an HTTP `status`. */
const httpStatusSchema = z.object({ status: z.number() });

function getHttpStatus(error: unknown): number | null {
  return is(error, httpStatusSchema) ? error.status : null;
}

/** What a transient failure tells the retry schedule: a thrown error, which `Backoff` retries by default. */
const TRANSIENT_FAILURE = new Error('Transient send failure');

function classifyResponse(error: unknown): 'dead-letter' | 'retry' | 'halt' | ReturnType<typeof UnexpectedDefect> {
  if (UnexpectedDefect.is(error)) return error;
  if (QueueTransportUnavailable.is(error)) return 'retry';
  const status = getHttpStatus(error);

  if (status === 401) {
    return 'halt';
  }

  if (status !== null && status >= 400 && status < 500) {
    // 4xx non-auth — dead-letter immediately
    return 'dead-letter';
  }

  if (status !== null && status >= 500 && status <= 599) return 'retry';
  return UnexpectedDefect({ cause: error });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReplayLoop(options: ReplayLoopOptions): ReplayLoop {
  const { storage, dlStore, rpc, actorId, retry, onDeadLetter, onStateChange, emit } = options;

  // A successful server call is never repeated in this runtime if queue cleanup fails.
  const accepted = new Map<QueuedMutation['id'], QueuedMutation>();
  let draining = false;
  let halted = false; // auth-required state
  let drainPromise: Promise<void | DrainFailure> | null = null;
  // Aborted by stop(): cancels the retry wait of a running drain.
  let stopController = new AbortController();

  /**
   * Try sending one mutation. Returns:
   * - 'sent'        — success; remove from queue
   * - 'dead-letter' — 4xx non-auth; move to dead-letter
   * - 'retry'       — 5xx / network error; increment attempts, backoff, retry
   * - 'halt'        — 401; stop loop without dead-lettering
   */
  async function trySend(
    entry: QueuedMutation,
  ): Promise<'sent' | 'dead-letter' | 'retry' | 'halt' | ReturnType<typeof UnexpectedDefect>> {
    try {
      // The server checks Offline-Actor against the session the request really
      // carries; the browser-side check alone cannot see a cookie switch.
      const response = await rpc.call(entry.procedurePath, entry.input, {
        'Idempotency-Key': entry.idempotencyKey,
        ...(entry.actorId === null ? {} : { 'Offline-Actor': entry.actorId }),
      });
      if (isFailure(response)) return classifyResponse(response);
      return 'sent';
    } catch (error) {
      return classifyResponse(error);
    }
  }

  /** Remove an entry from the queue and park it in the dead-letter store. */
  async function deadLetter(entry: QueuedMutation, error: Error): Promise<void | QueueStorageFailure> {
    const after = await storage.read();
    if (isFailure(after)) return after;
    const parked = await dlStore.add(entry, error);
    if (isFailure(parked)) return parked;
    const removed = await storage.write(after.filter(m => m.id !== entry.id));
    if (isFailure(removed)) return removed;
    notify(() => emit({ type: 'dead-letter', entry, error }));
    notify(() => onDeadLetter?.(entry, error));
  }

  /**
   * Send one entry with retries and backoff.
   * Returns true if the entry was processed (sent or dead-lettered),
   * false if the loop should halt (401).
   */
  async function processEntry(entry: QueuedMutation): Promise<boolean | DrainFailure> {
    let current = entry;

    while (true) {
      // The request carries the session signed in at this moment, not the one
      // that queued the write. Read it right before every attempt (a retry
      // backoff can span an account switch) and never send under another actor.
      const signedIn = accepted.has(current.id) ? current.actorId : actorId();
      if (current.actorId !== signedIn) {
        if (signedIn === null || signedIn === undefined) {
          // Signed out or not known yet: wait for a sign-in; `drain()` after it resumes.
          notify(() => emit({ type: 'auth-required' }));
          return false;
        }
        const message = 'Queued under another account; not sent under the account signed in now';
        const result = await deadLetter(
          { ...current, lastError: { code: 'ACTOR_MISMATCH', message } },
          new Error(message),
        );
        return isFailure(result) ? result : true;
      }

      const result = accepted.has(current.id) ? 'sent' : await trySend(current);
      if (isFailure(result)) return result;

      if (result === 'sent') {
        accepted.set(current.id, current);
        const after = await storage.read();
        if (isFailure(after))
          return QueueEffectUnconfirmed({ id: current.id, idempotencyKey: current.idempotencyKey }, { cause: after });
        const removed = await storage.write(after.filter(m => m.id !== entry.id));
        if (isFailure(removed))
          return QueueEffectUnconfirmed({ id: current.id, idempotencyKey: current.idempotencyKey }, { cause: removed });
        accepted.delete(current.id);
        notify(() => emit({ type: 'sent', entry: current }));
        return true;
      }

      if (result === 'halt') {
        halted = true;
        notify(() => emit({ type: 'auth-required' }));
        return false;
      }

      if (result === 'dead-letter') {
        const result = await deadLetter(current, new Error('Request failed with 4xx status'));
        return isFailure(result) ? result : true;
      }

      // result === 'retry'
      const nextAttempts = current.attempts + 1;
      const delay = retry.delay(nextAttempts, TRANSIENT_FAILURE);

      if (delay === undefined) {
        // Exhausted — dead-letter
        const finalError = new Error('Max retries exceeded');
        const updated: QueuedMutation = {
          ...current,
          attempts: nextAttempts,
          lastError: { code: 'MAX_RETRIES', message: finalError.message },
        };
        const result = await deadLetter(updated, finalError);
        return isFailure(result) ? result : true;
      }

      // Update attempts in storage before sleeping
      current = {
        ...current,
        attempts: nextAttempts,
        lastError: { code: 'RETRY', message: 'Transient failure, retrying' },
      };
      const persisted = await updateEntry(current);
      if (isFailure(persisted)) return persisted;

      const waited = await sleep(delay, { signal: stopController.signal });
      if (Cancelled.is(waited)) return false;
      if (isFailure(waited)) return waited;
    }
  }

  function reconcileAccepted(failure: QueueStorageFailure): DrainFailure {
    const entry = accepted.values().next().value;
    return entry === undefined
      ? failure
      : QueueEffectUnconfirmed({ id: entry.id, idempotencyKey: entry.idempotencyKey }, { cause: failure });
  }

  async function drain(): Promise<void | DrainFailure> {
    if (draining || halted) return;
    draining = true;
    try {
      notify(() => onStateChange(true));
      // Process entries one at a time in FIFO order.
      // Re-read the head of the queue before each entry so late-enqueuers
      // are included in the same drain pass.
      const entries = await storage.read();
      if (isFailure(entries)) return reconcileAccepted(entries);
      // A delete can commit before IDB loses its acknowledgement. Confirm absence
      // before forgetting the remotely accepted identity; never repeat its RPC.
      for (const [id, entry] of accepted) {
        if (!entries.some(candidate => candidate.id === id)) {
          accepted.delete(id);
          notify(() => emit({ type: 'sent', entry }));
        }
      }

      for (const snapshot of entries) {
        // Verify the entry is still present (could be removed by a parallel caller)
        const current = await storage.read();
        if (isFailure(current)) return reconcileAccepted(current);
        const live = current.find(m => m.id === snapshot.id);
        if (!live) continue;

        const shouldContinue = await processEntry(live);
        if (isFailure(shouldContinue)) return shouldContinue;
        if (!shouldContinue) break;
      }
    } finally {
      draining = false;
      notify(() => onStateChange(false));
    }
  }

  async function updateEntry(updated: QueuedMutation): Promise<void | QueueStorageFailure> {
    const current = await storage.read();
    if (isFailure(current)) return current;
    return storage.write(current.map(m => (m.id === updated.id ? updated : m)));
  }

  // Serialise concurrent drain calls — only one drain runs at a time.
  function scheduleDrain(): Promise<void | DrainFailure> {
    if (drainPromise) return drainPromise;
    drainPromise = observeQueue('offline.queue.drain', drain).finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  function handleOnline(): void {
    halted = false; // reset auth halt on re-connect
    notify(() => emit({ type: 'online' }));
    void scheduleDrain().then(result => {
      if (isFailure(result)) notify(() => emit({ type: 'failure', failure: result }));
    });
  }

  function handleOffline(): void {
    notify(() => emit({ type: 'offline' }));
  }

  return {
    start(): void {
      stopController = new AbortController();
      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
      }
    },

    stop(): void {
      stopController.abort();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    },

    drainNow(): Promise<void | DrainFailure> {
      halted = false;
      return scheduleDrain();
    },
  };
}
