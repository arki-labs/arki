/**
 * `reportErrors` and `logHandlers`: the ready-made observers over handler events.
 *
 * Why these tests exist: an error tracker must hear about bugs only (a refusal is normal traffic, and
 * other event kinds are not handler calls), a broken tracker must never break the call it observes, and
 * `logHandlers` is the one place the DEBUG line for a handler call is shaped, so apps can grep it.
 */
import { describe, expect, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';
import { memorySink } from '@arki/log';

import type { DotLifecycleObserver } from '../lifecycle-observer.js';
import type { DotHandlerObserver } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { logHandlers, reportErrors } from '../index.js';
import { log } from '../log.js';
import { infra } from '../unit.js';

const Refused = defineFailure('handler.observers.refused');

const bootWith = async (observers: readonly DotLifecycleObserver[], withLog?: ReturnType<typeof memorySink>) => {
  let handlers: DotHandlerObserver | undefined;
  const unit = infra({
    name: 'checkout',
    boot(ctx) {
      handlers = ctx.$handlers;
    },
  });
  const base = defineApp('shop', { observers });
  const app = orThrow(
    await (
      withLog === undefined
        ? base
        : base.infra(log(() => ({ channels: { mem: withLog }, default: { level: 'debug', channels: ['mem'] } })))
    )
      .infra(unit)
      .boot(),
  );
  if (handlers === undefined) throw new Error('the unit did not boot');
  return { app, handlers };
};

const swallow = (call: () => unknown): void => {
  try {
    call();
  } catch {
    // The throw under test is rethrown by design.
  }
};

describe('reportErrors', () => {
  it('reports a thrown handler with its error and identity, and nothing else', async () => {
    const reported: { error: unknown; ref: unknown }[] = [];
    const { handlers } = await bootWith([reportErrors({ report: (error, ref) => reported.push({ error, ref }) })]);
    const boom = new Error('db down');

    handlers.run({ transport: 'job', name: 'ok' }, () => 1);
    expect(handlers.run({ transport: 'http', name: 'POST /pay' }, () => Refused())).toMatchObject({
      code: 'handler.observers.refused',
    });
    swallow(() =>
      handlers.run({ transport: 'schedule', name: 'nightly' }, () => {
        throw boom;
      }),
    );

    expect(reported).toEqual([{ error: boom, ref: { transport: 'schedule', name: 'nightly', feature: 'checkout' } }]);
  });

  it('ignores a reporter that throws: the call still gets its own error, the failure is logged at warn', async () => {
    const sink = memorySink();
    const { handlers, app } = await bootWith(
      [
        reportErrors({
          report: () => {
            throw new Error('tracker down');
          },
        }),
      ],
      sink,
    );
    const boom = new Error('db down');

    expect(() =>
      handlers.run({ transport: 'job', name: 'sync' }, () => {
        throw boom;
      }),
    ).toThrow(boom);

    orThrow(await app.dispose());
    const warning = sink.records.find(record => record.category === 'arki:dot:handlers' && record.levelName === 'warn');
    expect(warning?.fields).toMatchObject({ transport: 'job', name: 'sync', reportError: 'Error: tracker down' });
  });
});

describe('logHandlers', () => {
  it('logs one DEBUG line per ended call on arki:dot:handlers, the error attached when it failed', async () => {
    const sink = memorySink();
    const { handlers, app } = await bootWith([logHandlers()], sink);
    const boom = new Error('db down');

    handlers.run({ transport: 'rpc', name: 'orders.pay' }, () => 'paid');
    expect(handlers.run({ transport: 'rpc', name: 'orders.pay' }, () => Refused())).toMatchObject({
      code: 'handler.observers.refused',
    });
    swallow(() =>
      handlers.run({ transport: 'job', name: 'sync' }, () => {
        throw boom;
      }),
    );

    orThrow(await app.dispose());
    const lines = sink.records.filter(record => record.category === 'arki:dot:handlers');
    expect(lines.map(line => line.levelName)).toEqual(['debug', 'debug', 'debug']);
    expect(lines.map(line => line.message().replace(/\d+(?:\.\d+)?ms/, '<t>ms'))).toEqual([
      'rpc checkout.orders.pay ok <t>ms',
      'rpc checkout.orders.pay refused <t>ms',
      'job checkout.sync failed <t>ms',
    ]);
    expect(lines[1]?.fields).toMatchObject({ failure: 'handler.observers.refused' });
    expect(lines[2]?.error).toBe(boom);
  });

  it('is opt-in: without it nothing is logged', async () => {
    const sink = memorySink();
    const { handlers, app } = await bootWith([], sink);

    handlers.run({ transport: 'job', name: 'quiet' }, () => 1);

    orThrow(await app.dispose());
    expect(sink.records.filter(record => record.category === 'arki:dot:handlers')).toEqual([]);
  });
});
