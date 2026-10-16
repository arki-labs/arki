/**
 * Nested features — `defineFeature('digest').features(compile, deliver)`
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder-nesting.md`).
 *
 * Why these tests exist: a child is a finished feature whose name is its
 * path; the parent lists it in one step. Every promise below was a hole in
 * a review round (Astra, rounds 1–3) before the fix: handle identity and
 * provenance must survive every copy, remap, lazy form and flag, or a child
 * silently binds to a stranger's service. Each test names the break it pins.
 */
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { AnyDefinedFeature, Provided, ServicesBag } from '../feature.js';
import type { AnyPlugin } from '../plugin-contract.js';
import type { Db, Tx } from './fixtures/nested-digest/db.js';
import type { Repos } from './fixtures/nested-digest/digest/infra/store.js';
import type { RequestContext } from './fixtures/rpc-app/orpc.js';
import { renderExplain } from '../cli/render-explain.js';
import {
  allFeatures,
  defineFeature,
  driven,
  driver,
  entrypointOnly,
  mountFeatures,
  ownUnits,
  providesOf,
  requestServices,
  routerFor,
  servicesOf,
  sliceOf,
} from '../feature.js';
import { defineApp, fake, plugin } from '../index.js';
import { rpc } from '../orpc.js';
import { createDb, database } from './fixtures/nested-digest/db.js';
import type { digestLogic } from './fixtures/nested-digest/digest/feature.js';
import { digest } from './fixtures/nested-digest/digest/feature.js';
import { compile, compileLogic } from './fixtures/nested-digest/digest/features/compile/feature.js';
import { ranker } from './fixtures/nested-digest/digest/features/compile/infra/ranker.js';
import { deliver } from './fixtures/nested-digest/digest/features/deliver/feature.js';
import { bindRepos, store } from './fixtures/nested-digest/digest/infra/store.js';

type Witness = { readonly key?: string; readonly origin?: object; readonly lazy?: unknown; readonly entrypointOnly?: boolean };
const witness = (unit: AnyPlugin, alias: string): Witness => unit.needs[alias] as Witness;
const unitNamed = (name: string): AnyPlugin => {
  const unit = digest.plugins().find(u => u.name === name);
  if (unit === undefined) throw new Error(`no unit ${name}`);
  return unit;
};

const appContract = { digest: digest.contract };
const appRouter = implement(appContract).$context<RequestContext>().router(routerFor(appContract, [digest]));
const clientFor = (services: ServicesBag) =>
  createRouterClient(appRouter, { context: { session: { user: { id: 'u1' } }, headers: new Headers(), services } })
    .digest;
const start = (f: typeof digest = digest) => defineApp('nesting').infra(database).features([f]).start();

describe('identity: a child is a finished feature named <parent>.<child>', () => {
  it('boots infra, then each child (any depth), then the feature; every unit name is qualified by path', () => {
    expect(digest.plugins().map(p => p.name)).toEqual([
      'digest/store',
      'digest/projections',
      'digest.compile/ranker',
      'digest.compile/projections',
      'digest.compile.rank',
      'digest.compile',
      'digest.deliver/mailer',
      'digest.deliver',
      'digest',
    ]);
  });

  it('qualifies keys by path; only the top-level provides stay bare', async () => {
    const app = await start();
    const keys = Object.keys(app.services);
    expect(keys).toEqual(expect.arrayContaining(['digest.repos', 'digest.services', 'digest.compile.services', 'digests']));
    expect(keys).not.toEqual(expect.arrayContaining(['compiler']));
    expect(keys).not.toEqual(expect.arrayContaining(['repos']));
    expect(keys).not.toEqual(expect.arrayContaining(['ranking']));
    expectTypeOf(compile.provides.compiler.key).toEqualTypeOf<'digest.compile.compiler'>();
    expectTypeOf(digest.provides.digests.key).toEqualTypeOf<'digests'>();
    expectTypeOf(compile.features[0].provides.ranking.key).toEqualTypeOf<'digest.compile.rank.ranking'>();
    await app.dispose();
  });

  it('refuses a child not named <parent>.<child>, at compile time and at runtime', () => {
    const stray = defineFeature('compile').entrypoints();
    // @ts-expect-error a child must be named `digest.<child>`
    expect(() => defineFeature('digest').needs({ db: entrypointOnly(database.provides.db) }).infra(store).features(stray)).toThrow(
      /not named "digest.<child>"/,
    );
  });

  it('refuses a child key that collides with the parent, and two children providing one key', () => {
    const parent = defineFeature('digest').needs({ db: entrypointOnly(database.provides.db) }).infra(store);
    const sameAsInfra = defineFeature('digest.x').provides({ repos: () => 1 }).entrypoints();
    // @ts-expect-error `repos` is the parent's infra key
    expect(() => parent.features(sameAsInfra)).toThrow(/collides with a need alias or an infra service/);
    const a = defineFeature('digest.a').provides({ thing: () => 1 }).entrypoints();
    const b = defineFeature('digest.b').provides({ thing: () => 2 }).entrypoints();
    // @ts-expect-error two children may not provide the same key
    expect(() => parent.features(a, b)).toThrow(/a service of "digest.a"/);
    // @ts-expect-error inside a parent a provided key may not repeat an infra key: both publish under the feature's name
    expect(() => defineFeature('digest.y').needs({ repos: store.provides.repos }).infra(ranker).provides({ ranker: () => 1 })).toThrow(
      /collides with an infra service/,
    );
  });
});

