import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `.domainServices()` — the step between `.infra()` and `.features()`
 * (RFC 2026-10-22-dot-usecase-boundary).
 *
 * Why these tests exist: a domain service is built once per boot, before the
 * children, from what is declared above it. Usecases and children (by
 * `domainService(fn)`) see the one instance; `provides` and entrypoints never
 * do. These are the smoke checks of that promise; the full matrix is B6.
 */
import { resource } from '@arki/async';
import { findCause, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { buildMermaidGraph } from '../cli/render-graph.js';
import { defineFeature, domainService, entrypointOnly, FEATURE_ERROR_CODES, FeatureError } from '../feature.js';
import { defineApp, infra } from '../index.js';

type Db = { readonly query: (sql: string) => number };
const database = infra({ name: 'database', provides: { db: (): Db => ({ query: sql => sql.length }) } });
const locking = infra({ name: 'locking', provides: { locks: () => ({ held: false }) } });

class Extras {
  constructor(readonly db: Db) {}
  section(): string {
    return `extras:${this.db.query('abc')}`;
  }
}

let builds = 0;
const seenDeps: object[] = [];
const extras = (deps: { readonly db: Db }) => {
  builds += 1;
  seenDeps.push(deps);
  return new Extras(deps.db);
};
const hello = (name: string) => `hi ${name}`;
const greet = () => hello;

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

const shop = defineFeature('shop')
  .needs({ db: database.provides.db, locks: entrypointOnly(locking.provides.locks) })
  .domainServices({ extras, greet })
  .features(child)
  .usecases({
    read:
      ({ extras, greet }) =>
      () =>
        `${extras.section()} ${greet('x')}`,
    same:
      ({ extras, childSeen }) =>
      () =>
        childSeen() === extras,
  })
  .provides({ shop: ({ usecases }) => usecases, peek: services => Object.keys(services) })
  .entrypoints();

describe('domainServices()', () => {
  it('compiles to one domain-service unit after the infra and before the children', () => {
    const units = shop.units();
    expect(units.map(u => u.name)).toEqual(['shop/domain-services', 'shop.child', 'shop']);
    const [domainUnit] = units;
    expect(domainUnit.role).toBe('domain-service');
    expect(Object.keys(domainUnit.provides)).toEqual(['shop.extras', 'shop.greet']);
    expect(Object.keys(domainUnit.needs)).toEqual(['db']);
    expect(shop.instance('eu').units()[0].name).toBe('shop#eu/domain-services');
  });

  it('builds once per boot from frozen stage-above deps; usecases and the child share the instance', async () => {
    builds = 0;
    seenDeps.length = 0;
    const app = orThrow(await defineApp('ds').infra(database, locking).features([shop]).start());
    expect(builds).toBe(1);
    const [deps] = seenDeps;
    expect(Object.isFrozen(deps)).toBe(true);
    expect(Object.keys(deps ?? {}).filter(k => !k.startsWith('$'))).toEqual(['db']);
    expect(app.services.shop.read()).toBe('extras:3 hi x');
    expect(app.services.shop.same()).toBe(true);
    expect(app.services.peek).not.toContain('extras');
    expect(app.services.peek).not.toContain('greet');
    orThrow(await app.dispose());
  });

  it('refuses domainService(fn) in a top-level feature, and a child naming an undeclared factory (E034)', () => {
    const top = (): unknown =>
      // @ts-expect-error -- a top-level feature has no parent to bind domainService(...)
      defineFeature('lonely').needs({ extras: domainService(extras) });
    expect(top).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.domainServiceNotAbove }));
    const orphan = defineFeature('bare.child')
      .needs({ extras: domainService(extras) })
      .usecases({})
      .entrypoints();
    // @ts-expect-error -- `bare` declares no domain service for the child to need
    const undeclared = (): unknown => defineFeature('bare').features(orphan);
    expect(undeclared).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.domainServiceNotAbove }));
  });

  it('refuses a late or repeated step (E035) and a colliding key (E027)', () => {
    const late = defineFeature('late').usecases({});
    // @ts-expect-error -- the stage after .usecases() offers no .domainServices()
    const lateStep = (): unknown => late.domainServices({});
    expect(lateStep).toThrow(FeatureError);
    expect(lateStep).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.stepOrder }));
    const collide = (): unknown =>
      defineFeature('collide')
        .needs({ db: database.provides.db })
        // @ts-expect-error -- `db` is already a need alias
        .domainServices({ db: () => 1 });
    expect(collide).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.keyCollision }));
  });

  it('refuses a factory that can fail; one that fails past the types fails boot as a defect', async () => {
    const broken = () => UnexpectedDefect({ cause: 'no I/O at construction' });
    const failing = defineFeature('failing')
      // @ts-expect-error -- a domain service factory cannot fail: move the step to .infra()
      .domainServices({ broken })
      .usecases({})
      .provides({ failing: () => 'never built' })
      .entrypoints();
    const result = await defineApp('failing-app').features([failing]).start();
    expect(isFailure(result)).toBe(true);
    expect(findCause(result, UnexpectedDefect)).toBeDefined();
  });
});

