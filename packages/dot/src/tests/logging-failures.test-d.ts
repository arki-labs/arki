/** The actual logging factory determines activation and close failures, including replacements. */
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { EmptyShape, UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { initUnits } from '../init-units.js';
import { createUnit, infra, rename } from '../unit-contract.js';

const Open = defineFailure('test.logging_types.open');
const Close = defineFailure('test.logging_types.close');
const Replacement = defineFailure('test.logging_types.replacement');
const branch = (): boolean => false;
const logging = () => (branch() ? Open() : { close: () => Promise.resolve(branch() ? Close() : undefined) });
const factory = initUnits.context<EmptyShape>().create();
const _forms = {
  direct: infra({ name: 'logger', logging }),
  constructor: createUnit({ name: 'logger', logging }),
  keys: factory.infra({ name: 'logger', logging }),
  witness: factory.infra({ name: 'logger', needs: {}, logging }),
};
expectTypeOf<UnitOpenFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<UnitCloseFailure<(typeof _forms)[keyof typeof _forms]>>().toEqualTypeOf<FailureOf<typeof Close>>();
const _app = defineApp('logger').infra(_forms.direct);
expectTypeOf<Extract<FailureOf<typeof _app.boot>, FailureOf<typeof Open>>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<Extract<FailureOf<typeof _app.boot>, FailureOf<typeof Close>>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<
  Extract<FailureOf<SuccessOf<typeof _app.boot>['dispose']>, FailureOf<typeof Open>>
>().toEqualTypeOf<never>();
expectTypeOf<Extract<FailureOf<SuccessOf<typeof _app.boot>['dispose']>, FailureOf<typeof Close>>>().toEqualTypeOf<
  FailureOf<typeof Close>
>();

const _empty = {
  direct: infra({
    name: 'logger',
    logging: () => ({
      close() {
        /* Context proves undefined. */
      },
    }),
  }),
  constructor: createUnit({
    name: 'logger',
    logging: () => ({
      async close() {
        await Promise.resolve();
      },
    }),
  }),
  keys: factory.infra({
    name: 'logger',
    logging: () => ({
      async close() {
        await Promise.resolve();
      },
    }),
  }),
  witness: factory.infra({
    name: 'logger',
    needs: {},
    logging: () => ({
      close() {
        /* Context proves undefined. */
      },
    }),
  }),
};
expectTypeOf<UnitOpenFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<(typeof _empty)[keyof typeof _empty]>>().toEqualTypeOf<never>();
const _mixed = infra({
  name: 'logger',
  logging: () => ({
    async close() {
      await Promise.resolve();
    },
  }),
  start: () => Open(),
});
expectTypeOf<UnitOpenFailure<typeof _mixed>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<typeof _mixed>>().toEqualTypeOf<never>();
const _overridden = { ..._forms.direct, logging: () => ({ close: () => Replacement() }) };
expectTypeOf<UnitOpenFailure<typeof _overridden>>().toEqualTypeOf<never>();
expectTypeOf<UnitCloseFailure<typeof _overridden>>().toEqualTypeOf<FailureOf<typeof Replacement>>();
const _renamed = rename(_overridden, {}, 'renamed');
expectTypeOf<UnitCloseFailure<typeof _renamed>>().toEqualTypeOf<FailureOf<typeof Replacement>>();
const _overrideApp = defineApp('override').infra(_overridden);
expectTypeOf<
  Extract<FailureOf<typeof _overrideApp.boot>, FailureOf<typeof Open> | FailureOf<typeof Close>>
>().toEqualTypeOf<never>();

// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const hidden: () => void = () => Close();
const hiddenAsync: () => Promise<void> = () => Promise.resolve(hidden());
const unknownFactory = (): unknown => Open();
const unknownClose = (): unknown => Close();
// @ts-expect-error erased activation output cannot own a logging lifetime
infra({ name: 'hidden', logging: hidden });
// @ts-expect-error unknown activation output cannot own a logging lifetime
infra({ name: 'unknown', logging: unknownFactory });
// @ts-expect-error void hides a close failure
infra({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error Promise<void> hides a close failure
infra({ name: 'hidden', logging: () => ({ close: hiddenAsync }) });
// @ts-expect-error unknown hides a close failure
infra({ name: 'hidden', logging: () => ({ close: unknownClose }) });
// @ts-expect-error void hides a close failure
createUnit({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error void hides a close failure
factory.infra({ name: 'hidden', logging: () => ({ close: hidden }) });
// @ts-expect-error Promise<void> hides a close failure
factory.infra({ name: 'hidden', needs: {}, logging: () => ({ close: hiddenAsync }) });
// @ts-expect-error explicit wiring generics cannot allow erased close results
infra<EmptyShape>({ name: 'hidden', logging: () => ({ close: hidden }) });
