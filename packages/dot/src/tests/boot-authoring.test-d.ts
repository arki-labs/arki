/** A void boot annotation can erase returned failures; authoring must retain exact outcomes. */
import { expectTypeOf } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type {
  EmptyShape,
  UnitCloseFailure,
  UnitOpenFailure,
  UnitPhaseFailures,
  Provided,
} from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { defineFeature, entrypoint, feature, plug } from '../feature.js';
import { initUnits } from '../init-units.js';
import { createUnit, infra, rename, service } from '../unit-contract.js';
import { testApp, testUnit } from '../test-harness.js';

const Refused = defineFailure('test.boot_authoring.refused');
const CloseRefused = defineFailure('test.boot_authoring.close');
const factory = initUnits.context<{ count: number }>().create();
const boot = () => Promise.resolve(Refused());
const _forms = {
  direct: infra({ name: 'direct', boot }),
  constructed: createUnit({ name: 'constructed', boot }),
  object: plug(feature('object', { boot })),
  keys: factory.infra({ name: 'keys', boot }),
  witness: factory.infra({ name: 'witness', needs: { count: service<number>() }, boot }),
};
expectTypeOf<UnitOpenFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<FailureOf<typeof Refused>>();
expectTypeOf<UnitCloseFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<never>();
expectTypeOf<UnitPhaseFailures<(typeof _forms)[keyof typeof _forms]>['start']>().toEqualTypeOf<never>();

const _empty = {
  direct: infra({
    name: 'empty',
    boot() {
      /* Empty boot must infer undefined. */
    },
  }),
  constructed: createUnit({
    name: 'empty',
    async boot() {
      await Promise.resolve();
    },
  }),
  object: plug(
    feature('empty', {
      async boot() {
        await Promise.resolve();
      },
    }),
  ),
  keys: factory.infra({
    name: 'empty',
    async boot() {
      await Promise.resolve();
    },
  }),
  witness: factory.infra({
    name: 'empty',
    needs: {},
    boot() {
      /* Empty boot must infer undefined. */
    },
  }),
};
expectTypeOf<UnitOpenFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
const _mixed = {
  direct: infra({
    name: 'mixed',
    async boot() {
      await Promise.resolve();
    },
    start: () => Refused(),
  }),
  constructed: createUnit({
    name: 'mixed',
    boot() {
      /* Empty boot must infer undefined. */
    },
    start: () => Refused(),
  }),
  object: plug(
    feature('mixed', {
      boot() {
        /* Empty boot must infer undefined. */
      },
      start: () => Refused(),
    }),
  ),
  keys: factory.infra({
    name: 'mixed',
    boot() {
      /* Empty boot must infer undefined. */
    },
    start: () => Refused(),
  }),
  witness: factory.infra({
    name: 'mixed',
    needs: {},
    async boot() {
      await Promise.resolve();
    },
    start: () => Refused(),
  }),
};
expectTypeOf<UnitOpenFailure<(typeof _mixed)[keyof typeof _mixed]>>().toEqualTypeOf<never>();
expectTypeOf<UnitPhaseFailures<(typeof _mixed)[keyof typeof _mixed]>['start']>().toEqualTypeOf<
  FailureOf<typeof Refused>
>();

const _owned = infra({
  name: 'owned',
  needs: { count: service<number>() },
  provides: {
    db: ({ count }) =>
      resource(
        () => ({ count }),
        () => CloseRefused(),
      ),
  },
  boot({ db, count, $signal }) {
    expectTypeOf(db.count).toEqualTypeOf<number>();
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf($signal).toEqualTypeOf<AbortSignal>();
    return { tidy: cleanup(() => CloseRefused()) };
  },
});
expectTypeOf<UnitOpenFailure<typeof _owned>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<typeof _owned>>().toEqualTypeOf<FailureOf<typeof CloseRefused>>();
expectTypeOf<Provided<typeof _owned.provides.db>>().toEqualTypeOf<{ count: number }>();

// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const hidden: () => void = () => Refused();
const hiddenAsync: () => Promise<void> = () => Promise.resolve(hidden());
// @ts-expect-error void hides the actual returned failure
infra({ name: 'hidden', boot: hidden });
// @ts-expect-error Promise<void> hides the actual returned failure
infra({ name: 'hidden', boot: hiddenAsync });
// @ts-expect-error void hides the actual returned failure
createUnit({ name: 'hidden', boot: hidden });
// @ts-expect-error Promise<void> hides the actual returned failure
createUnit({ name: 'hidden', boot: hiddenAsync });
// @ts-expect-error void hides the actual returned failure
feature('hidden', { boot: hidden });
// @ts-expect-error Promise<void> hides the actual returned failure
feature('hidden', { boot: hiddenAsync });
// @ts-expect-error void hides the actual returned failure
factory.infra({ name: 'hidden', boot: hidden });
// @ts-expect-error Promise<void> hides the actual returned failure
factory.infra({ name: 'hidden', boot: hiddenAsync });
// @ts-expect-error void hides the actual returned failure
factory.infra({ name: 'hidden', needs: {}, boot: hidden });
// @ts-expect-error Promise<void> hides the actual returned failure
factory.infra({ name: 'hidden', needs: {}, boot: hiddenAsync });
// @ts-expect-error partial explicit generics cannot restore permissive void inference
infra<EmptyShape>({ name: 'hidden', boot: hidden });
// @ts-expect-error partial explicit generics cannot restore permissive void inference
feature<'hidden'>('hidden', { boot: hiddenAsync });
// @ts-expect-error partial explicit generics cannot restore permissive void inference
factory.infra<readonly []>({ name: 'hidden', boot: hidden });

