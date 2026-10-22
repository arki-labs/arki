/**
 * Schedules of a `feature.instance('eu', rebind)` copy.
 *
 * Why these tests exist: two copies of one feature declare the same schedule
 * name. If both kept it, the scheduler would run one of them for both names
 * and the two copies would share one lock. An instance therefore registers
 * `<name>#<instance>`, while a plain feature keeps its exact name, because
 * live lock keys are hashed from it and must never move.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { defineApp, infra, rename } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import type { ScheduleNameOf } from './dot.js';
import type { Locker } from './index.js';
import { schedule, schedules } from './dot.js';

type Region = { readonly region: string };
const regionDb = (region: string) => infra({ name: 'database', provides: { db: (): Region => ({ region }) } });
const database = regionDb('us');
const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'databaseEu');

/** A locker that records the key of every mutex it is asked for. */
function recordingLocker() {
  const keys: string[] = [];
  const locker: Locker = {
    mutex: key => {
      keys.push(key);
      return {
        tryRun: fn => Promise.resolve(fn({ signal: new AbortController().signal, fence: undefined })),
      };
    },
  };
  return { keys, locker };
}

function build(lock: true | string | undefined) {
  const { keys, locker } = recordingLocker();
  const lockUnit = infra({ name: 'locks', provides: { locks: () => locker } });
  // The scheduler takes the lock around the run; no handler uses it, so it is entrypoint-only.
  const base = defineFeature('reports')
    .needs({ db: database.provides.db, locks: entrypointOnly(lockUnit.provides.locks) })
    .usecases({
      region:
        ({ db }) =>
        () =>
          db.region,
    });
  const reports = base.entrypoints(
    schedules(base, [
      {
        name: 'send-digest',
        every: '1h',
        ...(lock === undefined ? {} : { lock }),
        handler: ({ usecases }) => usecases.region(),
      },
    ]),
  );
  const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
  const us = reports.instance('us');
  const instances = defineApp('instances')
    .infra(database, databaseEu, lockUnit)
    .features([eu, us])
    .entrypoints(schedule({ clock: 'host' }));
  const plain = defineApp('plain')
    .infra(database, lockUnit)
    .features([reports])
    .entrypoints(schedule({ clock: 'host' }));
  return { keys, instances, plain, reports };
}

describe('feature instance schedules', () => {
  it('registers one schedule per instance, and a trigger runs only that instance', async () => {
    const app = await orThrow(build(undefined).instances.start());
    expect(app.services.scheduler.names).toEqual(['send-digest#eu', 'send-digest#us']);
    await expect(app.services.scheduler.trigger('send-digest#eu')).resolves.toEqual({
      name: 'send-digest#eu',
      status: 'ran',
      value: 'eu',
    });
    await expect(app.services.scheduler.trigger('send-digest#us')).resolves.toMatchObject({ value: 'us' });
    await expect(app.services.scheduler.trigger('send-digest')).resolves.toEqual({
      name: 'send-digest',
      status: 'unknown',
    });
    await orThrow(app.dispose());
  });

  it('types an instance trigger name as `<name>#<instance>` and a plain one as `<name>`', () => {
    const { reports } = build(undefined);
    expectTypeOf<ScheduleNameOf<[typeof reports]>>().toEqualTypeOf<'send-digest'>();
    expectTypeOf<ScheduleNameOf<[ReturnType<typeof reports.instance<'eu'>>]>>().toEqualTypeOf<'send-digest#eu'>();
  });

  it('gives each instance its own default lock key', async () => {
    const { keys, instances } = build(true);
    const app = await orThrow(instances.start());
    await app.services.scheduler.trigger('send-digest#eu');
    await app.services.scheduler.trigger('send-digest#us');
    expect(keys).toEqual(['send-digest#eu', 'send-digest#us']);
    await orThrow(app.dispose());
  });

  it('keeps a custom lock key shared by both instances', async () => {
    const { keys, instances } = build('shared');
    const app = await orThrow(instances.start());
    await app.services.scheduler.trigger('send-digest#eu');
    await app.services.scheduler.trigger('send-digest#us');
    expect(keys).toEqual(['shared', 'shared']);
    await orThrow(app.dispose());
  });

  it('names the manifest actions of each instance under its own plugin', async () => {
    const app = await orThrow(build(true).instances.start());
    const fires = app.manifest.actions.filter(action => action.binding === 'schedule');
    expect(fires.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'reports#eu:send-digest.fire',
      'reports#us:send-digest.fire',
    ]);
    await orThrow(app.dispose());
  });

  it('leaves a plain feature byte-identical: name, action id and default lock key', async () => {
    const { keys, plain } = build(true);
    const app = await orThrow(plain.start());
    expect(app.services.scheduler.names).toEqual(['send-digest']);
    expect(app.manifest.actions.map(action => action.id)).toContain('send-digest.fire');
    await app.services.scheduler.trigger('send-digest');
    expect(keys).toEqual(['send-digest']);
    await orThrow(app.dispose());
  });
});
