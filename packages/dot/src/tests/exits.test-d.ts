/**
 * The exits' types (RFC 2026-10-22-dot-usecase-boundary D7 and D8, plan C1 and C2).
 *
 * Why these assertions exist: a `provides` factory and an entrypoint are the
 * feature's exits. Every cross-feature call and every request must go through
 * a usecase, so it is traced and supervised. A `provides` factory therefore
 * sees only the usecases, and an entrypoint sees only the usecases and the
 * `entrypointOnly` needs (the gateway's `db` for a transaction). Infra, plain
 * needs, children and domain services stay below the usecases. A change that
 * widens either exit again fails here before it fails an app.
 */
import { expectTypeOf } from 'vitest';

import type { DepsOf, EntrypointOnlyNeeds, EntrypointServices, ProvidesDeps, requestServices } from '../feature.js';
import type { KernelCtx, Provided } from '../unit-contract.js';
import { defineFeature, domainService, entrypointOnly } from '../feature.js';
import { infra } from '../index.js';

/** One object type out of an intersection, so an exact equality compares keys and values, not intersection shape. */
type Flat<T> = { [K in keyof T]: T[K] };

type Mailer = { readonly send: (to: string) => boolean };
type Db = { readonly query: (sql: string) => number };
type Repos = { readonly byId: (id: string) => string };

const mail = infra({ name: 'mail', provides: { mailer: (): Mailer => ({ send: to => to.length > 0 }) } });
const database = infra({ name: 'database', provides: { db: (): Db => ({ query: sql => sql.length }) } });
const store = infra({ name: 'store', provides: { repos: (): Repos => ({ byId: id => id }) } });

const extras = ({ repos }: { readonly repos: Repos }) => ({ label: repos.byId('x') });

const child = defineFeature('shop.child')
  .needs({ extras: domainService(extras) })
  .usecases({
    seen:
      ({ extras: built }) =>
      () =>
        built.label,
  })
  .provides({ childSeen: ({ usecases }) => usecases.seen })
  .entrypoints();

const needs = { mailer: mail.provides.mailer, db: entrypointOnly(database.provides.db) };
const shopUsecases = {
  find:
    ({ repos }: { readonly repos: Repos }) =>
    (id: string) =>
      repos.byId(id),
};
const logic = defineFeature('shop')
  .needs(needs)
  .infra(store)
  .domainServices({ extras })
  .features(child)
  .usecases(shopUsecases);
type ShopUsecases = { readonly find: ReturnType<typeof shopUsecases.find> };
/** The supervised usecases, as the chain built them. */
type ShopValues = DepsOf<typeof logic>['usecases'];

// (1) A provides factory receives exactly the usecases.
expectTypeOf<Flat<ProvidesDeps<ShopUsecases>>>().toEqualTypeOf<{ readonly usecases: ShopValues }>();
logic.provides({
  probe: deps => {
    expectTypeOf<Flat<typeof deps>>().toEqualTypeOf<Flat<ProvidesDeps<ShopUsecases> & KernelCtx>>();
    return deps.usecases.find;
  },
});

// (2) It cannot read infra, a plain need, an entrypoint-only need, a domain service or a child's provide.
// @ts-expect-error -- TS2339: `repos` (infra) is not in what a provides factory receives
logic.provides({ x: ({ repos }) => repos });
// @ts-expect-error -- TS2339: `mailer` (a plain need) is not either
logic.provides({ x: ({ mailer }) => mailer });
// @ts-expect-error -- TS2339: nor `db`, though entrypoints see it
logic.provides({ x: ({ db }) => db });
// @ts-expect-error -- TS2339: nor a domain service
logic.provides({ x: ({ extras: built }) => built });
// @ts-expect-error -- TS2339: nor a child's provide
logic.provides({ x: ({ childSeen }) => childSeen });

// (3) Entrypoints receive the entrypoint-only needs and the usecases, nothing else.
expectTypeOf<keyof EntrypointOnlyNeeds<typeof needs>>().toEqualTypeOf<'db'>();
type Services = EntrypointServices<typeof needs, ShopUsecases>;
expectTypeOf<Flat<Services>>().toEqualTypeOf<{ db: Db; readonly usecases: ShopValues }>();
expectTypeOf<Flat<DepsOf<typeof logic>>>().toEqualTypeOf<Flat<Services>>();

// (4) `<shop>.services` (what `bind(logic)` hands a request) is typed the same.
const _shop = logic.entrypoints();
type Published = Provided<ReturnType<typeof requestServices<readonly [typeof _shop]>>['provides']['shop.services']>;
expectTypeOf<Flat<Published>>().toEqualTypeOf<Flat<Services>>();

// (5) `handles` (what `bind(logic)` types a handler's context from) has only `db` and `usecases`.
expectTypeOf<keyof typeof logic.handles>().toEqualTypeOf<'db' | 'usecases'>();