/* ---- the full matrix (plan B6) ---- */

let exporter: InMemorySpanExporter;
let tracing: BasicTracerProvider;
beforeAll(() => {
  exporter = new InMemorySpanExporter();
  tracing = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(tracing);
});
afterEach(() => {
  exporter.reset();
});
afterAll(async () => {
  await tracing.shutdown();
  trace.disable();
});

type Repos = { readonly find: (id: string) => string };
const store = infra({ name: 'store', provides: { repos: (): Repos => ({ find: id => id }) } });

class Ledger {
  constructor(readonly repos: Repos) {}
}
let ledgerBuilds = 0;
const madeLedgers: Ledger[] = [];
const factoryDeps: object[] = [];
const ledger = (deps: { readonly repos: Repos }) => {
  ledgerBuilds += 1;
  factoryDeps.push(deps);
  const made = new Ledger(deps.repos);
  madeLedgers.push(made);
  return made;
};
const stamp = (deps: { readonly db: Db }) => {
  factoryDeps.push(deps);
  return (text: string) => `${text}:${deps.db.query(text).toString()}`;
};
const thrown = new Error('boom inside a domain service');
const throwBoom = (): never => {
  throw thrown;
};
const boom = () => throwBoom;
const connEvents: string[] = [];
const conn = () =>
  resource(
    () => {
      connEvents.push('open');
      return { live: true };
    },
    () => {
      connEvents.push('close');
    },
  );

const kid = defineFeature('mall.kid')
  .needs({ ledger: domainService(ledger), later: domainService(ledger).lazy })
  .usecases({
    eager:
      ({ ledger }) =>
      () =>
        ledger,
    deferred:
      ({ later }) =>
      () =>
        later.get(),
  })
  .provides({ kidLedger: ({ usecases }) => usecases.eager, kidLater: ({ usecases }) => usecases.deferred })
  .entrypoints();

const mall = defineFeature('mall')
  .needs({ db: database.provides.db, locks: entrypointOnly(locking.provides.locks) })
  .infra(store)
  .domainServices({ ledger, stamp, boom, conn })
  .features(kid)
  .usecases({
    one:
      ({ ledger }) =>
      () =>
        ledger,
    two:
      ({ ledger }) =>
      () =>
        ledger,
    stamped:
      ({ stamp }) =>
      () =>
        stamp('ab'),
    caught:
      ({ boom }) =>
      (): Error | undefined => {
        try {
          boom();
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : undefined;
        }
      },
    live:
      ({ conn }) =>
      () =>
        conn.live,
    sameAsChild:
      ({ ledger, kidLedger }) =>
      () =>
        kidLedger() === ledger,
    sameAsLazyChild:
      ({ ledger, kidLater }) =>
      async () =>
        (await kidLater()) === ledger,
  })
  .provides({ mall: ({ usecases }) => usecases, mallSeen: services => Object.keys(services) })
  .entrypoints();