// No factory may erase the refusal it actually returns behind void.
// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const erasedProvider: () => void = () => Refused();
// @ts-expect-error A provider's value and failure channels must remain visible.
infra({ name: 'void-provider', provides: { value: erasedProvider } });

// Replaced callbacks are the sole source of provider and boot ownership.
const Original = defineFailure('test.boot_authoring.original');
const base = infra({
  name: 'source',
  provides: { count: (): number | FailureOf<typeof Original> => Original() },
  boot: () => Original(),
});
const replaced = { ...base, factories: { count: () => 1 }, hooks: { boot: () => Refused() } };
expectTypeOf<UnitOpenFailure<typeof replaced>>().toEqualTypeOf<FailureOf<typeof Refused>>();
expectTypeOf<UnitCloseFailure<typeof replaced>>().toEqualTypeOf<never>();
const _renamedSource = rename(replaced, { count: 'total' });
expectTypeOf<UnitOpenFailure<typeof _renamedSource>>().toEqualTypeOf<FailureOf<typeof Refused>>();
const _providerReplacement = {
  ...infra({ name: 'source', provides: { count: () => 1 } }),
  factories: { count: () => Refused() },
};
expectTypeOf<UnitOpenFailure<typeof _providerReplacement>>().toEqualTypeOf<FailureOf<typeof Refused>>();
const _featureReplacement = plug({
  ...feature('source', {
    provides: { count: (): number | FailureOf<typeof Original> => Original() },
    boot: () => Original(),
  }),
  factories: { count: () => 1 },
  boot: () => Refused(),
});
expectTypeOf<UnitOpenFailure<typeof _featureReplacement>>().toEqualTypeOf<FailureOf<typeof Refused>>();
const _keysReplacement = {
  ...factory.infra({ name: 'source', boot: () => Original() }),
  hooks: { boot: () => Refused() },
};
expectTypeOf<UnitOpenFailure<typeof _keysReplacement>>().toEqualTypeOf<FailureOf<typeof Refused>>();

const _replacedOwnership = {
  ...infra({
    name: 'ownership',
    provides: {
      value: () =>
        resource(
          () => 1,
          () => Original(),
        ),
    },
    boot: () => ({ private: cleanup(() => Original()) }),
  }),
  factories: {
    value: () =>
      resource(
        () => 2,
        () => CloseRefused(),
      ),
  },
  hooks: { boot: () => ({ private: cleanup(() => Refused()) }) },
};
expectTypeOf<UnitOpenFailure<typeof _replacedOwnership>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<typeof _replacedOwnership>>().toEqualTypeOf<
  FailureOf<typeof CloseRefused> | FailureOf<typeof Refused>
>();

// Handles keep their original service contract across all mount forms.
const _serviceSource = infra({ name: 'service-source', provides: { value: () => 42 } });
const _badService = { ..._serviceSource, factories: { value: () => 'text' } };
// @ts-expect-error replacement success no longer satisfies the original number handle
defineApp('bad-use').infra(_badService);
// @ts-expect-error tuple registration validates the same contract
defineApp('bad-all').infra(_badService);
// @ts-expect-error infrastructure registration validates the same contract
defineApp('bad-infra').infra(_badService);
// @ts-expect-error a driver cannot change the service behind its handles
defineApp('bad-serve').entrypoints(_badService);
// @ts-expect-error variadic driving registration validates the same contract
defineApp('bad-entrypoints').entrypoints(_badService);
// @ts-expect-error bound driving adapters retain their factory contract
defineApp('bad-driver').entrypoints(entrypoint.fromFeatures(() => _badService));
// @ts-expect-error bound driven adapters retain their factory contract
defineApp('bad-driven').infra(infra.fromFeatures(() => _badService));
// @ts-expect-error testing helpers retain the production mount checks
testApp([_badService]);
const _badServiceList = [_badService];
// @ts-expect-error dynamic test arrays still know their elements' original handles
testApp(_badServiceList);
// @ts-expect-error rename must preserve the original local factory contract
defineApp('bad-rename').infra(rename(_badService, { value: 'renamed' }));
const _renamedServiceSource = rename(_serviceSource, { value: 'renamed' });
// @ts-expect-error replacements after rename retain the original local contract
defineApp('bad-renamed-replacement').infra({ ..._renamedServiceSource, factories: { value: () => 'text' } });
// @ts-expect-error removed factories cannot leave old handles behind
defineApp('missing-factory').infra({ ..._serviceSource, factories: {} });
// @ts-expect-error new factory keys have no minted handles
defineApp('extra-factory').infra({ ..._serviceSource, factories: { value: () => 42, extra: () => 1 } });
const _objectSource = feature('object-source', { provides: { value: () => 42 } });
// @ts-expect-error object features preserve the original factory contract
defineApp('bad-object').features([{ ..._objectSource, factories: { value: () => 'text' } }]);
const _qualifiedBad = defineFeature('parent.child').infra(_badService).usecases({}).entrypoints();
// @ts-expect-error qualification must preserve the original local factory contract
defineApp('bad-qualified').features([_qualifiedBad]);
const _remappedBad = defineFeature('parent').features(_qualifiedBad).usecases({}).entrypoints();
// @ts-expect-error child remapping must preserve the original local factory contract
defineApp('bad-remapped').features([_remappedBad]);

