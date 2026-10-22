/**
 * `$handlers.run(ref, run, outcome)` — the one place a handler call becomes lifecycle events.
 *
 * Why these tests exist: observers key on the event identity (`feature` is the unit's `$unit`, `name`
 * is the transport's entry), so that identity must be exact; a returned Failure is traffic, not a bug,
 * so it must read `completed/refused` and only a throw may read `failed`; the wrapped call must stay
 * invisible (same value, same promise, same rethrown error); and the no-observer path is a performance
 * promise: the call runs and nothing else happens.
 */
import { describe, expect, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';

import type { DotLifecycleEvent, DotLifecycleObserver } from '../lifecycle-observer.js';
import type { DotHandlerObserver } from '../unit-contract.js';
import { defineApp } from '../index.js';
import { infra } from '../unit.js';

const Refused = defineFailure('handler.events.refused');

/** Boot an app whose unit `checkout` hands out its `$handlers`, as a transport adapter would get it. */
const bootWith = async (observers: readonly DotLifecycleObserver[]) => {
  let handlers: DotHandlerObserver | undefined;
  const unit = infra({
    name: 'checkout',
    boot(ctx) {
      handlers = ctx.$handlers;
    },
  });
  const app = orThrow(await defineApp('shop', { observers }).infra(unit).boot());
  if (handlers === undefined) throw new Error('the unit did not boot');
  return { app, handlers };
};

const throwOnHandlerEvent: DotLifecycleObserver = event => {
  if (event.kind === 'handler') throw new Error('observer broke');
};

const handlerEvents = (events: readonly DotLifecycleEvent[]) => events.filter(event => event.kind === 'handler');

describe('$handlers.run', () => {
  it('emits starting then completed with the unit as feature, the ref as identity and a duration', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);
    events.length = 0;

    expect(handlers.run({ transport: 'job', name: 'send-receipt' }, () => 42)).toBe(42);

    const [starting, completed] = handlerEvents(events);
    expect(starting).toMatchObject({
      kind: 'handler',
      status: 'starting',
      transport: 'job',
      feature: 'checkout',
      name: 'send-receipt',
      appName: 'shop',
    });
    expect(completed).toMatchObject({ status: 'completed', outcome: 'ok', feature: 'checkout', name: 'send-receipt' });
    expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
    expect(handlerEvents(events)).toHaveLength(2);
  });

  it('reads a returned Failure as completed/refused and carries the failure', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);
    const refusal = Refused();

    expect(handlers.run({ transport: 'http', name: 'POST /pay' }, () => refusal)).toBe(refusal);

    expect(handlerEvents(events).at(-1)).toMatchObject({ status: 'completed', outcome: 'refused', failure: refusal });
  });

  it('reads a throw as failed with the error, and rethrows the same error', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);
    const boom = new Error('db down');

    expect(() =>
      handlers.run({ transport: 'schedule', name: 'nightly' }, () => {
        throw boom;
      }),
    ).toThrow(boom);

    expect(handlerEvents(events).at(-1)).toMatchObject({ status: 'failed', error: boom });
  });

  it('lets outcome.thrown turn a throw into a refusal, still rethrowing it', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);
    const refusal = Refused();
    const thrown = new Error('client error');

    expect(() =>
      handlers.run(
        { transport: 'rpc', name: 'a.b' },
        () => {
          throw thrown;
        },
        { thrown: error => (error === thrown ? { failure: refusal } : undefined) },
      ),
    ).toThrow(thrown);

    expect(handlerEvents(events).at(-1)).toMatchObject({ status: 'completed', outcome: 'refused', failure: refusal });
  });

  // A transport whose refusals are not Failures on the wire (an HTTP Response) must still report the Failure.
  it('lets outcome.returned name the Failure a returned value stands for, and returns the value unchanged', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);
    const refusal = Refused();
    const response = { status: 401 };
    const returned = (value: unknown) => (value === response ? refusal : undefined);

    expect(handlers.run({ transport: 'http', name: 'GET /me' }, () => response, { returned })).toBe(response);
    await handlers.run({ transport: 'http', name: 'GET /ok' }, () => Promise.resolve({ status: 200 }), { returned });

    expect(handlerEvents(events).filter(event => event.status === 'completed')).toMatchObject([
      { name: 'GET /me', outcome: 'refused', failure: refusal },
      { name: 'GET /ok', outcome: 'ok' },
    ]);
  });

  // A hot path asks before it builds what it would hand to `run`; observers can arrive after boot.
  it('says whether anyone is watching, per call', async () => {
    const quiet = await bootWith([]);
    expect(quiet.handlers.watching()).toBe(false);
    const seen: DotLifecycleEvent[] = [];
    const unsubscribe = quiet.app.subscribe(event => seen.push(event));
    expect(quiet.handlers.watching()).toBe(true);
    unsubscribe();
    expect(quiet.handlers.watching()).toBe(false);
  });

  it('returns the very promise run() returned and emits when it settles', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([event => events.push(event)]);

    const pending = Promise.resolve('done');
    const returned = handlers.run({ transport: 'job', name: 'async-ok' }, () => pending);
    expect(returned).toBe(pending);
    expect(await returned).toBe('done');
    expect(handlerEvents(events).at(-1)).toMatchObject({ status: 'completed', outcome: 'ok', name: 'async-ok' });

    const boom = new Error('late');
    const rejected = Promise.reject(boom);
    const returnedRejection = handlers.run({ transport: 'job', name: 'async-fail' }, () => rejected);
    expect(returnedRejection).toBe(rejected);
    await expect(returnedRejection).rejects.toBe(boom);
    expect(handlerEvents(events).at(-1)).toMatchObject({ status: 'failed', error: boom, name: 'async-fail' });

    const refusal = Refused();
    expect(await handlers.run({ transport: 'job', name: 'async-refused' }, () => Promise.resolve(refusal))).toBe(
      refusal,
    );
    expect(handlerEvents(events).at(-1)).toMatchObject({ outcome: 'refused', failure: refusal });
  });

  it('with no observer, still runs the call, returns its value and emits nothing', async () => {
    const { handlers, app } = await bootWith([]);
    let calls = 0;

    const value = { id: 1 };
    expect(
      handlers.run({ transport: 'job', name: 'quiet' }, () => {
        calls += 1;
        return value;
      }),
    ).toBe(value);
    expect(calls).toBe(1);

    // An observer that arrives later sees only later calls.
    const events: DotLifecycleEvent[] = [];
    app.subscribe(event => events.push(event));
    handlers.run({ transport: 'job', name: 'watched' }, () => 1);
    expect(handlerEvents(events).map(event => event.name)).toEqual(['watched', 'watched']);
  });

  it('isolates an observer that throws: siblings still see the events and the call is unharmed', async () => {
    const events: DotLifecycleEvent[] = [];
    const { handlers } = await bootWith([throwOnHandlerEvent, event => events.push(event)]);

    expect(handlers.run({ transport: 'job', name: 'safe' }, () => 'ok')).toBe('ok');

    expect(handlerEvents(events).map(event => event.status)).toEqual(['starting', 'completed']);
  });
});
