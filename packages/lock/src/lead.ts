/**
 * Leader election on a lease store: `locks.mutex(key).lead(fn, { signal })`.
 *
 * States of one campaigner:
 *   CAMPAIGN  tryAcquire. Won: go to LEAD. Refused or failed: go to WAIT.
 *   LEAD      run `fn(ctx)` and wait for it to settle. A lost lease aborts `ctx.signal`,
 *             but a second `fn` never starts while the first still runs.
 *   STEP DOWN release the lease (a release error is logged and counted, never thrown), go to WAIT.
 *   WAIT      sleep one beat (ttl/3) or until the store's `waitFor` wakes us, then CAMPAIGN.
 * `opts.signal` aborting in any state ends the loop after the step down.
 */
import { getLogger } from '@arki/log';

import type { Scheduler } from './scheduler.js';
import type { Key } from './types.js';
import { LockError } from './errors.js';

const log = getLogger('arki:lock');

/** What `fn` receives. Same shape as `LockContext`, wide because the store type is erased here. */
export type LeadContext = { readonly signal: AbortSignal; readonly fence: bigint | undefined; readonly key: Key };

/** The part of a guard the loop needs. */
type LeadGuard = LeadContext & { release(): Promise<void> };

/** What `locks.ts` hands the loop. */
export type LeadDeps = {
  readonly key: Key;
  /** Hidden unless `logKeys`. */
  readonly keyField: string;
  readonly scheduler: Scheduler;
  /** One beat: the store's lease length divided by three. */
  readonly beatMs: number;
  readonly counts: { leadAcquired: number; leadLost: number };
  tryAcquire(opts: { readonly signal?: AbortSignal }): Promise<LeadGuard | undefined>;
  /** The store's wake-up hook, when it has one. */
  waitFor?(key: Key, signal: AbortSignal): Promise<void>;
  /** Count, log and report a failed release. */
  onReleaseError(error: unknown): void;
};

function ignore(): void {
  // A failing wake-up hook costs only the early wake-up.
}

/**
 * Sleep one beat, or until the store wakes us (only when `mayWake`: after a refused campaign,
 * never after our own term, because the key is free then and the hook would return at once), or until `signal` aborts. Leaves no timer behind. */
async function waitBeat(deps: LeadDeps, signal: AbortSignal | undefined, mayWake: boolean): Promise<void> {
  if (signal?.aborted === true) return;
  const wake = new AbortController();
  let timer: ReturnType<Scheduler['setTimeout']> | undefined;
  let onAbort: (() => void) | undefined;
  await new Promise<void>(resolve => {
    // ref: true. Leader election is the app's main loop: a process whose only work is
    // campaigning must stay alive, so the beat timer is allowed to hold it open.
    // It is always cleared on abort, so it never blocks a shutdown.
    timer = deps.scheduler.setTimeout(resolve, deps.beatMs, { ref: true });
    if (signal !== undefined) {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (mayWake && deps.waitFor !== undefined) {
      // A failing hook, sync or async, only costs the early wake-up; the beat timer still fires.
      try {
        deps.waitFor(deps.key, wake.signal).then(resolve, ignore);
      } catch {
        ignore();
      }
    }
  });
  if (timer !== undefined) deps.scheduler.clearTimeout(timer);
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  wake.abort();
}

/**
 * Campaign until `opts.signal` aborts (forever without one). Resolves, never rejects.
 * `fn` should run for as long as it wants leadership: when it returns, the lease is
 * released and the loop campaigns again after a beat.
 */
export async function lead(
  deps: LeadDeps,
  fn: (ctx: LeadContext) => unknown,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = opts;
  const { keyField } = deps;
  const aborted = (): boolean => signal?.aborted === true;
  while (!aborted()) {
    let guard: LeadGuard | undefined;
    try {
      guard = await deps.tryAcquire(signal === undefined ? {} : { signal });
    } catch (error) {
      // A store failure or an abort during the attempt: not leader this round.
      if (!aborted()) log.error(error instanceof Error ? error : new Error(String(error)), { key: keyField });
    }
    // After any term (even a stillborn one) the key is free, so the next wait must not use the store's wake-up hook.
    const gotLease = guard !== undefined;
    // The signal can abort while a grant lands (renew-now): hand it back without running fn.
    if (guard?.signal.aborted === true) {
      try {
        await guard.release();
      } catch (error) {
        deps.onReleaseError(error);
      }
      guard = undefined;
    } else if (guard !== undefined) {
      deps.counts.leadAcquired += 1;
      log.info('leading {key} (fence {fence})', { key: keyField, fence: guard.fence?.toString() ?? 'none' });
      try {
        await fn({ signal: guard.signal, fence: guard.fence, key: guard.key });
      } catch (error) {
        log.error(error instanceof Error ? error : new Error(String(error)), {
          key: keyField,
          note: 'lead callback threw',
        });
      }
      const reason: unknown = guard.signal.reason;
      if (reason instanceof LockError && reason.code === 'lost') deps.counts.leadLost += 1;
      try {
        await guard.release();
      } catch (error) {
        deps.onReleaseError(error);
      }
      log.info('stepped down {key}', { key: keyField });
    }
    await waitBeat(deps, signal, !gotLease);
  }
}
