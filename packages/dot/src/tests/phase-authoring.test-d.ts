/** Phase failures survive authoring and mounting without entering resource ownership unions. */
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type {
  EmptyPhases,
  EmptyShape,
  PluginCloseFailure,
  PluginOpenFailure,
  PluginPhaseFailures,
  Provided,
  Service,
} from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { bindDriver, driven, driver, feature, plug } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { createPlugin, plugin, rename, service } from '../plugin-contract.js';

const ConfigureRefused = defineFailure('test.phase_authoring.configure');
const StartRefused = defineFailure('test.phase_authoring.start');
const StopRefused = defineFailure('test.phase_authoring.stop');
const DisposeRefused = defineFailure('test.phase_authoring.dispose');
const OpenRefused = defineFailure('test.phase_authoring.open');
const CloseRefused = defineFailure('test.phase_authoring.close');
const branch = (): boolean => false;
const hooks = {
  configure: () => (branch() ? ConfigureRefused() : undefined),
  start: () => Promise.resolve(branch() ? StartRefused() : undefined),
  stop: () => (branch() ? StopRefused() : undefined),
  dispose: () => Promise.resolve(branch() ? DisposeRefused() : undefined),
};
const open = () => (branch() ? OpenRefused() : { value: 1 });
const factories = { db: () => resource(open, () => CloseRefused()) };
const direct = plugin({ name: 'direct', provides: factories, ...hooks });
const object = feature('object', { provides: factories, ...hooks });
const factory = initPlugins.context<{ count: number; db: SuccessOf<typeof open> }>().create();
const _forms = {
  object: plug(object),
  renamed: rename(direct, { db: 'otherDb' }),
  driving: bindDriver(
    driver(() => direct),
    [],
  ),
  driven: driven(() => direct).bind([]),
  keys: factory.plugin({ name: 'keys', needs: ['count'], provides: factories, ...hooks }),
  witness: factory.plugin({ name: 'witness', needs: { count: service<number>() }, provides: factories, ...hooks }),
};
type Phases = PluginPhaseFailures<typeof direct>;
type Forms = typeof _forms;
type PhasesByForm = { [Form in keyof Forms]: PluginPhaseFailures<Forms[Form]> };

expectTypeOf<Phases>().toEqualTypeOf<{
  readonly configure: FailureOf<typeof hooks.configure>;
  readonly start: FailureOf<typeof hooks.start>;
  readonly stop: FailureOf<typeof hooks.stop>;
  readonly dispose: FailureOf<typeof hooks.dispose>;
}>();
expectTypeOf<PhasesByForm>().toEqualTypeOf<{ [Form in keyof Forms]: Phases }>();
expectTypeOf<PluginOpenFailure<Forms[keyof Forms]>>().toEqualTypeOf<FailureOf<typeof open>>();
expectTypeOf<PluginCloseFailure<Forms[keyof Forms]>>().toEqualTypeOf<FailureOf<typeof CloseRefused>>();
expectTypeOf<Provided<typeof object.provides.db>>().toEqualTypeOf<SuccessOf<typeof open>>();

const _empty = plugin({ name: '_empty' });
const _emptyObject = feature('_empty', {});
const _emptyKeys = factory.plugin({ name: '_empty' });
expectTypeOf<
  PluginPhaseFailures<typeof _empty | typeof _emptyObject | typeof _emptyKeys>
>().toEqualTypeOf<EmptyPhases>();

const _contextual = feature('_contextual', {
  needs: { count: service<number>() },
  provides: { total: ({ count }) => count + 1 },
  start({ count, total, $signal }) {
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf(total).toEqualTypeOf<number>();
    expectTypeOf($signal).toEqualTypeOf<AbortSignal>();
    return Promise.resolve(StartRefused());
  },
});
const _contextualKeys = factory.plugin({
  name: '_contextual-keys',
  needs: ['count'],
  provides: { total: ({ count }) => count + 1 },
  dispose({ count, total, $signal }) {
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf(total).toEqualTypeOf<number>();
    expectTypeOf($signal).toEqualTypeOf<AbortSignal>();
    return Promise.resolve(DisposeRefused());
  },
});
expectTypeOf<PluginPhaseFailures<ReturnType<typeof plug<typeof _contextual>>>['start']>().toEqualTypeOf<
  FailureOf<typeof StartRefused>
