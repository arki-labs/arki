import { assert, it } from 'vitest';

import type { Failure, FailureOf } from '@arki/failure';
import { MockClock } from '@arki/clock';
import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import type { ScopeAggregate } from './errors.js';
import { timeout } from './concurrency.js';
import { Cancelled, Deadline } from './errors.js';
import { child, cleanup, createLifetime, dynamicScope, openScope, resource, scoped } from './scope.js';
import { sleep } from './sleep.js';

const Refused = defineFailure('executor.refused');
const CloseRefused = defineFailure('executor.close_refused');
const ChildRefused = defineFailure('executor.child_refused');
const Foreign = defineFailure('executor.foreign');
function gate<Value>() {
  let complete: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: Value) {
      if (complete === undefined) throw new Error('Missing resolver');
      complete(value);
    },
  };
}
function localAggregate(value: unknown): asserts value is ScopeAggregate<Failure, Failure> {
  assert(isFailure(value));
  assert.equal(value.code, 'async.scope_failed');
  assert(
    typeof value.cause === 'object' && value.cause !== null && 'primary' in value.cause && 'cleanup' in value.cause,
  );
}

it('ordinary success and finalizer order', async () => {
  const order: string[] = [];
  const value = await scoped(
    {
      db: resource(
        () => ({ query: () => 42 }),
        db => {
          assert.equal(db.query(), 42);
          order.push('db');
        },
      ),
      flush: cleanup(() => {
        order.push('flush');
      }),
    },
    ({ db }) => db.query(),
  );
  assert.equal(value, 42);
  assert.deepEqual(order, ['flush', 'db']);
});
it('refusal never becomes resource and partial resources close', async () => {
  let closed = 0;
  let refusedClosed = 0;
  const refusal = Refused();
  const result = await scoped(
    {
      first: resource(
        () => 1,
        () => {
          closed++;
        },
      ),
      refused: resource(
        () => refusal,
        () => {
          refusedClosed++;
        },
      ),
    },
    () => {
      throw new Error('Body must not run');
    },
  );
  assert.equal(result, refusal);
  assert.equal(closed, 1);
  assert.equal(refusedClosed, 0);
});
it('primary and every cleanup failure retain identity', async () => {
  const primary = Refused();
  const first = CloseRefused();
  const second = CloseRefused();
  const result = await scoped({ a: cleanup(() => first), b: cleanup(() => second) }, () => primary);
  localAggregate(result);
  assert.deepEqual(result.cause.primary, [primary]);
  assert.deepEqual(result.cause.cleanup, [second, first]);
});
it('thrown failures become private defects', async () => {
  const secret = new Error('driver private');
  const result = await scoped(
    {
      a: cleanup(() => {
        throw secret;
      }),
    },
    () => 42,
  );
  assert(UnexpectedDefect.is(result));
  assert.equal(result.cause, secret);
});
it('real sleep owner abort joins child before cleanup', async () => {
  const clock = new MockClock();
  const started = gate<void>();
  const order: string[] = [];
  const result = await scoped(
    {
      db: resource(
        () => ({ query: () => 42 }),
        () => {
          order.push('close');
        },
      ),
      watch: child(async signal => {
        started.resolve();
        try {
          await sleep(1000, { signal, clock });
        } finally {
          order.push('child');
        }
      }),
    },
    async ({ db }) => {
      await started.promise;
      return db.query();
    },
  );
  assert.equal(result, 42);
  assert.deepEqual(order, ['child', 'close']);
  await clock.advanceAsync(2000);
});
it('foreign exception after owner abort is never suppressed', async () => {
  const clock = new MockClock();
  const started = gate<void>();
  const secret = new Error('foreign after abort');
  const result = await scoped(
    {
      child: child(async signal => {
        started.resolve();
        try {
          await sleep(1000, { signal, clock });
        } catch {
          throw secret;
        }
      }),
    },
    async () => {
      await started.promise;
      return 42;
    },
  );
  assert(UnexpectedDefect.is(result));
  assert.equal(result.cause, secret);
});
it('child refusal cancels owned body without adding false defect', async () => {
  const clock = new MockClock();
  const fail = gate<void>();
  const refusal = ChildRefused();
  const result = await scoped(
    {
      watch: child(async () => {
        await fail.promise;
        return refusal;
      }),
    },
    async (_values, signal) => {
      fail.resolve();
      await sleep(1000, { signal, clock });
      return 42;
    },
  );
  assert.equal(result, refusal);
});
it('preaborted external reason is normalized and body skipped', async () => {
  let called = false;
  const result = await scoped(
    {},
    () => {
      called = true;
    },
    { signal: AbortSignal.abort('foreign reason') },
  );
  assert(Cancelled.is(result));
  assert.equal(result.cause, 'foreign reason');
  assert.equal(called, false);
});
it('deadline remains distinct and Clock owns trigger', async () => {
  const clock = new MockClock();
  const deadline = new AbortController();
  const started = gate<void>();
  const pending = scoped(
    {},
    async (_values, signal) => {
      started.resolve();
      await sleep(1000, { signal, clock });
    },
    { deadline: deadline.signal },
  );
  await started.promise;
  clock.setTimer(() => deadline.abort('deadline private'), 10);
  await clock.advanceAsync(10);
  const result = await pending;
  assert(Deadline.is(result));
  assert.equal(result.cause, 'deadline private');
});
it('late acquisition closes before close settles and retains cleanup refusal', async () => {
  const lifetime = createLifetime<never, FailureOf<typeof CloseRefused>>({});
  const opened = gate<number>();
  let closed = 0;
  const refusal = CloseRefused();
  const acquiring = lifetime.acquire(
    resource(
      () => opened.promise,
      value => {
        assert.equal(value, 42);
        closed++;
        return refusal;
      },
    ).prepare,
  );
  let settled = false;
  const closing = lifetime.close().then(value => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  opened.resolve(42);
  assert(Cancelled.is(await acquiring));
  assert.equal(await closing, refusal);
  assert.equal(closed, 1);
});
it('noncooperative child keeps close pending and cleanup waits', async () => {
  const lifetime = createLifetime({});
  const finish = gate<void>();
  let finalized = false;
  lifetime.defer(() => {
    finalized = true;
  });
  lifetime.fork(() => finish.promise);
  const closing = lifetime.close();
  await Promise.resolve();
  assert.equal(finalized, false);
  finish.resolve();
  assert.equal(await closing, undefined);
  assert.equal(finalized, true);
});
it('cached closure is exact-once and preserves result identity', async () => {
  let count = 0;
  const first = CloseRefused();
  const second = CloseRefused();
  const owned = await openScope({
    first: cleanup(() => {
      count++;
      return first;
    }),
    second: cleanup(() => second),
  });
  assert(!isFailure(owned));
  const one = owned.close();
  const two = owned.close();
  assert.equal(one, two);
  assert.equal(await one, await two);
  assert.equal(count, 1);
});
it('dependent child reads db during shutdown before outer close', async () => {
  let alive = true;
  const started = gate<void>();
  const clock = new MockClock();
  const result = await scoped(
    {
      db: resource(
        () => ({
          query: () => {
            assert(alive);
            return 42;
          },
        }),
        () => {
          alive = false;
        },
      ),
    },
    ({ db }, signal) =>
      scoped(
        {
          dependent: resource(
            () => ({ answer: db.query() }),
            value => {
              assert.equal(value.answer, 42);
            },
          ),
          watch: child(async childSignal => {
            started.resolve();
            try {
              await sleep(1000, { signal: childSignal, clock });
            } finally {
              db.query();
            }
          }),
        },
        async ({ dependent }) => {
          await started.promise;
          return dependent.answer;
        },
        { signal },
      ),
  );
  assert.equal(result, 42);
  assert.equal(alive, false);
});
it('dynamic registered callback failures are checked at runtime', async () => {
  const accepted = [Refused, CloseRefused, ChildRefused] as const;
  const result = await dynamicScope(accepted).run(async scope => {
    scope.defer(() => CloseRefused());
    const db = await scope.acquire(
      () => ({ query: () => 42 }),
      db => {
        void db.query();
      },
    );
    if (isFailure(db)) return db;
    return db.query();
  });
  assert(CloseRefused.is(result));
});
it('untyped dynamic caller cannot smuggle a foreign refusal', async () => {
  // The intentional Reflect seam models external JS bypassing TS. The actual
  // dynamic runtime edge must still validate against the canonical allowlist.
  const result = await dynamicScope([]).run(scope => {
    Reflect.apply(scope.defer, scope, [() => Foreign()]);
    return 42;
  });
  assert(UnexpectedDefect.is(result));
  assert(Foreign.is(result.cause));
});
it('admission closes before cancellation and late registration is refused', async () => {
  const lifetime = createLifetime({});
  const closing = lifetime.close();
  let ran = false;
  assert(
    Cancelled.is(
      lifetime.defer(() => {
        ran = true;
      }),
    ),
  );
  assert(
    Cancelled.is(
      lifetime.fork(() => {
        ran = true;
      }),
    ),
  );
  await closing;
  assert.equal(ran, false);
});

it('multiple children retain every primary refusal in settlement order', async () => {
  const first = ChildRefused();
  const second = ChildRefused();
  const result = await scoped({ a: child(() => first), b: child(() => second) }, () => 42);
  localAggregate(result);
  assert.deepEqual(result.cause.primary, [first, second]);
});
it('an early-returning foreign wrapper does not confer ownership', async () => {
  const clock = new MockClock();
  const foreign = gate<number>();
  const started = gate<void>();
  let closed = false;
  const pending = scoped(
    {
      db: resource(
        () => 42,
        () => {
          closed = true;
        },
      ),
    },
    () =>
      timeout(
        () => {
          started.resolve();
          return foreign.promise;
        },
        10,
        { clock },
      ),
  );
  await started.promise;
  await clock.advanceAsync(10);
  const result = await pending;
  assert(UnexpectedDefect.is(result)); // Legacy timeout rejection, not scope's deadline signal.
  assert.equal(closed, true);
  // The original promise was never registered with this scope. Complete it and
  // observe it explicitly; no API can discover hidden foreign work automatically.
  foreign.resolve(42);
  assert.equal(await foreign.promise, 42);
});
it('registering the original child settlement survives early wrapper return', async () => {
  const clock = new MockClock();
  const childWork = gate<number>();
  const started = gate<void>();
  let closed = false;
  let settled = false;
  const pending = scoped(
    {
      db: resource(
        () => 42,
        () => {
          closed = true;
        },
      ),
      original: child(() => childWork.promise),
    },
    () =>
      timeout(
        () => {
          started.resolve();
          return childWork.promise;
        },
        10,
        { clock },
      ),
  );
  void pending.then(() => {
    settled = true;
  });
  await started.promise;
  await clock.advanceAsync(10);
  assert.equal(closed, false);
  assert.equal(settled, false);
  childWork.resolve(42);
  assert(UnexpectedDefect.is(await pending));
  assert.equal(closed, true);
});

it('unawaited late acquisition refusal is owned and not lost', async () => {
  const failed = gate<ReturnType<typeof Refused>>();
  const refusal = Refused();
  const resultPromise = dynamicScope([Refused]).run(scope => {
    void scope.acquire(
      () => failed.promise,
      () => void 0,
    );
    return 42;
  });
  failed.resolve(refusal);
  assert.equal(await resultPromise, refusal);
});
it('returned acquisition refusal is identity-deduplicated', async () => {
  const refusal = Refused();
  const result = await dynamicScope([Refused]).run(async scope => {
    return await scope.acquire(
      () => refusal,
      () => void 0,
    );
  });
  assert.equal(result, refusal);
});
it('unawaited acquisition defect is owned and not lost', async () => {
  const secret = new Error('unawaited acquisition defect');
  const result = await dynamicScope([]).run(scope => {
    void scope.acquire(
      () => Promise.reject(secret),
      () => void 0,
    );
    return 42;
  });
  assert(UnexpectedDefect.is(result));
  assert.equal(result.cause, secret);
});
it('prototype-shaped resource names are own data properties', async () => {
  const result = await scoped(
    {
      ['__proto__']: resource(
        () => ({ answer: 42 }),
        () => void 0,
      ),
    },
    values => values.__proto__.answer,
  );
  assert.equal(result, 42);
});
it('Clock.sleep owned cancellation uses trusted cause identity', async () => {
  const clock = new MockClock();
  const started = gate<void>();
  const result = await scoped(
    {
      watcher: child(async signal => {
        started.resolve();
        await clock.sleep(1000, signal);
      }),
    },
    async () => {
      await started.promise;
      return 42;
    },
  );
  assert.equal(result, 42);
});
it('dynamic options normalize an external deadline', async () => {
  const result = await dynamicScope([]).run(() => 42, { deadline: AbortSignal.abort('expired') });
  assert(Deadline.is(result));
});

it('quiesces children before a dispose hook, then runs registered finalizers', async () => {
  const clock = new MockClock();
  const started = gate<void>();
  const order: string[] = [];
  const lifetime = createLifetime({});
  lifetime.defer(() => {
    order.push('finalizer');
  });
  const watcher = child(async signal => {
    started.resolve();
    try {
      await clock.sleep(1000, signal);
    } finally {
      order.push('child');
    }
  });
  lifetime.fork(watcher.run);
  await started.promise;
  const first = lifetime.quiesce();
  assert.equal(first, lifetime.quiesce());
  assert.equal(await first, undefined);
  assert.deepEqual(order, ['child']);
  order.push('dispose hook');
  assert.equal(await lifetime.close(), undefined);
  assert.deepEqual(order, ['child', 'dispose hook', 'finalizer']);
});

it('reentrant abort listeners share one close and one finalization', async () => {
  const lifetime = createLifetime({});
  let finalized = 0;
  lifetime.defer(() => {
    finalized++;
  });
  let nested: ReturnType<typeof lifetime.close> | undefined;
  lifetime.signal.addEventListener('abort', () => {
    nested = lifetime.close();
  });
  const closing = lifetime.close();
  assert.equal(closing, nested);
  assert.equal(await closing, undefined);
  assert.equal(finalized, 1);
});

it('a synchronous close during acquisition still waits for that acquisition and its cleanup', async () => {
  const lifetime = createLifetime({});
  const opened = gate<number>();
  const finalized = gate<void>();
  let settled = false;
  let closing: ReturnType<typeof lifetime.close> | undefined;
  const acquiring = lifetime.acquire(
    resource(
      () => {
        closing = lifetime.close();
        void closing.then(() => {
          settled = true;
        });
        return opened.promise;
      },
      () => finalized.promise,
    ).prepare,
  );
  await Promise.resolve();
  assert.equal(settled, false);
  opened.resolve(42);
  assert(Cancelled.is(await acquiring));
  assert.equal(settled, false);
  finalized.resolve();
  assert.equal(await closing, undefined);
  assert.equal(settled, true);
});

it('late-acquired resources stay open until admitted children settle', async () => {
  const lifetime = createLifetime({});
  const opened = gate<number>();
  const childDone = gate<void>();
  let joined = false;
  let finalized = false;
  lifetime.fork(async () => {
    await childDone.promise;
    joined = true;
  });
  const acquiring = lifetime.acquire(
    resource(
      () => opened.promise,
      () => {
        assert.equal(joined, true);
        finalized = true;
      },
    ).prepare,
  );
  const closing = lifetime.close();
  opened.resolve(42);
  assert(Cancelled.is(await acquiring));
  assert.equal(finalized, false);
  childDone.resolve();
  assert.equal(await closing, undefined);
  assert.equal(finalized, true);
});
