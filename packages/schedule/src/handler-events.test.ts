/**
 * Schedule runs as Dot handler events.
 *
 * Why these tests exist: operators watch `logHandlers()` / `reportErrors()` to see what every
 * transport does. A schedule run must show as `starting` then `completed` or `failed`, owned by
 * the declaring unit, with a refusal (a returned Failure, such as a `with` step refusal) told
 * apart from a bug (a throw). The events only watch: the run is recorded exactly as before.
 */
import { describe, expect, it } from 'vitest';

import type { DotHandlerLifecycleEvent, DotLifecycleEvent } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { defineFailure, orThrow } from '@arki/failure';

import { schedule, schedules } from './dot.js';
import { initSchedule } from './index.js';

const builder = initSchedule.context<undefined>().create();
const Refused = defineFailure('test.schedule.events.refused', { status: 403 });

const isHandlerEvent = (event: DotLifecycleEvent): event is DotHandlerLifecycleEvent => event.kind === 'handler';

const shape = (events: readonly DotHandlerLifecycleEvent[]) =>
  events.map(e => `${e.feature}/${e.name}:${e.status}${e.outcome === undefined ? '' : `/${e.outcome}`}`);

const core = defineFeature('jobsy').needs({}).usecases({});
const feature = core.entrypoints(
  schedules(core, [
    { name: 'tidy', every: '1h', handler: () => 'tidied' },
    { name: 'declined', every: '1h', handler: () => Refused() },
    {
      name: 'broken',
      every: '1h',
      handler: () => {
        throw new Error('boom');
      },
    },
  ]),
);

const driverFeatureCore = defineFeature('plain').needs({}).usecases({});
const driverFeature = driverFeatureCore.entrypoints(
  schedules([builder.define({ name: 'plain-run', every: '1h', handler: () => Promise.resolve('plain') })]),
);

async function boot(withObserver: boolean) {
  const events: DotHandlerLifecycleEvent[] = [];
  const options = withObserver ? { observers: [(e: DotLifecycleEvent) => isHandlerEvent(e) && events.push(e)] } : {};
  const app = await orThrow(
    defineApp('schedule-events', options)
      .features([feature, driverFeature])
      .entrypoints(
        schedule({
          clock: 'host',
          schedules: [
            builder.define({
              name: 'app-level',
              every: '1h',
              with: [() => Refused()],
              handler: () => Promise.resolve('never'),
            }),
          ],
        }),
      )
      .boot(),
  );
  return { app, events };
}

describe('schedule runs emit handler events', () => {
  it('a feature schedule emits starting then completed/ok under its feature name', async () => {
    const { app, events } = await boot(true);
    await expect(app.services.scheduler.trigger('tidy')).resolves.toMatchObject({ status: 'ran', value: 'tidied' });
    expect(shape(events)).toEqual(['jobsy/tidy:starting', 'jobsy/tidy:completed/ok']);
    expect(events[0]).toMatchObject({ transport: 'schedule', appName: 'schedule-events' });
    await orThrow(app.dispose());
  });

  it('a returned Failure is completed/refused and the run is still recorded as refused', async () => {
    const { app, events } = await boot(true);
    await expect(app.services.scheduler.trigger('declined')).resolves.toMatchObject({ status: 'refused' });
    expect(shape(events)).toEqual(['jobsy/declined:starting', 'jobsy/declined:completed/refused']);
    expect(events[1]?.failure).toMatchObject({ code: 'test.schedule.events.refused' });
    await orThrow(app.dispose());
  });

  it('a throw is failed, and the run is still recorded as handler-failed', async () => {
    const { app, events } = await boot(true);
    await expect(app.services.scheduler.trigger('broken')).resolves.toMatchObject({ status: 'handler-failed' });
    expect(shape(events)).toEqual(['jobsy/broken:starting', 'jobsy/broken:failed']);
    expect(events[1]?.error).toEqual(new Error('boom'));
    await orThrow(app.dispose());
  });

  it('a schedule from schedules([...]) emits as the feature that declared it', async () => {
    const { app, events } = await boot(true);
    await app.services.scheduler.trigger('plain-run');
    expect(shape(events)).toEqual(['plain/plain-run:starting', 'plain/plain-run:completed/ok']);
    await orThrow(app.dispose());
  });

  it('an app-level schedule emits as the schedule unit, and a with-step refusal is completed/refused', async () => {
    const { app, events } = await boot(true);
    await expect(app.services.scheduler.trigger('app-level')).resolves.toMatchObject({ status: 'refused' });
    expect(shape(events)).toEqual(['schedule/app-level:starting', 'schedule/app-level:completed/refused']);
    await orThrow(app.dispose());
  });

  it('with no observer the runs are unchanged', async () => {
    const { app, events } = await boot(false);
    await expect(app.services.scheduler.trigger('tidy')).resolves.toMatchObject({ status: 'ran', value: 'tidied' });
    await expect(app.services.scheduler.trigger('declined')).resolves.toMatchObject({ status: 'refused' });
    expect(events).toEqual([]);
    await orThrow(app.dispose());
  });
});
