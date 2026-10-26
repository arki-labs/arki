/**
 * `fromFeatures` takes one declaration, like `infra()` / `entrypoint()`, so a
 * binder carries typed `name` and `provides` handles before any app exists.
 *
 * Why these assertions exist: a feature must be able to need a service of a
 * `fromFeatures` unit by its handle (`entrypointOnly(appJournal.provides.journal)`)
 * instead of restating its type behind a wire-key token. Each key and type is
 * written once, in the declaration's `provides`; these tests fail if a handle
 * loses its type, its key or its provider, or if `$features` / `$state` stop
 * reaching the factories and hooks typed.
 */
import { expectTypeOf } from 'vitest';

import type { SideGuard } from '../define-app.js';
import type { AnyDefinedFeature } from '../define-feature.js';
import type { EntrypointServicesOf } from '../feature.js';
import type { ActionSource, Handle, Provided } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { defineFeature, entrypointOnly } from '../feature.js';
import { entrypoint, infra, service } from '../unit-contract.js';

type Journal = { readonly append: (event: string) => number };

const appJournal = infra.fromFeatures({
  name: 'journal',
  provides: { journal: ({ $features }): Journal => ({ append: event => $features.length + event.length }) },
});

// The binder's name and handles are static and typed, like any unit's.
expectTypeOf(appJournal.name).toEqualTypeOf<'journal'>();
expectTypeOf(appJournal.role).toEqualTypeOf<'infra'>();
expectTypeOf(appJournal.provides.journal).toEqualTypeOf<Handle<Journal, 'journal', 'journal'>>();
expectTypeOf<Provided<typeof appJournal.provides.journal>>().toEqualTypeOf<Journal>();

// A feature needs it by handle, plainly or entrypoint-only.
const writer = defineFeature('writer')
  .needs({ journal: appJournal.provides.journal })
  .usecases({ write: ({ journal }: { readonly journal: Journal }) => journal.append('written') })
  .entrypoints();
const _gatewayFeature = defineFeature('gateway').needs({ journal: entrypointOnly(appJournal.provides.journal) });
expectTypeOf<EntrypointServicesOf<typeof _gatewayFeature>['journal']>().toEqualTypeOf<Journal>();

defineApp('mounted').infra(appJournal).features([writer]);
// @ts-expect-error writer needs the journal, which nothing mounts before it
defineApp('unmounted').features([writer]);

// `$features` and `$state` reach every factory and hook, typed from `state()`.
const _counting = entrypoint.fromFeatures({
  name: 'counting',
  needs: { journal: appJournal.provides.journal },
  state: () => ({ boots: 0 }),
  actions: features => {
    expectTypeOf(features).toEqualTypeOf<readonly AnyDefinedFeature[]>();
    return [];
  },
  configure(ctx) {
    expectTypeOf(ctx.$features).toEqualTypeOf<readonly AnyDefinedFeature[]>();
    expectTypeOf(ctx.$state).toEqualTypeOf<{ boots: number }>();
  },
  provides: {
    counted: ({ journal, $features, $state }) => {
      expectTypeOf(journal).toEqualTypeOf<Journal>();
      expectTypeOf($state).toEqualTypeOf<{ boots: number }>();
      return $features.length;
    },
  },
  boot({ counted, $state }) {
    expectTypeOf(counted).toEqualTypeOf<number>();
    $state.boots += 1;
  },
  start({ $features, $state, $app }) {
    expectTypeOf($features).toEqualTypeOf<readonly AnyDefinedFeature[]>();
    expectTypeOf($state).toEqualTypeOf<{ boots: number }>();
    expectTypeOf($app).toEqualTypeOf<string>();
  },
});
expectTypeOf(_counting.provides.counted).toEqualTypeOf<Handle<number, 'counted', 'counting'>>();

// No `state`: `$state` is `undefined`.
infra.fromFeatures({
  name: 'stateless',
  stop({ $state }) {
    expectTypeOf($state).toEqualTypeOf<undefined>();
  },
});

// `actions` may also be a plain list.
entrypoint.fromFeatures({ name: 'listed', actions: [] satisfies readonly ActionSource[] });

// `$features` and `$state` belong to the kernel: no need or published key may take them.
// @ts-expect-error `$`-prefixed need aliases are reserved
infra.fromFeatures({ name: 'shadow-need', needs: { $features: service<number>() } });
// @ts-expect-error `$`-prefixed publish keys are reserved
infra.fromFeatures({ name: 'shadow-key', provides: { $state: () => 1 } });

// A binder on the wrong side is named in the diagnostic by its real name.
const worker = entrypoint.fromFeatures({ name: 'worker' });
expectTypeOf<SideGuard<[typeof worker], 'entrypoint'>>().toEqualTypeOf<{
  readonly 'DOT: an entrypoint cannot be mounted as infra. Mount it with .entrypoints(...)': 'worker';
}>();
// @ts-expect-error an entrypoint binder cannot be mounted as infra
defineApp('wrong-side').infra(worker);