describe('assembly (Astra round 1 #4): one normalized node list for every adapter', () => {
  it('mountFeatures lists each node once, depth-first; re-flattening would repeat descendants', () => {
    const mounted = mountFeatures([digest]);
    expect(mounted.features.map(f => f.name)).toEqual(['digest', 'digest.compile', 'digest.compile.rank', 'digest.deliver']);
    expect(allFeatures(mounted.features)).toHaveLength(8);
    expect(mounted.units.map(u => u.name)).toEqual(digest.plugins().map(u => u.name));
  });

  it('hands drivers (.entrypoints) and driven adapters (.infra) the same list, so each node is read once', async () => {
    const seenByDriver: string[] = [];
    const seenByDriven: string[] = [];
    const scheduler = driver(features =>
      plugin({
        name: 'scheduler',
        provides: {
          scheduled: ctx => {
            for (const f of features) seenByDriver.push(...((sliceOf(ctx, f)['schedules'] as string[] | undefined) ?? []));
            return seenByDriver;
          },
        },
      }),
    );
    const collector = driven(features =>
      plugin({ name: 'collector', provides: { collected: () => features.map(f => f.name) } }),
    );
    const app = await defineApp('adapters').infra(database, collector).features([digest]).entrypoints(scheduler).start();
    expect(app.services.collected).toEqual(['digest', 'digest.compile', 'digest.compile.rank', 'digest.deliver']);
    expect(app.services.scheduled).toEqual(['send-digest', 'compile-digest']);
    seenByDriven.push(...app.services.collected);
    await app.dispose();
  });

  it("ownUnits reads a node's OWN units only, so a child's projections register once (Astra round 2: the journal threw)", () => {
    type Declared = { readonly projections: readonly { readonly name: string }[] };
    const isProjectionsUnit = (u: object): u is AnyPlugin & { readonly handlers: Declared } =>
      'kind' in u && u.kind === 'journal-projections' && 'handlers' in u;
    // A faithful replica of @arki/journal's `declaredBy` + `claimName`, over the normalized node list.
    const read = (unitsOf: (f: AnyDefinedFeature) => readonly AnyPlugin[]): string[] => {
      const owners = new Map<string, string>();
      for (const f of mountFeatures([digest]).features) {
        for (const unit of unitsOf(f)) {
          if (!isProjectionsUnit(unit)) continue;
          for (const { name } of unit.handlers.projections) {
            const owner = owners.get(name);
            if (owner !== undefined) throw new Error(`duplicate projection name "${name}" (${owner} and ${f.name})`);
            owners.set(name, f.name);
          }
        }
      }
      return [...owners.keys()];
    };
    expect(() => read(f => f.plugins())).toThrow('duplicate projection name "compile-stats" (digest and digest.compile)');
    expect(read(ownUnits)).toEqual(['digest-stats', 'compile-stats']);
  });
});

