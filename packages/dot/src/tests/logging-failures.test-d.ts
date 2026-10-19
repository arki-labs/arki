/** The actual logging factory determines activation and close failures, including replacements. */
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { EmptyShape, PluginCloseFailure, PluginOpenFailure } from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { initPlugins } from '../init-plugins.js';
import { createPlugin, plugin, rename } from '../plugin-contract.js';

const Open = defineFailure('test.logging_types.open');
const Close = defineFailure('test.logging_types.close');
const Replacement = defineFailure('test.logging_types.replacement');
const branch = (): boolean => false;
const logging = () => (branch() ? Open() : { close: () => Promise.resolve(branch() ? Close() : undefined) });
const factory = initPlugins.context<EmptyShape>().create();
const _forms = {
  direct: plugin({ name: 'logger', logging }),
  constructor: createPlugin({ name: 'logger', logging }),
  keys: factory.plugin({ name: 'logger', logging }),
  witness: factory.plugin({ name: 'logger', needs: {}, logging }),
};
expectTypeOf<PluginOpenFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<PluginCloseFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<FailureOf<typeof Close>>();
const _app = defineApp('logger').use(_forms.direct);
expectTypeOf<Extract<FailureOf<typeof _app.boot>, FailureOf<typeof Open>>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<Extract<FailureOf<typeof _app.boot>, FailureOf<typeof Close>>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<
  Extract<FailureOf<SuccessOf<typeof _app.boot>['dispose']>, FailureOf<typeof Open>>
>().toEqualTypeOf<never>();
expectTypeOf<Extract<FailureOf<SuccessOf<typeof _app.boot>['dispose']>, FailureOf<typeof Close>>>().toEqualTypeOf<
  FailureOf<typeof Close>
>();

const _empty = {
  direct: plugin({
    name: 'logger',
    logging: () => ({
      close() {
        /* Context proves undefined. */
      },
    }),
  }),
  constructor: createPlugin({
    name: 'logger',
    logging: () => ({
      async close() {
        await Promise.resolve();
      },
    }),
  }),
  keys: factory.plugin({
    name: 'logger',
    logging: () => ({
      async close() {
        await Promise.resolve();
      },
    }),
  }),
  witness: factory.plugin({
    name: 'logger',
    needs: {},
    logging: () => ({
      close() {
        /* Context proves undefined. */
      },
    }),
  }),
};
expectTypeOf<PluginOpenFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
expectTypeOf<PluginCloseFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
const _mixed = plugin({
  name: 'logger',
  logging: () => ({
    async close() {
      await Promise.resolve();
    },
  }),
  start: () => Open(),
});
expectTypeOf<PluginOpenFailure<typeof _mixed>>().toEqualTypeOf<never>();
expectTypeOf<PluginCloseFailure<typeof _mixed>>().toEqualTypeOf<never>();
const _overridden = { ..._forms.direct, logging: () => ({ close: () => Replacement() }) };
expectTypeOf<PluginOpenFailure<typeof _overridden>>().toEqualTypeOf<never>();
expectTypeOf<PluginCloseFailure<typeof _overridden>>().toEqualTypeOf<FailureOf<typeof Replacement>>();
const _renamed = rename(_overridden, {}, 'renamed');
expectTypeOf<PluginCloseFailure<typeof _renamed>>().toEqualTypeOf<FailureOf<typeof Replacement>>();
const _overrideApp = defineApp('override').use(_overridden);
expectTypeOf<
  Extract<FailureOf<typeof _overrideApp.boot>, FailureOf<typeof Open> | FailureOf<typeof Close>>
>().toEqualTypeOf<never>();

const hidden: () => void = () => Close();
const hiddenAsync: () => Promise<void> = () => Promise.resolve(hidden());
const unknownFactory = (): unknown => Open();
const unknownClose = (): unknown => Close();
// @ts-expect-error erased activation output cannot own a logging lifetime
plugin({ name: 'hidden', logging: hidden });
// @ts-expect-error unknown activation output cannot own a logging lifetime
plugin({ name: 'unknown', logging: unknownFactory });
// @ts-expect-error void hides a close failure
plugin({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error Promise<void> hides a close failure
plugin({ name: 'hidden', logging: () => ({ close: hiddenAsync }) });
// @ts-expect-error unknown hides a close failure
plugin({ name: 'hidden', logging: () => ({ close: unknownClose }) });
// @ts-expect-error void hides a close failure
createPlugin({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error void hides a close failure
factory.plugin({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error Promise<void> hides a close failure
factory.plugin({ name: 'hidden', needs: {}, logging: () => ({ close: hiddenAsync }) });
// @ts-expect-error explicit wiring generics cannot allow erased close results
plugin<EmptyShape>({ name: 'hidden', logging: () => ({ close: hidden }) });