>();
expectTypeOf<PluginPhaseFailures<typeof _contextualKeys>['dispose']>().toEqualTypeOf<
  FailureOf<typeof DisposeRefused>
>();

const _directApp = defineApp('direct').use(direct);
const _objectApp = defineApp('object').features([object]);
const _drivingApp = defineApp('driving')
  .features([])
  .serve(driver(() => direct));
const _drivenApp = defineApp('driven')
  .use(driven(() => direct))
  .features([]);
expectTypeOf<FailureOf<typeof _objectApp.configure>>().toEqualTypeOf<FailureOf<typeof _directApp.configure>>();
expectTypeOf<FailureOf<typeof _objectApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<typeof _drivingApp.start>>().toEqualTypeOf<FailureOf<typeof _directApp.start>>();
expectTypeOf<FailureOf<typeof _drivenApp.start>>().toEqualTypeOf<FailureOf<typeof _directApp.start>>();
expectTypeOf<FailureOf<SuccessOf<typeof _objectApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<Extract<FailureOf<typeof _directApp.configure>, Phases['configure']>>().toEqualTypeOf<
  Phases['configure']
>();
expectTypeOf<
  Extract<FailureOf<typeof _directApp.boot>, Phases['start'] | Phases['stop'] | Phases['dispose']>
>().toEqualTypeOf<never>();
expectTypeOf<Extract<FailureOf<typeof _directApp.start>, Phases['start']>>().toEqualTypeOf<Phases['start']>();
expectTypeOf<
  Extract<FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>, Phases['stop'] | Phases['dispose']>
>().toEqualTypeOf<Phases['stop'] | Phases['dispose']>();
expectTypeOf<
  Extract<FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>, Phases['configure'] | Phases['start']>
>().toEqualTypeOf<never>();

// Configure cannot silently admit asynchronous work at any authoring seam.
// @ts-expect-error configure is synchronous
feature('async-configure', { configure: () => Promise.resolve(ConfigureRefused()) });
// @ts-expect-error configure is synchronous
factory.plugin({ name: 'async-configure', configure: () => Promise.resolve(ConfigureRefused()) });

// Inline callbacks get an exact undefined context, including when another phase fails.
const _mixedDirect = plugin({
  name: 'mixed',
  configure() {
    /* Prove contextual undefined without an explicit return. */
  },
  async start() {
    await Promise.resolve();
    return StartRefused();
  },
  stop() {
    /* Prove contextual undefined without an explicit return. */
  },
  async dispose() {
    await Promise.resolve();
  },
});
const _mixedObject = feature('mixed-object', {
  configure() {
    /* Prove contextual undefined without an explicit return. */
  },
  async start() {
    await Promise.resolve();
    return StartRefused();
  },
  stop() {
    /* Prove contextual undefined without an explicit return. */
  },
  async dispose() {
    await Promise.resolve();
  },
});
const _mixedKeys = factory.plugin({
  name: 'mixed-keys',
  configure() {
    /* Prove contextual undefined without an explicit return. */
  },
  async start() {
    await Promise.resolve();
    return StartRefused();
  },
  stop() {
    /* Prove contextual undefined without an explicit return. */
  },
  async dispose() {
    await Promise.resolve();
  },
});
const _mixedWitness = factory.plugin({
  name: 'mixed-witness',
  needs: { count: service<number>() },
  configure() {
    /* Prove contextual undefined without an explicit return. */
  },
  async start({ count }) {
    await Promise.resolve();
    expectTypeOf(count).toEqualTypeOf<number>();
    return StartRefused();
  },
  stop() {
    /* Prove contextual undefined without an explicit return. */
  },
  async dispose() {
    await Promise.resolve();
  },
});
expectTypeOf<
  PluginPhaseFailures<typeof _mixedDirect | typeof _mixedKeys | typeof _mixedWitness>['start']
>().toEqualTypeOf<FailureOf<typeof StartRefused>>();
expectTypeOf<PluginPhaseFailures<ReturnType<typeof plug<typeof _mixedObject>>>['start']>().toEqualTypeOf<
  FailureOf<typeof StartRefused>
>();

