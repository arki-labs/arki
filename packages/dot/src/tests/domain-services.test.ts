import { describe, expect, it } from 'vitest';

/**
 * `.domainServices()` — the step between `.infra()` and `.features()`
 * (RFC 2026-10-22-dot-usecase-boundary).
 *
 * Why these tests exist: a domain service is built once per boot, before the
 * children, from what is declared above it. Usecases and children (by
 * `domainService(fn)`) see the one instance; `provides` and entrypoints never
 * do. These are the smoke checks of that promise; the full matrix is B6.
 */
import { orThrow } from '@arki/failure';

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
});