const _fallibleService = {
  ..._serviceSource,
  factories: { value: (): number | FailureOf<typeof Refused> => Refused() },
};
defineApp('new-provider-failure').infra(_fallibleService);
defineApp('always-failed-provider').infra({ ..._serviceSource, factories: { value: () => Refused() } });
defineApp('same-provider-value').infra({ ..._serviceSource, factories: { value: () => 17 } });
defineApp('narrower-provider-value').infra({ ..._serviceSource, factories: { value: (): 17 => 17 } });
defineApp('renamed-provider-failure').infra(rename(_fallibleService, { value: 'renamed' }));
expectTypeOf<UnitOpenFailure<typeof _fallibleService>>().toEqualTypeOf<FailureOf<typeof Refused>>();

// The focused harness uses the same live callback contracts as app mounting.
const _harness = testUnit(_forms.direct);
expectTypeOf<Extract<FailureOf<typeof _harness.boot>, FailureOf<typeof Refused>>>().toEqualTypeOf<
  FailureOf<typeof Refused>
>();
const _harnessOriginal = infra({ name: 'harness', provides: { value: () => 42 } });
// @ts-expect-error A test cannot replace a number factory with a string behind the original handle.
testUnit({ ..._harnessOriginal, factories: { value: () => 'changed' } });

// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const erasedBoot: () => void = () => Refused();
const opaqueBoot: () => unknown = () => Refused();
const _erasedBootUnit = { ..._harnessOriginal, hooks: { boot: erasedBoot } };
// @ts-expect-error A spread replacement cannot erase its returned refusal at app mounting.
defineApp('erased-boot').infra(_erasedBootUnit);
// @ts-expect-error A focused test must keep the same boot contract as production.
testUnit(_erasedBootUnit);
// @ts-expect-error A list mount cannot hide an opaque replacement boot.
testApp([{ ..._harnessOriginal, hooks: { boot: opaqueBoot } }]);
// @ts-expect-error Malformed plans cannot cross the mount boundary through a spread replacement.
defineApp('malformed-boot').infra({ ..._harnessOriginal, hooks: { boot: () => ({ task: () => Refused() }) } });
declare const chooseValid: boolean;
const _maybeErasedBoot = chooseValid ? _harnessOriginal : _erasedBootUnit;
// @ts-expect-error One valid branch must not erase the invalid branch's source diagnostic.
defineApp('union-boot').infra(_maybeErasedBoot);

const _unionHooks: { start: () => undefined } | { boot: typeof erasedBoot } = chooseValid
  ? {
      start: () => {
        /* The successful branch contributes no phase failure. */
      },
    }
  : { boot: erasedBoot };
// @ts-expect-error A hook union cannot hide its invalid boot branch behind absent keys.
defineApp('nested-union-boot').infra({ ..._harnessOriginal, hooks: _unionHooks });
const _phaseHooks: { stop: () => undefined } | { start: typeof Refused } = chooseValid
  ? {
      stop: () => {
        /* The successful branch contributes no phase failure. */
      },
    }
  : { start: Refused };
expectTypeOf<UnitPhaseFailures<{ hooks: typeof _phaseHooks }>['start']>().toEqualTypeOf<FailureOf<typeof Refused>>();
const _unionFactories: { first: () => number } | { second: typeof Refused } = chooseValid
  ? { first: () => 1 }
  : { second: Refused };
// @ts-expect-error Disjoint factory branches still add keys to an originally empty provider.
defineApp('nested-union-factories').infra({ ...infra({ name: 'empty-contract' }), factories: _unionFactories });
