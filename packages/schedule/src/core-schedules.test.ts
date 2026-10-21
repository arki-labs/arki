/**
 * `schedules(core, defs)` — schedules of a `defineFeature` feature.
 *
 * Why these tests exist: a schedules file sits next to the feature, not in
 * it, so its handlers must be typed from the core alone (no annotation, no
 * restated deps) and must run on the feature's own private infra and
 * usecases. And one scheduler and one typed client must serve an app that
 * mounts several features.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DepsOf } from '@arki/dot/feature';
import type { SuccessOf } from '@arki/failure';
import { defineFeature } from '@arki/dot/feature';
import { defineApp, infra, service } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import { composeSchedules, schedule, schedules } from './dot.js';

type Ledger = { readonly close: () => string };

const database = infra({ name: 'database', provides: { db: () => ({ rows: 3 }) } });

/** infra/: private to the feature; only its usecases and entrypoints see it. */
const outbox = infra({
  name: 'outbox',
  needs: { db: database.provides.db },
  provides: { outbox: ({ db }) => ({ pending: () => db.rows }) },
});

/** The feature names the database the outbox binds; a bound infra need must match the feature's own. */
const base = defineFeature('digest').needs({ db: database.provides.db }).infra(outbox);
const core = base.usecases({
  sendDue:
    ({ outbox }: DepsOf<typeof base>) =>
    () =>
      `sent ${outbox.pending()}`,
});

/** entrypoints/schedules.ts: takes the core as a typed parameter (`import type` in a real app). */
const digestSchedules = (c: typeof core) =>
  schedules(c, [{ name: 'send-digest', cron: '*/15 * * * *', handler: ({ usecases }) => usecases.sendDue() }]);

const digest = core.entrypoints(digestSchedules(core));

/** A second feature with only a need and no private infra, mounted next to it. */
const ledgerNeeds = { ledger: service<Ledger>() };
const billingCore = defineFeature('billing').needs(ledgerNeeds).usecases({});
const billing = billingCore.entrypoints(
  schedules(billingCore, [{ name: 'close-books', every: '1h', handler: ({ ledger }) => ledger.close() }]),
);

const boot = () =>
  defineApp('mixed')
    .infra(database, infra({ name: 'ledger', provides: { ledger: (): Ledger => ({ close: () => 'closed' }) } }))
    .features([digest, billing])
    .entrypoints(schedule({ clock: 'host' }))
    .start();

describe('schedules(core, defs)', () => {
  it('types each handler from the core: usecases and private infra yes, anything else no', () => {
    schedules(core, [
      {
        name: 'typed',
        every: '1m',
        handler: services => {
          expectTypeOf<SuccessOf<typeof services.usecases.sendDue>>().toEqualTypeOf<string>();
          expectTypeOf(services.outbox.pending).returns.toEqualTypeOf<number>();
          return null;
        },
      },
    ]);
    // @ts-expect-error -- `ledger` belongs to another feature, not to this core
    schedules(core, [{ name: 'leaky', every: '1m', handler: ({ ledger }) => ledger }]);
    expect(true).toBe(true);
  });

  it("runs the handler on the feature's private infra and usecases, next to another feature", async () => {
    const app = await orThrow(boot());
    await expect(app.services.scheduler.trigger('send-digest')).resolves.toEqual({
      name: 'send-digest',
      status: 'ran',
      value: 'sent 3',
    });
    await expect(app.services.scheduler.trigger('close-books')).resolves.toMatchObject({ value: 'closed' });
    await orThrow(app.dispose());
  });

  it('puts the schedule in the manifest under the feature, before anything runs', async () => {
    const app = await orThrow(boot());
    expect(app.manifest.actions.find(action => action.id === 'send-digest.fire')).toMatchObject({
      binding: 'schedule',
      address: '*/15 * * * *',
      plugin: 'digest',
    });
    await orThrow(app.dispose());
  });
});

describe('composeSchedules over several features', () => {
  it("accepts every feature's names and types each result from its own handler", async () => {
    const app = await orThrow(boot());
    const client = composeSchedules([digest, billing], app.services.scheduler);
    const sent = await client.trigger('send-digest');
    const closed = await client.trigger('close-books');
    if (sent.status === 'ran') expectTypeOf(orThrow(sent.value)).toEqualTypeOf<string>();
    if (closed.status === 'ran') expectTypeOf(closed.value).toEqualTypeOf<string>();
    expect([sent, closed]).toMatchObject([
      { status: 'ran', value: 'sent 3' },
      { status: 'ran', value: 'closed' },
    ]);
    // @ts-expect-error -- no feature declares this name
    void client.trigger('nope');
    await orThrow(app.dispose());
  });
});

/** `digest.cleanup`: a child with its own schedule, mounted through its parent only. */
const purged = (): string => 'purged';
const cleanupCore = defineFeature('digest.cleanup').usecases({ purge: () => purged });
const cleanup = cleanupCore.entrypoints(
  schedules(cleanupCore, [{ name: 'purge-old', every: '1h', handler: ({ usecases }) => usecases.purge() }]),
);
const parentCore = defineFeature('digest')
  .needs({ db: database.provides.db })
  .infra(outbox)
  .features(cleanup)
  .usecases({
    sendDue:
      ({ outbox }: DepsOf<typeof base>) =>
      () =>
        `sent ${outbox.pending()}`,
  });
const parent = parentCore.entrypoints(
  schedules(parentCore, [{ name: 'send-digest', cron: '*/15 * * * *', handler: ({ usecases }) => usecases.sendDue() }]),
);

const bootNested = () =>
  defineApp('nested')
    .infra(database)
    .features([parent])
    .entrypoints(schedule({ clock: 'host' }))
    .start();

describe('nested features', () => {
  it("runs the child's schedule once, under the child's name in the manifest", async () => {
    const app = await orThrow(bootNested());
    expect(app.services.scheduler.names.filter(name => name === 'purge-old')).toEqual(['purge-old']);
    expect(app.manifest.actions.find(action => action.id === 'purge-old.fire')).toMatchObject({
      binding: 'schedule',
      plugin: 'digest.cleanup',
    });
    await expect(app.services.scheduler.trigger('purge-old')).resolves.toMatchObject({ value: 'purged' });
    await orThrow(app.dispose());
  });

  it('composeSchedules over the parent alone knows the child names, typed from the child handler', async () => {
    const app = await orThrow(bootNested());
    const client = composeSchedules([parent], app.services.scheduler);
    const purged = await client.trigger('purge-old');
    if (purged.status === 'ran') expectTypeOf(orThrow(purged.value)).toEqualTypeOf<string>();
    expect(purged).toMatchObject({ status: 'ran', value: 'purged' });
    await expect(client.trigger('send-digest')).resolves.toMatchObject({ value: 'sent 3' });
    // @ts-expect-error -- no feature in the tree declares this name
    void client.trigger('nope');
    await orThrow(app.dispose());
  });
});
