import { describe, expect, it } from 'vitest';

import { child, cleanup, Deadline, resource } from '@arki/async';
import { MockClock } from '@arki/clock';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { lazy, LazyClosed, plugin } from '../plugin-contract.js';

const Refused = defineFailure('test.ownership_refused');
const CloseRefused = defineFailure('test.ownership_close_refused');

function gate() {
  let release: () => void = () => {
    throw new Error('Gate was not initialized');
  };
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

describe('plugin ownership', () => {
  it('preserves detached builder callbacks through every composition phase', async () => {
    const { infra } = defineApp('detached');
    const { use } = infra();
    const { useAll } = use(plugin({ name: 'value', provides: { value: () => 42 } }));
    const { features } = useAll([]);
    const { serve } = features([]);
    const { entrypoints } = serve(plugin({ name: 'driver' }));
    const { configure, boot, start } = entrypoints();
    const apps = [orThrow(await orThrow(configure()).boot()), orThrow(await boot()), orThrow(await start())];
    for (const app of apps) {
      expect(app.services.value).toBe(42);
      orThrow(await app.dispose());
    }
  });

  it('treats a child interrupted by its owner as normal shutdown', async () => {
    const clock = new MockClock();
    const started = gate();
    const app = orThrow(
      await defineApp('child-cancellation')
        .use(
          plugin({
            name: 'worker',
            boot: () => ({
              worker: child(async signal => {
                started.release();
                return clock.sleep(10_000, signal);
              }),
            }),
          }),
        )
        .boot(),
    );
    await started.promise;
    expect(await app.dispose()).toBeUndefined();
  });

  it('owns an initialized Lazy returned after its factory deadline', async () => {
    const clock = new MockClock();
    const started = gate();
    const releaseFactory = gate();
    let finalizations = 0;
    const handle = lazy(() => 42, {
      dispose: () => {
        finalizations++;
      },
    });
    expect(await handle.get()).toBe(42);
    const booting = defineApp('late-lazy', { clock, hookTimeoutMs: 10 })
      .use(
        plugin({
          name: 'provider',
          provides: {
            value: async () => {
              started.release();
              await releaseFactory.promise;
              return handle;
            },
          },
        }),
      )
      .boot();
    await started.promise;
    clock.advance(10);
    expect(finalizations).toBe(0);
    releaseFactory.release();
    expect(Deadline.is(await booting)).toBe(true);
    expect(finalizations).toBe(1);
    expect(LazyClosed.is(await handle.get())).toBe(true);
  });

  it('lets an explicit resource own its Lazy finalizer', async () => {
    let finalizations = 0;
    const refusal = CloseRefused();
    const handle = lazy(() => 42, {
      dispose: () => {
        finalizations++;
        return refusal;
      },
    });
    const app = orThrow(
      await defineApp('explicit-lazy')
        .use(
          plugin({
            name: 'provider',
            provides: {
              value: () =>
                resource(
                  () => handle,
                  value => value.dispose(),
                ),
            },
          }),
        )
        .boot(),
    );
    expect(await app.services.value.get()).toBe(42);
    expect(await app.dispose()).toBe(refusal);
    expect(finalizations).toBe(1);
  });

  it('closes partial acquisitions before unwinding previously constructed plugins', async () => {
    const events: string[] = [];
    const earlier = plugin({
      name: 'earlier',
      provides: {
        earlier: () =>
          resource(
            () => 'earlier',
            () => {
              events.push('earlier');
            },
          ),
      },
    });
    const failed = plugin({
      name: 'failed',
      provides: {
        first: () =>
          resource(
            () => 'first',
            () => {
              events.push('partial');
            },
          ),
        second: () =>
          resource(
            () => Refused(),
            () => {
              throw new Error('refusal was finalized');
            },
          ),
      },
    });
    const refusal = await defineApp('partial').use(earlier).use(failed).boot();
    expect(Refused.is(refusal)).toBe(true);
    expect(events).toEqual(['partial', 'earlier']);
  });

  it('transfers the completed lifetime and drains a child before finalizing its resource', async () => {
    const events: string[] = [];
    let live = true;
    const app = orThrow(
      await defineApp('transfer')
        .use(
          plugin({
            name: 'owned',
            provides: {
              db: () =>
                resource(
                  () => ({ query: () => live }),
                  () => {
                    live = false;
                    events.push('resource');
                  },
                ),
            },
            boot({ db }) {
              return {
                watch: child(async signal => {
                  await new Promise<void>(resolve => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                  });
                  expect(db.query()).toBe(true);
                  events.push('child');
                }),
                flush: cleanup(() => {
                  events.push('cleanup');
                }),
              };
            },
            dispose() {
              events.push('hook');
            },
          }),
        )
        .boot(),
    );
    expect(app.services.db.query()).toBe(true);
    expect(events).toEqual([]);
    expect(await app.dispose()).toBeUndefined();
    expect(events).toEqual(['child', 'hook', 'cleanup', 'resource']);
  });

  it('preserves returned cleanup failure for concurrent and later application disposal', async () => {
    let calls = 0;
    const refusal = CloseRefused();
    const app = orThrow(
      await defineApp('close')
        .use(
          plugin({
            name: 'owned',
            provides: {
              db: () =>
                resource(
                  () => 42,
                  () => {
                    calls++;
                    return refusal;
                  },
                ),
            },
          }),
        )
        .boot(),
    );
    const [first, second] = await Promise.all([app.dispose(), app.dispose()]);
    expect(first).toBe(refusal);
    expect(second).toBe(first);
    expect(await app.dispose()).toBe(first);
    expect(calls).toBe(1);
  });

  it('retains lazy cleanup failures without an explicit plugin dispose hook', async () => {
    const refusal = CloseRefused();
    const app = orThrow(
      await defineApp('lazy')
        .use(plugin({ name: 'owned', provides: { db: () => lazy(() => 42, { dispose: () => refusal }) } }))
        .boot(),
    );
    expect(orThrow(await app.services.db.get())).toBe(42);
    expect(await app.dispose()).toBe(refusal);
  });

  it('retains the primary refusal and all ordered cleanup failures', async () => {
    const primary = Refused();
    const first = CloseRefused();
    const second = CloseRefused();
    const events: string[] = [];
    const result = await defineApp('aggregate')
      .use(
        plugin({
          name: 'owned',
          provides: {
            first: () =>
              resource(
                () => 1,
                () => {
                  events.push('first');
                  return first;
                },
              ),
            second: () =>
              resource(
                () => 2,
                () => {
                  events.push('second');
                  return second;
                },
              ),
            refused: () =>
              resource(
                () => primary,
                () => {
                  throw new Error('failure finalized');
                },
              ),
          },
        }),
      )
      .boot();
    expect(isFailure<unknown>(result)).toBe(true);
    if (typeof result !== 'object' || !('cause' in result)) throw new Error('Expected ownership failure');
    expect(result.cause).toEqual({ primary: [primary], cleanup: [second, first] });
    expect(events).toEqual(['second', 'first']);
  });

  it('unwinds owned resource closures when a later factory throws', async () => {
    let closes = 0;
    const result = await defineApp('defect')
      .use(
        plugin({
          name: 'owned',
          provides: {
            first: () =>
              resource(
                () => 1,
                () => {
                  closes++;
                },
              ),
            second: () => {
              throw new Error('driver defect');
            },
          },
        }),
      )
      .boot();
    expect(isFailure(result)).toBe(true);
    expect(closes).toBe(1);
  });

  it('uses the Clock watchdog and joins a late acquisition before releasing it', async () => {
    const clock = new MockClock();
    const opened = gate();
    const started = gate();
    let finalizations = 0;
    const booting = defineApp('deadline', { clock, hookTimeoutMs: 10 })
      .use(
        plugin({
          name: 'late',
          provides: {
            db: () =>
              resource(
                async () => {
                  started.release();
                  await opened.promise;
                  return 42;
                },
                () => {
                  finalizations++;
                },
              ),
          },
        }),
      )
      .boot();
    await started.promise;
    clock.advance(10);
    let settled = false;
    void booting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    opened.release();
    const result = await booting;
    expect(isFailure(result)).toBe(true);
    expect(Deadline.is(result)).toBe(true);
    expect(finalizations).toBe(1);
  });
});