describe('rpc: the parent mounts the children (Astra round 1 #5)', () => {
  it("declares each action once: a child's router is skipped, an inline group is kept", () => {
    const actions = digest.plugins().flatMap(p => p.actions.map(a => ('toDotAction' in a ? a.toDotAction().id : a.id)));
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain('digest.admin.ping');
    expect(actions).toContain('digest.run');
    expect(actions.filter(a => a === 'digest.compile.run')).toHaveLength(1);
    expect(actions.filter(a => a === 'digest.deliver.send')).toHaveLength(1);
  });

  it('routes wire paths app key + parent key + procedure; the grandchild ranks, the grandparent stores', async () => {
    const app = await start();
    const api = clientFor(app.services);
    expect(await api.admin.ping()).toBe('pong');
    const compiled = await api.compile.run({ userId: 'u1', items: ['pear', 'apple', 'fig', 'kiwi'] });
    expect(compiled.items).toEqual(['apple', 'fig', 'kiwi']);
    expect(await api.deliver.send({ digestId: compiled.id })).toEqual({ status: 'sent' });
    await app.dispose();
  });

  it("refuses a child rpc contract the parent's contract does not mount, at compile time and at runtime", () => {
    const childContract = oc.router({ ping: oc.output(z.string()) });
    const childImplementer = implement(childContract).$context<RequestContext>();
    const child = defineFeature('p.c').entrypoints(
      rpc(childContract, childImplementer, { ping: o => o.ping.handler(() => 'pong') }),
    );
    // @ts-expect-error no rpc at all on the parent
    expect(() => defineFeature('p').features(child).entrypoints()).toThrow(/is not mounted in its own contract/);
    const parentContract = oc.router({ other: oc.output(z.string()) });
    const parentImplementer = implement(parentContract).$context<RequestContext>();
    expect(() =>
      defineFeature('p')
        .features(child)
        // @ts-expect-error the parent's contract does not mount the child's
        .entrypoints(rpc(parentContract, parentImplementer, { other: o => o.other.handler(() => 'x') })),
    ).toThrow(/is not mounted in its own contract/);
    const okContract = oc.router({ c: childContract });
    const okImplementer = implement(okContract).$context<RequestContext>();
    expect(() =>
      defineFeature('p').features(child).entrypoints(rpc(okContract, okImplementer, { c: () => child.router })),
    ).not.toThrow();
  });
});

describe('transactions (Astra round 1 #3): entrypoints open them, usecases take tx', () => {
  it('commits compile + deliver together and rolls both back when delivery fails', async () => {
    const app = await start();
    const api = clientFor(app.services);
    const db = app.services.db;
    const repos = app.services['digest.repos'];
    const count = () => db.transaction(tx => repos.withTx(tx).digests.count());
    const before = await count();
    const ran = await api.run({ userId: 'u2', items: ['z', 'y'] });
    expect(ran.status).toBe('sent');
    expect(await count()).toBe(before + 1);
    await expect(api.run({ userId: 'bounce', items: ['x'] })).rejects.toThrow('mail to bounce failed');
    expect(await count()).toBe(before + 1);
    // sendFresh compiles through the sibling's provided service: the sibling's write rolls back too.
    await expect(api.deliver.sendFresh({ userId: 'bounce', items: ['x'] })).rejects.toThrow('mail to bounce failed');
    expect(await count()).toBe(before + 1);
    await app.dispose();
  });

  it('entrypointOnly(db): absent from the usecases deps, present in the entrypoints services — types and runtime', async () => {
    const peekDeps = defineFeature('peek').needs({ db: entrypointOnly(database.provides.db), raw: database.provides.db });
    const peek = peekDeps
      .usecases({ sees: (deps: Record<string, unknown>) => () => Object.keys(deps) })
      .provides({ door: ({ db }) => db.transaction(() => Promise.resolve('opened')) })
      .entrypoints();
    const app = await defineApp('peek').infra(database).features([peek]).start();
    const seen = app.services['peek.usecases'].sees();
    expect(seen).toContain('raw');
    expect(seen).not.toContain('db');
    expect('db' in app.services['peek.services']).toBe(true);
    expect(app.services.door).toBe('opened');
    // @ts-expect-error a usecase cannot ask for the entrypoint-only `db`
    peekDeps.usecases({ bad: ({ db }: { db: Db }) => () => db });
    expectTypeOf<keyof typeof app.services['peek.usecases']>().toEqualTypeOf<'sees'>();
    expectTypeOf(peekDeps.handles.db.lazy.entrypointOnly).toEqualTypeOf<true>();
    await app.dispose();
  });

  it('a plain Db is not a Tx, and repos exist only rebound to one (fixture contract)', async () => {
    const db = createDb();
    let leaked: Tx | undefined;
    await db.transaction(tx => {
      leaked = tx;
      return Promise.resolve();
    });
    expect(() => bindRepos(leaked as Tx).digests.count()).toThrow('transaction closed');
    // @ts-expect-error only transaction(fn) hands out a Tx
    bindRepos(db);
  });
});

