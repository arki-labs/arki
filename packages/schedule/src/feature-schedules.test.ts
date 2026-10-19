/**
 * Feature-owned schedules (`schedules(needs, defs)`), the host clock, the
 * `scheduler` service and the typed `composeSchedules` client.
 *
 * The founder rule these tests guard: every type is written once. The
 * handler's services come from `needs`, the trigger names and result
 * types come from the declarations — no caller restates any of them.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { feature } from '@arki/dot/feature';
import { defineApp, plugin, service } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';

import type { ScheduleClock, ScheduleService } from './dot.js';
import { composeSchedules, DurableSchedules, schedule, schedules } from './dot.js';
import { defineSchedule, SCHEDULE_ERROR_CODES, ScheduleError } from './index.js';
import { createScheduleRuntime } from './runtime.js';

type Mailer = { readonly send: (to: string) => Promise<number> };
type Ledger = { readonly close: () => string };

const mailerNeeds = { mailer: service<Mailer>() };
const ledgerNeeds = { ledger: service<Ledger>() };

const digest = feature('digest', {
  needs: mailerNeeds,
  use: [
    schedules(mailerNeeds, [{ name: 'send-digest', every: '1m', handler: ({ mailer }) => mailer.send('subscribers') }]),
  ],
});

const billing = feature('billing', {
  needs: ledgerNeeds,
  use: [schedules(ledgerNeeds, [{ name: 'close-books', cron: '* * * * *', handler: ({ ledger }) => ledger.close() }])],
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve: () => resolve() };
}

/** An app whose two features each get their OWN service, recorded per call. */
async function bootApp(clock: ScheduleClock) {
  const calls: string[] = [];
  const mailer: Mailer = {
    send: to => {
      calls.push(`mailer:${to}`);
      return Promise.resolve(calls.length);
    },
  };
  const ledger: Ledger = {
    close: () => {
      calls.push('ledger:close');
      return 'closed';
    },
  };
  const app = await orThrow(
    defineApp('digest-app')
      .use(plugin({ name: 'mailer', provides: { mailer: () => mailer } }))
      .use(plugin({ name: 'ledger', provides: { ledger: () => ledger } }))
      .features([digest, billing])
      .serve(schedule({ clock }))
      .boot(),
  );
  return { app, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('schedules(needs, defs) — feature-owned schedules', () => {
  // The point of the form: a schedule is part of its feature and works with
  // that feature's services, not with one app-wide context.
  it("runs each handler with its own feature's services", async () => {
    const { app, calls } = await bootApp('host');

    await expect(app.services.scheduler.trigger('send-digest')).resolves.toEqual({
      name: 'send-digest',
      status: 'ran',
      value: 1,
    });
    await expect(app.services.scheduler.trigger('close-books')).resolves.toEqual({
      name: 'close-books',
      status: 'ran',
      value: 'closed',
    });
    expect(calls).toEqual(['mailer:subscribers', 'ledger:close']);
    await orThrow(app.dispose());
  });

  it('joins the feature manifest at declaration, like schedules(defs)', async () => {
    const { app } = await bootApp('host');

    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'digest:send-digest.fire',
      'billing:close-books.fire',
    ]);
    await orThrow(app.dispose());
  });

  it('types the handler parameter from needs, with no annotation', () => {
    schedules(mailerNeeds, [
      {
        name: 'typed',
        every: '1h',
        handler: services => {
          expectTypeOf(services.mailer).toEqualTypeOf<Mailer>();
        },
      },
    ]);
  });

  it('rejects, at compile time, a schedule whose needs the feature does not declare', () => {
    feature('forgetful', {
      // @ts-expect-error the schedule needs `mailer`, which this feature's `needs` does not list.
      use: [schedules(mailerNeeds, [{ name: 'orphan', every: '1h', handler: ({ mailer }) => mailer.send('x') }])],
    });
    // Control: the same slice compiles once the feature declares the need.
    feature('declared', {
      needs: mailerNeeds,
      use: [schedules(mailerNeeds, [{ name: 'orphan', every: '1h', handler: ({ mailer }) => mailer.send('x') }])],
    });
  });

  // A durable tick runs in another process that does not hold these services.
  it('refuses durable: true in the type and with a coded error at declaration', () => {
    try {
      schedules(mailerNeeds, [
        // @ts-expect-error feature-owned schedules cannot be durable.
        { name: 'durable-digest', every: '1h', durable: true, handler: ({ mailer }) => mailer.send('x') },
      ]);
      throw new Error('Expected schedules() to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleError);
      expect((error as ScheduleError).code).toBe(SCHEDULE_ERROR_CODES.durableFeatureSchedule);
      expect((error as ScheduleError).message).toContain('"durable-digest"');
    }
  });

  it('validates cron and every at declaration, like defineSchedule', () => {
    expect(() =>
      schedules(mailerNeeds, [{ name: 'bad', cron: 'not a cron', handler: ({ mailer }) => mailer.send('x') }]),
    ).toThrow(expect.objectContaining({ code: SCHEDULE_ERROR_CODES.invalidDefinition }));
  });
});

describe("schedule({ clock: 'host' })", () => {
  it('fires nothing on its own; each trigger runs the schedule once', async () => {
    vi.useFakeTimers();
    const { app, calls } = await bootApp('host');
    await orThrow(app.start());

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual([]);

    await app.services.scheduler.trigger('send-digest');
    expect(calls).toEqual(['mailer:subscribers']);
    await orThrow(app.stop());
    await orThrow(app.dispose());
  });

  // Control for the test above: the same app on the internal clock does fire,
  // so "0 runs" really comes from the host clock and not from the fake timers.
  it('the internal clock fires the same schedules on its timers', async () => {
    vi.useFakeTimers();
    const { app, calls } = await bootApp('internal');
    await orThrow(app.start());

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls.filter(call => call === 'mailer:subscribers').length).toBeGreaterThanOrEqual(4);
    await orThrow(app.stop());
    await orThrow(app.dispose());
  });

  it('publishes the clock and every schedule name on the scheduler service', async () => {
    const { app } = await bootApp('host');

    expect(app.services.scheduler.clock).toBe('host');
    expect(app.services.scheduler.names).toEqual(['send-digest', 'close-books']);
    await orThrow(app.dispose());
  });

  // Two clocks would fire the same tick twice.
  it('fails boot with a coded error for a durable schedule', async () => {
    const nightly = defineSchedule({
      name: 'nightly',
      cron: '0 3 * * *',
      durable: true,
      handler: () => Promise.resolve(),
    });

    await expect(
      defineApp('host-durable')
        .serve(schedule({ clock: 'host', schedules: [nightly] }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: SCHEDULE_ERROR_CODES.durableWithHostClock },
    });
  });

  it('fails boot with a coded error for a durable backend', async () => {
    const backend = plugin({
      name: 'durable-backend',
      provides: { [DurableSchedules.key]: () => ({ start: () => Promise.resolve(), stop: () => Promise.resolve() }) },
    });

    await expect(
      defineApp('host-backend')
        .use(backend)
        .serve(schedule({ clock: 'host', durable: DurableSchedules }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { code: SCHEDULE_ERROR_CODES.durableWithHostClock },
    });
  });

  it('a bare runtime refuses the same combination at construction', () => {
    const nightly = defineSchedule({
      name: 'nightly',
      cron: '0 3 * * *',
      durable: true,
      handler: () => Promise.resolve(),
    });

    expect(() => createScheduleRuntime({ schedules: [nightly], clock: 'host' })).toThrow(
      expect.objectContaining({ code: SCHEDULE_ERROR_CODES.durableWithHostClock }),
    );
  });
});

describe('the scheduler service', () => {
  it('is typed on the app with no annotation', async () => {
    const { app } = await bootApp('host');

    expectTypeOf(app.services.scheduler).toEqualTypeOf<ScheduleService>();
    await orThrow(app.dispose());
  });

  it('keeps the failure cause on handler-failed', async () => {
    const boom = new Error('mail server down');
    const failing = feature('failing', {
      use: [
        schedules({}, [
          {
            name: 'fails',
            every: '1h',
            handler: () => {
              throw boom;
            },
          },
        ]),
      ],
    });
    const app = await orThrow(
      defineApp('failing-app')
        .features([failing])
        .serve(schedule({ clock: 'host' }))
        .boot(),
    );

    const outcome = await app.services.scheduler.trigger('fails');
    expect(outcome).toEqual({ name: 'fails', status: 'handler-failed', cause: boom });
    expect(outcome.status === 'handler-failed' && outcome.cause).toBe(boom);
    await orThrow(app.dispose());
  });

  it('reports unknown for a name it does not run, instead of throwing', async () => {
    const { app } = await bootApp('host');

    await expect(app.services.scheduler.trigger('nope')).resolves.toEqual({ name: 'nope', status: 'unknown' });
    await orThrow(app.dispose());
  });

  it('runs before start (the runtime is built at boot)', async () => {
    const { app, calls } = await bootApp('host');

    await expect(app.services.scheduler.trigger('close-books')).resolves.toMatchObject({ status: 'ran' });
    expect(calls).toEqual(['ledger:close']);
    await orThrow(app.dispose());
  });

  it('refuses triggers after stop as unavailable', async () => {
    const { app, calls } = await bootApp('host');
    await orThrow(app.start());
    await orThrow(app.stop());

    await expect(app.services.scheduler.trigger('send-digest')).resolves.toEqual({
      name: 'send-digest',
      status: 'unavailable',
    });
    expect(calls).toEqual([]);
    await orThrow(app.dispose());
  });

  // Stop drains accepted runs and refuses new ones, so a late host trigger
  // cannot start work on services that are being torn down.
  it('drains an accepted run on stop while refusing new triggers', async () => {
    const gate = deferred();
    const calls: string[] = [];
    const slow = defineSchedule({
      name: 'slow',
      every: '1h',
      handler: async () => {
        calls.push('started');
        await gate.promise;
        calls.push('finished');
        return 'done';
      },
    });
    const runtime = createScheduleRuntime({ schedules: [slow], clock: 'host' });
    runtime.start();

    const accepted = runtime.trigger('slow');
    await Promise.resolve();
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await expect(runtime.trigger('slow')).resolves.toEqual({ name: 'slow', status: 'unavailable' });
    expect(stopped).toBe(false);
    gate.resolve();

    await expect(accepted).resolves.toEqual({ name: 'slow', status: 'ran', value: 'done' });
    await stopping;
    expect(calls).toEqual(['started', 'finished']);
  });
});

describe('overlap', () => {
  // Regression: run() used to read the running count, then await the lock,
  // then reserve the slot — two triggers in the same tick both passed.
  it('two simultaneous triggers of an overlap: skip schedule run the handler once', async () => {
    const gate = deferred();
    let runs = 0;
    const slow = defineSchedule({
      name: 'slow',
      every: '1h',
      handler: async () => {
        runs += 1;
        await gate.promise;
      },
    });
    const runtime = createScheduleRuntime({ schedules: [slow] });

    const both = Promise.all([runtime.trigger('slow'), runtime.trigger('slow')]);
    await Promise.resolve();
    gate.resolve();

    const results = await both;
    expect(results.map(result => result.status).toSorted()).toEqual(['ran', 'skipped-overlap']);
    expect(runs).toBe(1);
  });
});

describe('composeSchedules', () => {
  it('triggers by declared name and types the ran value from the handler', async () => {
    const { app } = await bootApp('host');
    const client = composeSchedules([digest, billing], app.services.scheduler);

    const sent = await client.trigger('send-digest');
    const closed = await client.trigger('close-books');
    expect(sent).toEqual({ name: 'send-digest', status: 'ran', value: 1 });
    expect(closed).toEqual({ name: 'close-books', status: 'ran', value: 'closed' });
    if (sent.status === 'ran') expectTypeOf(sent.value).toEqualTypeOf<number>();
    if (closed.status === 'ran') expectTypeOf(closed.value).toEqualTypeOf<string>();

    // @ts-expect-error no feature declares a schedule named "nope".
    await expect(client.trigger('nope')).resolves.toEqual({ name: 'nope', status: 'unknown' });
    await orThrow(app.dispose());
  });

  it('throws a coded error when the scheduler does not run a declared schedule', async () => {
    const app = await orThrow(
      defineApp('no-features')
        .serve(schedule({ clock: 'host' }))
        .boot(),
    );

    expect(() => composeSchedules([digest], app.services.scheduler)).toThrow(
      expect.objectContaining({ code: SCHEDULE_ERROR_CODES.scheduleNotServed }),
    );
    await orThrow(app.dispose());
  });
});
