import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { infra, lazy } from '../unit-contract.js';

const OpenRefused = defineFailure('type.ownership_open');
const CloseRefused = defineFailure('type.ownership_close');
const ChildRefused = defineFailure('type.ownership_child');
const branch = false as boolean;
const open = () => (branch ? OpenRefused() : { query: () => 42 });
const close = (_resource: SuccessOf<typeof open>) => (branch ? CloseRefused() : undefined);
const watch = () => (branch ? ChildRefused() : undefined);
const owned = infra({
  name: 'typed',
  provides: { db: () => resource(open, close) },
  boot({ db }) {
    db.query();
    return { watcher: child(watch), flush: cleanup(() => CloseRefused()) };
  },
});
const _boot = () => defineApp('typed').infra(owned).boot();
type App = SuccessOf<typeof _boot>;
expectTypeOf<UnitOpenFailure<typeof owned>>().toEqualTypeOf<FailureOf<typeof open> | FailureOf<typeof watch>>();
expectTypeOf<UnitCloseFailure<typeof owned>>().toEqualTypeOf<FailureOf<typeof close> | FailureOf<typeof watch>>();
expectTypeOf<App['services']['db']>().toEqualTypeOf<SuccessOf<typeof open>>();
expectTypeOf<Extract<FailureOf<App['dispose']>, FailureOf<typeof open>>>().toEqualTypeOf<never>();
expectTypeOf<string extends FailureOf<typeof _boot>['code'] ? true : false>().toEqualTypeOf<false>();
const _lazyOwned = infra({ name: 'lazy', provides: { db: () => lazy(() => 42, { dispose: () => CloseRefused() }) } });
expectTypeOf<Extract<UnitCloseFailure<typeof _lazyOwned>, FailureOf<typeof CloseRefused>>>().toEqualTypeOf<
  FailureOf<typeof CloseRefused>
>();
// @ts-expect-error descriptor cleanup receives a successful resource, never the acquisition refusal.
resource(open, (value: ReturnType<typeof OpenRefused>) => value);
// @ts-expect-error boot return must be an owned descriptor plan or void/refusal.
infra({ name: 'invalid', boot: () => ({ arbitrary: true }) });

// @ts-expect-error an untyped provider cannot hide undeclared returned failures.
infra({ name: 'unknown', provides: { value: (): unknown => OpenRefused() } });
