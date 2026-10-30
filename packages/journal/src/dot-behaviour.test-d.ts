/**
 * A behaviour module (D-9), typed end to end: the feature file mounts the reaction with
 * `journalHandlers(core, …)`, and the reaction file (`dot-behaviour-reaction.test-d.ts`) is a
 * plain value that imports the feature's `Deps` as a type only, so there is no import cycle.
 *
 * Why these types matter: `needsOf` is the only place a reaction names its deps. It must refuse what a
 * reaction may never see (an `entrypointOnly` need, or the entrypoints' view after `.usecases()`), and
 * the handler must see exactly what it picked, typed from the feature, with no type argument written.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { DepsOf, EntrypointServicesOf } from '@arki/dot/feature';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';

import type { Need } from './types.js';
import { sendReceipt } from './dot-behaviour-reaction.test-d.js';
import { journalHandlers, needsOf } from './dot.js';

/** What the reaction talks to. */
export type Mailer = { readonly sendReceipt: (orderId: string) => Promise<void> };
type Pricing = { readonly total: () => number };

const database = infra({ name: 'db', provides: { db: () => ({ url: 'pg://types' }) } });
const mailer = infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ sendReceipt: () => Promise.resolve() }) } });

/** feature.ts: the core a reaction file types itself against. */
export const core = defineFeature('orders')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(mailer)
  .domainServices({ pricing: (): Pricing => ({ total: () => 1 }) });

/** What a reaction may ask for: the stage before `.usecases()`, as `feature.ts` exports it. */
export type Deps = DepsOf<typeof core>;

const logic = core.usecases({ total: ({ pricing }) => () => pricing.total() }, journalHandlers(core, { effects: [sendReceipt] }));

describe('needsOf(select)', () => {
  it('types each picked dep from the feature: private infra and domain services', () => {
    expectTypeOf(needsOf((_: Deps) => ['mailer', 'pricing'])).toEqualTypeOf<{
      readonly mailer: Need<Mailer>;
      readonly pricing: Need<Pricing>;
    }>();
  });

  it('refuses an entrypoint-only need and a dep the feature lacks', () => {
    // @ts-expect-error -- `db` is entrypoint-only: a reaction never sees it
    needsOf((_: Deps) => ['db']);
    // @ts-expect-error -- the feature has no `stripe` need, infra service or domain service
    needsOf((_: Deps) => ['stripe']);
  });

  it('refuses private infra when the selector is annotated with the stage after `.usecases()`', () => {
    // @ts-expect-error -- past `.usecases()` the deps are the entrypoints view: `mailer` is private infra and is not in it
    needsOf((_: DepsOf<typeof logic>) => ['mailer']);
  });
});

describe('journalHandlers(core, …) as an application contribution', () => {
  it('compiles with a reaction file that imports the feature as a type only', () => {
    expectTypeOf(logic.name).toEqualTypeOf<'orders'>();
  });

  it('is not a member of `context.usecases`: entrypoints see the usecase factories only', () => {
    expectTypeOf<keyof EntrypointServicesOf<typeof logic>['usecases']>().toEqualTypeOf<'total'>();
  });

  it('refuses a reaction whose deps the feature lacks', () => {
    const bare = defineFeature('bare');
    // @ts-expect-error -- `bare` does not give `send-receipt` its `mailer`
    journalHandlers(bare, { effects: [sendReceipt] });
  });
});
