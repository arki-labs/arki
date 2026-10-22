/**
 * `.domainServices()` types (RFC 2026-10-22-dot-usecase-boundary, plan B5).
 *
 * Why these assertions exist: a domain service sits between the infra and the
 * usecases. A factory sees only what is declared above it (`DomainDeps`), the
 * usecases and children see its value, and `provides` and entrypoints never
 * do. Each case below locks one side of that boundary at compile time, so a
 * change that leaks a domain service out (or lets a factory reach below
 * itself) fails here before it fails an app.
 */
import { expectTypeOf } from 'vitest';

import { resource } from '@arki/async';
import { UnexpectedDefect } from '@arki/failure';

import type { ChildProvides, DepsOf } from '../feature.js';
import type { UnitNeeds } from '../unit-contract.js';
import { defineFeature, domainService, entrypointOnly } from '../feature.js';
import { defineApp, infra } from '../index.js';

/** One object type out of an intersection, so an exact equality compares keys and values, not intersection shape. */
type Flat<T> = { [K in keyof T]: T[K] };

type Mailer = { readonly send: (to: string) => boolean };
type Db = { readonly query: (sql: string) => number };
type Repos = { readonly find: (id: string) => string };

const mail = infra({ name: 'mail', provides: { mailer: (): Mailer => ({ send: to => to.length > 0 }) } });
const database = infra({ name: 'database', provides: { db: (): Db => ({ query: sql => sql.length }) } });
const store = infra({ name: 'store', provides: { repos: (): Repos => ({ find: id => id }) } });

class ExtrasService {
  constructor(readonly repos: Repos) {}
}
const extras = ({ repos }: { readonly repos: Repos }) => new ExtrasService(repos);

const base = defineFeature('shop')
  .needs({ mailer: mail.provides.mailer, db: entrypointOnly(database.provides.db) })
  .infra(store);
type DomainDeps = DepsOf<typeof base>;

const child = defineFeature('shop.child')
  .needs({ extras: domainService(extras) })
  .usecases({
    seen:
      ({ extras }) =>
      () =>
        extras,
  })
  .provides({ childSeen: ({ usecases }) => usecases.seen })
  .entrypoints();

const withServices = base.domainServices({ extras }).features(child);
type Deps = DepsOf<typeof withServices>;

// (1) A domain-service factory sees the usecase-visible needs and the infra: an entrypoint-only `db` is not there.
expectTypeOf<Flat<DomainDeps>>().toEqualTypeOf<{ mailer: Mailer; repos: Repos }>();

// (2) The usecases see DomainDeps, the domain services by key and the children's provides.
expectTypeOf<Flat<Deps>>().toEqualTypeOf<
  Flat<DomainDeps & { readonly extras: ExtrasService } & ChildProvides<readonly [typeof child]>>
>();

const closed: string[] = [];
// (3) The value a reader sees: the plain value of a sync or async factory, a `resource()` opened.
const _values = defineFeature('values').domainServices({
  sync: () => ({ n: 1 }),
  later: () => Promise.resolve({ s: 'x' }),
  opened: () =>
    resource(
      () => ({ open: true }),
      () => closed.push('close'),
    ),
});
expectTypeOf<Flat<DepsOf<typeof _values>>>().toEqualTypeOf<{
  readonly sync: { n: number };
  readonly later: { s: string };
  readonly opened: { open: boolean };
}>();
// A factory that can fail is refused: a build step that can fail is an adapter in `.infra()`.
// @ts-expect-error -- a domain service factory cannot fail
defineFeature('failing').domainServices({ broken: () => UnexpectedDefect({ cause: 'no I/O at construction' }) });

// (4) `provides` never sees a domain service.
withServices
  .usecases({})
  // @ts-expect-error -- `extras` is not in what a provides factory receives
  .provides({ x: ({ extras }) => extras });

// (5) Neither do entrypoints: what they and `provides` receive after `.usecases()` has no `extras`.
const _logic = withServices.usecases({
  read:
    ({ extras }) =>
    () =>
      extras,
});
expectTypeOf<'extras' extends keyof DepsOf<typeof _logic> ? true : false>().toEqualTypeOf<false>();

// (6) A factory sees only the stage above it: not itself, not a peer in the same call.
const selfPick = ({ extras: own }: { readonly extras: ExtrasService }) => own;
const peerPick = ({ selfish }: { readonly selfish: ExtrasService }) => selfish;
// @ts-expect-error -- `selfish` asks for itself
base.domainServices({ selfish: selfPick });
// @ts-expect-error -- `peer` asks for `selfish`, a peer in the same call
base.domainServices({ selfish: extras, peer: peerPick });

// (7) A child may need only a domain service its parent declares above `.features()`.
const elsewhere = () => ({ other: true });
const stray = defineFeature('shop.stray')
  .needs({ other: domainService(elsewhere) })
  .usecases({})
  .entrypoints();
// @ts-expect-error -- `shop` declares no `elsewhere` domain service
base.domainServices({ extras }).features(stray);

// (8) A top-level feature has no parent to bind `domainService(fn)`.
// @ts-expect-error -- only a child may need a domain service
defineFeature('lonely').needs({ x: domainService(extras) });

// (9) A domain-service key shadows nothing the usecases already see by key.
// @ts-expect-error -- `mailer` is a need alias
base.domainServices({ mailer: () => 1 });
// @ts-expect-error -- `repos` is an infra key
base.domainServices({ repos: () => 1 });
// @ts-expect-error -- `usecases` is reserved
base.domainServices({ usecases: () => 1 });

// (10) The step runs before `.features()`: the stage after it has no `.domainServices`.
// @ts-expect-error -- the stage after .features() offers no .domainServices()
base.features().domainServices({ extras });

// (11) The app never wires a parent-bound need: a parent with such a child mounts with nothing extra.
const parent = withServices.usecases({}).entrypoints();
defineApp('shop-app').infra(mail, database).features([parent]);
expectTypeOf<
  'extras' extends keyof UnitNeeds<ReturnType<typeof child.units>[number]> ? true : false
>().toEqualTypeOf<false>();
