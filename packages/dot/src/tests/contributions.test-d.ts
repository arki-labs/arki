/**
 * Types of `.usecases(factories, ...contributions)`: a contribution binds to the usecase deps, the
 * same record a usecase factory sees, and never becomes a usecase handle.
 */
import { describe, expectTypeOf, it } from 'vitest';

import type { ApplicationContribution, EntrypointServicesOf } from '../feature.js';
import { defineFeature, entrypointOnly } from '../feature.js';
import { infra } from '../unit-contract.js';

type Mailer = { readonly send: (to: string) => string };
type Db = { readonly url: string };

const database = infra({ name: 'db', provides: { db: (): Db => ({ url: 'pg://test' }) } });
const mailer = infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ send: to => to }) } });

const needsMailer: ApplicationContribution<{ readonly mailer: Mailer }> = { kind: 'k', key: 'k', bind: () => 1 };
const needsDb: ApplicationContribution<{ readonly db: Db }> = { kind: 'k', key: 'k', bind: () => 1 };

describe('a contribution', () => {
  it('binds when the feature has what it needs', () => {
    const logic = defineFeature('orders').infra(mailer).usecases({ total: () => () => 1 }, needsMailer);
    expectTypeOf(logic.name).toEqualTypeOf<'orders'>();
  });

  it('is refused when the feature lacks a dep it needs', () => {
    // @ts-expect-error -- `bare` has no `mailer` need, infra service or domain service
    defineFeature('bare').usecases({}, needsMailer);
  });

  it('is refused when the dep it needs is entrypoint-only', () => {
    // @ts-expect-error -- `db` is entrypoint-only: usecases and contributions never see it
    defineFeature('door').needs({ db: entrypointOnly(database.provides.db) }).usecases({}, needsDb);
  });

  it('is not a usecase handle: entrypoints see the factories only', () => {
    const logic = defineFeature('orders').infra(mailer).usecases({ total: () => () => 1 }, needsMailer);
    expectTypeOf(logic).toHaveProperty('entrypoints');
    expectTypeOf<keyof EntrypointServicesOf<typeof logic>['usecases']>().toEqualTypeOf<'total'>();
  });

  it('is not an entrypoint: an entrypoint descriptor does not fit the slot', () => {
    const asEntrypoint = { kind: 'k', key: 'k', actions: [], resolve: () => 1 };
    // @ts-expect-error -- an entrypoint has `resolve`, not `bind`
    defineFeature('mixed').usecases({}, asEntrypoint);
  });
});