const DOMAIN_KEYS = ['ledger', 'stamp', 'boom', 'conn'];
const tag = () => 'tag';

describe('domainServices() — the full matrix', () => {
  it('boots infra, then the domain-service unit, then the children, then the feature', async () => {
    const units = mall.units();
    expect(units.map(u => u.name)).toEqual(['mall/store', 'mall/domain-services', 'mall.kid', 'mall']);
    expect(units[1].role).toBe('domain-service');
    const app = orThrow(await defineApp('order').infra(database, locking).features([mall]).boot());
    expect(app.manifest.plugins.map(p => p.name)).toEqual([
      'database',
      'locking',
      'mall/store',
      'mall/domain-services',
      'mall.kid',
      'mall',
    ]);
    orThrow(await app.dispose());
  });

  it('builds each domain service once per boot from frozen deps declared above it', async () => {
    ledgerBuilds = 0;
    madeLedgers.length = 0;
    factoryDeps.length = 0;
    const app = orThrow(await defineApp('once').infra(database, locking).features([mall]).start());
    // Two usecases and a child read `ledger`; one build serves them all.
    expect(ledgerBuilds).toBe(1);
    expect(app.services.mall.one()).toBe(app.services.mall.two());
    expect(factoryDeps).toHaveLength(2);
    for (const deps of factoryDeps) {
      expect(Object.isFrozen(deps)).toBe(true);
      const keys = Object.keys(deps).filter(k => !k.startsWith('$'));
      // Stage-only: the usecase-visible needs and the infra. No usecases, no entrypoint-only `locks`, no peers.
      expect(keys.sort()).toEqual(['db', 'repos']);
    }
    orThrow(await app.dispose());
  });

  it('traces a function value and returns a class instance as built', async () => {
    madeLedgers.length = 0;
    const app = orThrow(await defineApp('traced').infra(database, locking).features([mall]).start());
    exporter.reset();
    expect(app.services.mall.stamped()).toBe('ab:2');
    const spans = exporter.getFinishedSpans().map(span => span.name);
    expect(spans).toContain('feature.mall.stamp');
    expect(spans).toContain('feature.mall.stamped');
    const instance = app.services.mall.one();
    expect(instance).toBeInstanceOf(Ledger);
    expect(instance).toBe(madeLedgers[0]);
    orThrow(await app.dispose());
  });

  it("lets a domain service's throw reach its caller as thrown: domain services are not supervised", async () => {
    const app = orThrow(await defineApp('throws').infra(database, locking).features([mall]).start());
    // The usecase catches the very Error the domain service threw, not an UnexpectedDefect wrapping it.
    expect(app.services.mall.caught()).toBe(thrown);
    orThrow(await app.dispose());
  });

  it('opens a resource() value at boot and disposes it with the app', async () => {
    connEvents.length = 0;
    const app = orThrow(await defineApp('res').infra(database, locking).features([mall]).start());
    expect(connEvents).toEqual(['open']);
    expect(app.services.mall.live()).toBe(true);
    orThrow(await app.dispose());
    expect(connEvents).toEqual(['open', 'close']);
  });

  it('keeps domain services out of <f>.services and the provides argument', async () => {
    const app = orThrow(await defineApp('hidden').infra(database, locking).features([mall]).start());
    const services = Object.keys(app.services['mall.services']);
    for (const key of DOMAIN_KEYS) {
      expect(services).not.toContain(key);
      expect(app.services.mallSeen).not.toContain(key);
    }
    orThrow(await app.dispose());
  });

  it("binds the child's domainService(fn), eager and lazy, to the parent's one instance", async () => {
    const app = orThrow(await defineApp('shared').infra(database, locking).features([mall]).start());
    expect(app.services.mall.sameAsChild()).toBe(true);
    expect(await app.services.mall.sameAsLazyChild()).toBe(true);
    orThrow(await app.dispose());
  });

  it('refuses a domainService(fn) need the level above does not declare (E034)', () => {
    const leaf = defineFeature('top.mid.leaf')
      .needs({ tag: domainService(tag) })
      .usecases({})
      .entrypoints();
    // The grandparent declares `tag`, but only the direct parent binds a child's need: the middle level refuses.
    const middle = (): unknown =>
      defineFeature('top.mid')
        // @ts-expect-error -- `top.mid` does not declare `tag`; its own parent's declaration does not reach the leaf
        .features(leaf);
    expect(middle).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.domainServiceNotAbove }));
    expect(defineFeature('top').domainServices({ tag })).toBeDefined();
  });

  it('refuses .domainServices() after .features() and a second call (E035)', () => {
    const afterFeatures = defineFeature('late2').features();
    expect(() =>
      // @ts-expect-error -- compile error; and the runtime check below for erased callers
      afterFeatures.domainServices({ tag }),
    ).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.stepOrder }));
    const once = defineFeature('twice').domainServices({ tag });
    expect(() =>
      // @ts-expect-error -- compile error; and the runtime check below for erased callers
      once.domainServices({ other: tag }),
    ).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.stepOrder }));
  });

  it('refuses a child key equal to a domain-service key (E027)', () => {
    const clash = defineFeature('dup.kid')
      .usecases({})
      .provides({ tag: () => 'child tag' })
      .entrypoints();
    const mount = (): unknown =>
      defineFeature('dup')
        .domainServices({ tag })
        // @ts-expect-error -- `tag` is a domain service of `dup`
        .features(clash);
    expect(mount).toThrow(expect.objectContaining({ code: FEATURE_ERROR_CODES.keyCollision }));
  });

  it("gives each instance its own domain-service unit, and its child the instance's service", async () => {
    const eu = mall.instance('eu');
    expect(eu.units().map(u => u.name)).toEqual(['mall#eu/store', 'mall#eu/domain-services', 'mall#eu.kid', 'mall#eu']);
    ledgerBuilds = 0;
    const app = orThrow(await defineApp('two-copies').infra(database, locking).features([mall, eu]).start());
    expect(ledgerBuilds).toBe(2);
    const euMall = app.services['mall#eu.mall'];
    expect(euMall.sameAsChild()).toBe(true);
    expect(await euMall.sameAsLazyChild()).toBe(true);
    expect(euMall.one()).not.toBe(app.services.mall.one());
    orThrow(await app.dispose());
  });

  it('draws the domain-service unit in the features group of the graph', async () => {
    const app = orThrow(await defineApp('graph').infra(database, locking).features([mall]).boot());
    const lines = buildMermaidGraph(app.manifest).split('\n');
    const start = lines.findIndex(line => line.trim().startsWith('subgraph features'));
    const end = lines.indexOf('  end', start);
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start, end).some(line => line.includes('mall/domain-services'))).toBe(true);
    orThrow(await app.dispose());
  });

  it('refuses a nested feature holding a domainService(fn) need mounted in an app without its parent (E034)', async () => {
    const orphan = defineFeature('mall.orphan')
      .needs({ ledger: domainService(ledger) })
      .usecases({
        seen:
          ({ ledger }) =>
          () =>
            ledger,
      })
      .provides({ orphanSeen: ({ usecases }) => usecases.seen })
      .entrypoints();
    // Something else publishes `ledger`: the parent-bound need must not bind to it by alias.
    const imposter = infra({ name: 'imposter', provides: { ledger: () => new Ledger({ find: id => id }) } });
    const mount = async (): Promise<unknown> => defineApp('gap').infra(imposter).features([orphan]).boot();
    await expect(mount()).rejects.toMatchObject({ code: FEATURE_ERROR_CODES.domainServiceNotAbove });
  });
});