// Void callbacks can hide actual Failure values, so detached callbacks must prove undefined.
// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const erasedHook: () => void = () => StartRefused();
const erasedPromiseHook: () => Promise<void> = () => Promise.resolve(erasedHook());
// @ts-expect-error a void return hides a failure
plugin({ name: 'erased', start: erasedHook });
// @ts-expect-error a Promise<void> return hides a failure
plugin({ name: 'erased', start: erasedPromiseHook });
// @ts-expect-error a void configure return hides a failure
plugin({ name: 'erased', configure: erasedHook });
// @ts-expect-error a void return hides a failure
createPlugin({ name: 'erased', stop: erasedHook });
// @ts-expect-error a Promise<void> return hides a failure
createPlugin({ name: 'erased', dispose: erasedPromiseHook });
// @ts-expect-error a void return hides a failure
feature('erased', { stop: erasedHook });
// @ts-expect-error a Promise<void> return hides a failure
feature('erased', { dispose: erasedPromiseHook });
// @ts-expect-error a void return hides a failure
factory.plugin({ name: 'erased', stop: erasedHook });
// @ts-expect-error a Promise<void> return hides a failure
factory.plugin({ name: 'erased', dispose: erasedPromiseHook });
// @ts-expect-error a void return hides a failure
factory.plugin({ name: 'erased', needs: { count: service<number>() }, configure: erasedHook });
// @ts-expect-error a Promise<void> return hides a failure
factory.plugin({ name: 'erased', needs: { count: service<number>() }, start: erasedPromiseHook });

// Explicit early generics must not restore TypeScript's permissive contextual void rule.
// eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined prevents void from erasing returned failures.
const configurePromise = () => Promise.resolve<undefined>(undefined);
// @ts-expect-error configure remains synchronous with partial explicit generics
plugin<EmptyShape>({ name: 'partial', configure: configurePromise });
// @ts-expect-error configure remains synchronous with explicit wiring generics
createPlugin<EmptyShape, EmptyShape, 'partial', void>({ name: 'partial', configure: configurePromise });
// @ts-expect-error configure remains synchronous with partial explicit generics
feature<'partial'>('partial', { configure: configurePromise });
// @ts-expect-error configure remains synchronous with partial explicit key-array generics
factory.plugin<readonly []>({ name: 'partial', configure: configurePromise });
factory.plugin<{ count: Service<number> }>({
  name: 'partial',
  needs: { count: service<number>() },
  // @ts-expect-error configure remains synchronous with partial explicit witness generics
  configure: configurePromise,
});

// Hook replacements are the source of both execution and inferred failure types.
const ReplacementRefused = defineFailure('test.phase_authoring.replacement');
const _overridden = { ...direct, hooks: { ...direct.hooks, start: () => ReplacementRefused() } };
expectTypeOf<PluginPhaseFailures<typeof _overridden>['start']>().toEqualTypeOf<FailureOf<typeof ReplacementRefused>>();
const _overriddenApp = defineApp('overridden').use(_overridden);
expectTypeOf<Extract<FailureOf<typeof _overriddenApp.start>, FailureOf<typeof ReplacementRefused>>>().toEqualTypeOf<
  FailureOf<typeof ReplacementRefused>
>();
expectTypeOf<Extract<FailureOf<typeof _overriddenApp.start>, FailureOf<typeof StartRefused>>>().toEqualTypeOf<never>();

const _overriddenDriven = driven(() => _overridden);
const _overriddenDriver = driver(() => _overridden);
const _overriddenDrivenApp = defineApp('driven-override').use(_overriddenDriven);
const _driverApp = defineApp('driver-override').serve(_overriddenDriver);
expectTypeOf<
  Extract<FailureOf<typeof _overriddenDrivenApp.start>, FailureOf<typeof ReplacementRefused>>
>().toEqualTypeOf<FailureOf<typeof ReplacementRefused>>();
expectTypeOf<Extract<FailureOf<typeof _driverApp.start>, FailureOf<typeof ReplacementRefused>>>().toEqualTypeOf<
  FailureOf<typeof ReplacementRefused>
>();
expectTypeOf<Extract<FailureOf<typeof _driverApp.start>, FailureOf<typeof StartRefused>>>().toEqualTypeOf<never>();