describe('re-export and override by path', () => {
  it("provides() re-exports a child's service under a public key", async () => {
    const app = await start();
    const db = app.services.db;
    const made = await db.transaction(tx => app.services.digests.compile(tx, 'u3', ['q']));
    expect(made.id.startsWith('d_u3_')).toBe(true);
    expectTypeOf<Provided<typeof digest.provides.digests>['compile']>().toEqualTypeOf<
      Provided<typeof compile.provides.compiler>['compile']
    >();
    await app.dispose();
  });

  it('override("compile.ranker") reaches the child infra; unknown paths are compile and runtime errors', async () => {
    const faked = digest.override({
      'deliver.mailer': { sent: [], send: () => Promise.resolve(false) },
      'compile.ranker': {
        rank: items => {
          const reversed = [...items];
          reversed.reverse();
          return reversed;
        },
        stored: () => Promise.resolve(0),
      },
    });
    const app = await start(faked);
    const reversed = await clientFor(app.services).compile.run({ userId: 'u1', items: ['a', 'b'] });
    expect(reversed.items).toEqual(['b', 'a']);
    await app.dispose();
    // @ts-expect-error unknown child
    expect(() => digest.override({ 'nope.ranker': 1 })).toThrow(/names no child feature/);
    // @ts-expect-error unknown service of a known child
    expect(() => digest.override({ 'compile.nope': 1 })).toThrow(/names no service of its infra plugins/);
    // @ts-expect-error a grandchild without infra has nothing to override
    expect(() => digest.override({ 'compile.rank.nothing': 1 })).toThrow(/names no service of its infra plugins/);
  });
});

describe('ownership metadata (Astra rounds 1–3 #1): every minted handle, unit handles and lazy forms included', () => {
  const featureUnit = digest.plugins()[8];
  const storeUnit = digest.plugins()[0];
  const compileUnit = digest.plugins()[5];

  it("refuses a feature's usecases/services handles from anywhere: they are internal", () => {
    // @ts-expect-error the unit's usecases handle is internal
    expect(() => defineFeature('other').needs({ u: featureUnit.provides['digest.usecases'] })).toThrow(/internal handle/);
    // @ts-expect-error …lazy form included
    expect(() => defineFeature('other').needs({ u: featureUnit.provides['digest.services'].lazy })).toThrow(/internal handle/);
    // @ts-expect-error the slice handle is internal
    expect(() => defineFeature('other').needs({ u: featureUnit.provides['feature.digest'] })).toThrow(/internal handle/);
    // @ts-expect-error nobody can need a feature's usecases handle, top level included
    expect(() => defineFeature('other').needs({ internal: digest.handles.usecases })).toThrow(/internal handle/);
    // @ts-expect-error a sibling cannot bypass the child's re-export through its usecases
    expect(() => defineFeature('digest.deliver').needs({ internal: compile.handles.usecases })).toThrow(/internal handle/);
    // Astra round 3: a REMAPPED child unit keeps its typed, scoped handles (RemappedUnit no longer rebuilds plain ones).
    // @ts-expect-error the child's unit publishes its usecases as an internal handle
    expect(() => defineFeature('other').needs({ u: compileUnit.provides['digest.compile.usecases'] })).toThrow(/internal handle/);
    expectTypeOf(digest.handles.usecases.internal).toEqualTypeOf<true>();
    expectTypeOf(featureUnit.provides['digest.usecases'].lazy.internal).toEqualTypeOf<true>();
  });

  it("refuses private handles from outside their scope; the unit's public provides stay public", () => {
    // @ts-expect-error a qualified infra unit's handle is scoped to its feature
    expect(() => defineFeature('other').needs({ r: storeUnit.provides['digest.repos'] })).toThrow(/private to "digest"/);
    // @ts-expect-error …lazy form included
    expect(() => defineFeature('other').needs({ r: storeUnit.provides['digest.repos'].lazy })).toThrow(/private to "digest"/);
    // @ts-expect-error an outsider cannot need a nested feature's provides
    expect(() => defineFeature('other').needs({ compiler: compile.provides.compiler })).toThrow(/private to "digest"/);
    // @ts-expect-error scope metadata survives .lazy
    expect(() => defineFeature('other').needs({ compiler: compile.provides.compiler.lazy })).toThrow(/private to "digest"/);
    // @ts-expect-error an outsider cannot need a feature's private infra through its qualified handle
    expect(() => defineFeature('other').needs({ repos: digest.handles.repos })).toThrow(/private to "digest"/);
    // @ts-expect-error a cousin outside the parent cannot either
    expect(() => defineFeature('reports.x').needs({ compiler: compile.provides.compiler })).toThrow(/private to "digest"/);
    // Anything inside the parent's scope (siblings, nephews) may; public handles are reachable from anywhere.
    expect(() =>
      defineFeature('digest.deliver.x').needs({ compiler: compile.provides.compiler, repos: digest.handles.repos.lazy }),
    ).not.toThrow();
    expect(() => defineFeature('other').needs({ d: featureUnit.provides.digests, db: database.provides.db })).not.toThrow();
    expectTypeOf(compile.provides.compiler.scope).toEqualTypeOf<'digest'>();
    expectTypeOf(digest.provides.digests.scope).toEqualTypeOf<undefined>();
  });

  it('leaves an infra plugin no way in with a private handle (a backdoor): undeclared at .infra(), refused at .needs()', () => {
    const backdoor = plugin({ name: 'backdoor', needs: { compiler: compile.provides.compiler }, provides: { leak: () => 1 } });
    // @ts-expect-error the plugin's need is not declared by the feature
    expect(() => defineFeature('other').infra(backdoor)).toThrow(/needs "compiler", which the feature does not declare/);
    // …and declaring it is the scope refusal: the only handles inside a feature are its own needs and sibling handles.
    // @ts-expect-error private to digest
    expect(() => defineFeature('other').needs({ compiler: compile.provides.compiler })).toThrow(/private to "digest"/);
  });
});

describe('remap by identity, assembly validates the original owner (Astra rounds 2–3 #2)', () => {
  const otherStore = plugin({ name: 'store', provides: { repos: (): Repos => ({ withTx: tx => bindRepos(tx) }) } });

  it("leaves a same-key handle of ANOTHER store untouched; assembly then refuses it naming the owner", () => {
    // `reports.x` names DIGEST's raw store handle, under the key reports' own store also uses.
    const x = defineFeature('reports.x').needs({ repos: store.provides.repos }).entrypoints();
    const reports = defineFeature('reports').infra(otherStore).features(x).entrypoints();
    const xUnit = reports.plugins().find(u => u.name === 'reports.x');
    expect(xUnit?.needs['repos']).toBe(store.provides.repos);
    expect(() => mountFeatures([digest, reports])).toThrow(/raw infra handle of "digest"/);
  });

  it('remaps a legitimate child need to the qualified key and keeps the original under origin', () => {
    const need = witness(unitNamed('digest.compile'), 'repos');
    expect(need.key).toBe('digest.repos');
    expect(need.origin).toBe(store.provides.repos);
    // The grandchild's need travels two levels up, remapped by the grandparent only.
    const grand = witness(unitNamed('digest.compile.rank'), 'repos');
    expect(grand.key).toBe('digest.repos');
    expect(grand.origin).toBe(store.provides.repos);
    expect(witness(unitNamed('digest.compile.rank'), 'ranker').key).toBe('digest.compile.ranker');
  });

  it('refuses an outsider and a cousin holding a raw infra handle, before boot', () => {
    const outsider = defineFeature('other').needs({ repos: store.provides.repos }).entrypoints();
    expect(() => mountFeatures([digest, outsider])).toThrow(/raw infra handle of "digest"/);
    const cousin = defineFeature('digest.deliver.x').needs({ ranker: ranker.provides.ranker }).entrypoints();
    expect(() => mountFeatures([digest, cousin])).toThrow(/raw infra handle of "digest.compile"/);
    // @ts-expect-error nothing publishes `repos` either: the app builder's own guard refuses the outsider
    expect(() => defineApp('x').infra(database).features([digest, outsider])).toThrow(/raw infra handle of "digest"/);
  });

  it("a child's infra plugin that needs the parent's store: by alias it is remapped with origin kept; bound directly it is refused", () => {
    // Done right (the fixture's `ranker`): the plugin holds the child's need object, so the parent's remap rewrites it.
    const rankerNeed = witness(unitNamed('digest.compile/ranker'), 'repos');
    expect(rankerNeed.key).toBe('digest.repos');
    expect(rankerNeed.origin).toBe(store.provides.repos);
    // Astra round 3's variant: the plugin names digest's raw handle itself, inside another tree. Refused at `.infra()`.
    const sneaky = plugin({ name: 'sneaky', needs: { repos: store.provides.repos }, provides: { n: ({ repos }) => repos } });
    // @ts-expect-error `repos` is not declared by the feature
    expect(() => defineFeature('reports.y').infra(sneaky)).toThrow(/needs "repos", which the feature does not declare/);
    expect(() => defineFeature('reports.y').needs({ repos: otherStore.provides.repos }).infra(sneaky)).toThrow(
      /binds "repos" to a handle other than the feature's/,
    );
  });

  it('entrypointOnly keeps identity (Astra round 3): the clone remaps like the original and is still refused outside', () => {
    const doorChild = defineFeature('digest.door')
      .needs({ repos: entrypointOnly(store.provides.repos) })
      .usecases({ sees: (deps: Record<string, unknown>) => () => Object.keys(deps) })
      .entrypoints();
    const parent = defineFeature('digest').needs({ db: entrypointOnly(database.provides.db) }).infra(store).features(doorChild).entrypoints();
    const unit = parent.plugins().find(u => u.name === 'digest.door');
    const need = witness(unit as AnyPlugin, 'repos');
    expect(need.key).toBe('digest.repos');
    expect(need.origin).toBe(store.provides.repos);
    expect(need.entrypointOnly).toBe(true);
    const outsider = defineFeature('other').needs({ repos: entrypointOnly(store.provides.repos) }).entrypoints();
    expect(() => mountFeatures([parent, outsider])).toThrow(/raw infra handle of "digest"/);
    const lazyOutsider = defineFeature('other').needs({ repos: entrypointOnly(store.provides.repos).lazy }).entrypoints();
    expect(() => mountFeatures([parent, lazyOutsider])).toThrow(/raw infra handle of "digest"/);
  });

  it('the type-level remap is key-based (known gap): the foreign-store child compiles; the runtime refuses it', () => {
    const x = defineFeature('reports.x').needs({ repos: store.provides.repos }).entrypoints();
    expect(() => defineFeature('reports').infra(otherStore).features(x)).not.toThrow();
    // …and the whole legitimate tree passes the app builder's guard: the remapped needs line up.
    expect(() => defineApp('x').infra(database).features([digest])).not.toThrow();
  });
});

describe('generated keys are reserved (Astra round 1 #6)', () => {
  it('refuses <name>.services, <name>.usecases and feature.<name> as provided keys', () => {
    // @ts-expect-error a provides factory cannot take <name>.services
    expect(() => defineFeature('overwrite').provides({ 'overwrite.services': () => 123 })).toThrow(/generated by the feature/);
    // @ts-expect-error nor <name>.usecases
    expect(() => defineFeature('overwrite').provides({ 'overwrite.usecases': () => 123 })).toThrow(/generated by the feature/);
    // @ts-expect-error nor the slice key
    expect(() => defineFeature('overwrite').provides({ 'feature.overwrite': () => 123 })).toThrow(/generated by the feature/);
  });
});

describe('deps: a parent sees its children, never their infra; a child sees only what it needed', () => {
  it('types the parent usecases from the children provides', () => {
    const parent = defineFeature('digest').needs({ db: entrypointOnly(database.provides.db) }).infra(store).features(compile);
    parent.usecases({
      ok: ({ compiler, repos }: { compiler: Provided<typeof compile.provides.compiler>; repos: Repos }) => [compiler, repos],
    });
    // @ts-expect-error the child's infra (`ranker`) is private to the child
    parent.usecases({ bad: (deps: { ranker: unknown }) => deps });
    // @ts-expect-error `delivery` was not needed by `compile`
    void compileLogic.handles.delivery;
    expectTypeOf<keyof typeof digestLogic.handles>().toEqualTypeOf<'db' | 'repos' | 'compiler' | 'delivery' | 'usecases'>();
  });
});

describe('tests at depth: fake() the one need, override by path', () => {
  it('fake(database.provides.db) reaches the grandchild through the remapped repos', async () => {
    let opened = 0;
    const fakeDb: Db = {
      transaction: async fn => {
        opened += 1;
        return createDb().transaction(fn);
      },
    };
    const app = await defineApp('faked').infra(fake(database.provides.db, fakeDb)).features([digest]).start();
    const compiled = await clientFor(app.services).compile.run({ userId: 'u1', items: ['b', 'a'] });
    expect(compiled.items).toEqual(['a', 'b']);
    expect(opened).toBe(1);
    await app.dispose();
  });
});

describe('lifecycle and explain', () => {
  it('stops in reverse boot order: the feature, then its children, then its infra', async () => {
    const stopped: string[] = [];
    // `stop` runs for started plugins only, so each declares `start` too.
    const leaf = plugin({ name: 'leaf', provides: { leaf: () => 'leaf' }, start: () => Promise.resolve(), stop: () => void stopped.push('leaf') });
    const root = plugin({ name: 'root', provides: { root: () => 'root' }, start: () => Promise.resolve(), stop: () => void stopped.push('root') });
    const child = defineFeature('tree.child').infra(leaf).entrypoints();
    const tree = defineFeature('tree').infra(root).features(child).entrypoints();
    const app = await defineApp('order').features([tree]).start();
    await app.stop();
    expect(stopped).toEqual(['leaf', 'root']);
    expect(tree.plugins().map(u => u.name)).toEqual(['tree/root', 'tree.child/leaf', 'tree.child', 'tree']);
  });

  it('dot explain shows the tree by name: nested units in boot order and the edges between them', () => {
    const configured = defineApp('explain').infra(database).features([digest]).configure();
    let text = '';
    renderExplain({ manifest: configured.manifest }, { json: false, out: line => (text += line) });
    const names = configured.manifest.plugins.map(p => p.name);
    expect(names.indexOf('digest.compile/ranker')).toBeLessThan(names.indexOf('digest.compile'));
    expect(names.indexOf('digest.compile')).toBeLessThan(names.indexOf('digest'));
    expect(text).toContain('digest.compile --[digest.repos]--> digest/store');
    expect(text).toContain('digest --[digest.compile.compiler]--> digest.compile');
    expect(text).toContain('digest.compile.rank --[digest.compile.ranker]--> digest.compile/ranker');
  });
});

describe('.needs() takes a record, never a bare handle', () => {
  it('refuses a handle passed as the needs record, at compile time and at runtime', () => {
    // @ts-expect-error a bare handle would be read as { key, provider, lazy }
    expect(() => defineFeature('bare').needs(database.provides.db)).toThrow(/not a bare handle/);
  });
});

// `deliver` is imported so the fixture's sibling edge (deliver needs compile's provides) stays part of this suite.
void deliver;

describe('requestServices: what a gateway needs to serve the tree', () => {
  it("publishes every node's <name>.services and the top-level public handles, public — a gateway may need them", async () => {
    const request = requestServices([digest]);
    expect(new Set(Object.keys(request.provides))).toEqual(
      new Set(['digests', 'digest.services', 'digest.compile.services', 'digest.compile.rank.services', 'digest.deliver.services']),
    );
    // No ownership on these handles: the gateway sits outside every scope and still compiles.
    expect(request.provides['digest.compile.services']).not.toHaveProperty('scope');
    expectTypeOf(request.provides['digest.compile.services'].key).toEqualTypeOf<'digest.compile.services'>();
    const units = [request] as const;
    const gateway = defineFeature('gateway')
      .needs({ ...providesOf(units) })
      .usecases({})
      .provides({ bag: ctx => servicesOf(ctx, units) })
      .entrypoints();
    const app = await defineApp('gateway-app').infra(database).features([digest, gateway]).start();
    try {
      const bag = app.services.bag;
      expect(bag['digest.compile.services']).toBe(app.services['digest.compile.services']);
      expect(bag.digests).toBe(app.services.digests);
      // The bag is exactly what `bind(core)` reads: a child's procedures run through it.
      const run = await clientFor(bag).compile.run({ userId: 'u1', items: ['b', 'a'] });
      expect(run.items).toEqual(['a', 'b']);
    } finally {
      await app.dispose();
    }
  });
});
