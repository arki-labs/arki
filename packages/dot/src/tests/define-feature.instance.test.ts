/**
 * `feature.instance('eu', rebind)` — one declared feature, mounted twice.
 *
 * Why these tests exist: a feature's name is baked into every key it
 * publishes (`<name>.usecases`, `feature.<name>`, its infra unit names), so a
 * second copy needs a second name, and the copy's needs must be able to point
 * at another provider (the EU database) without touching the declaration.
 * Each test pins one way a copy could silently share state with the original.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { UnitNeeds } from '../unit-contract.js';
import { renderExplainText } from '../cli/render-explain.js';
import { textUi } from '../cli/tests/text-ui.js';
import { defineFeature, entrypointOnly, instanceOf, mountFeatures, routerFor } from '../feature.js';
import { defineApp } from '../index.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { rpc } from '../orpc.js';
import { infra, rename, service } from '../unit-contract.js';

type Region = { readonly region: string; readonly rows: string[] };
const regionDb = (region: string) =>
  infra({ name: 'database', provides: { db: (): Region => ({ region, rows: [] }) } });
const database = regionDb('us');
const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'databaseEu');

/**
 * The wire keys a feature's unit needs: the rebind shows here. (`handles` holds only entrypoint-only
 * needs and `usecases`, so a plain need like `db` is not on it.)
 */
type NeedKeysOf<F extends { units(): readonly unknown[] }, I extends number> = keyof UnitNeeds<
  ReturnType<F['units']>[I]
>;

const store = infra({
  name: 'store',
  needs: { db: service<Region>() },
  provides: { repos: ({ db }) => ({ region: () => db.region }) },
});

const reports = defineFeature('reports')
  .needs({ db: database.provides.db })
  .infra(store)
  .usecases({
    region:
      ({ repos }) =>
      () =>
        repos.region(),
  })
  .provides({ summary: ({ usecases }) => ({ region: usecases.region() }) })
  .entrypoints(rpc({}, {}, {}));

describe('feature.instance(): a second copy under `<name>#<instance>`', () => {
  it('mounts two copies side by side, each on its own database', async () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    const us = reports.instance('us');
    expectTypeOf(eu.name).toEqualTypeOf<'reports#eu'>();
    expectTypeOf(eu.provides.summary.key).toEqualTypeOf<'reports#eu.summary'>();
    expectTypeOf<NeedKeysOf<typeof eu, 1>>().toEqualTypeOf<'dbEu' | 'reports#eu.repos'>();
    expect(eu.units().map(u => u.name)).toEqual(['reports#eu/store', 'reports#eu']);

    const app = orThrow(await defineApp('t').infra(database).infra(databaseEu).features([eu, us]).boot());
    try {
      expect(app.services['reports#eu.summary']).toEqual({ region: 'eu' });
      expect(app.services['reports#us.summary']).toEqual({ region: 'us' });
    } finally {
      orThrow(await app.dispose());
    }
  });

  it('mounts the original next to a copy; the original twice is still refused', async () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    expect(() => mountFeatures([reports, eu])).not.toThrow();
    const app = orThrow(await defineApp('t').infra(database).infra(databaseEu).features([reports, eu]).boot());
    try {
      expect(app.services.summary).toEqual({ region: 'us' });
      expect(app.services['reports#eu.summary']).toEqual({ region: 'eu' });
    } finally {
      orThrow(await app.dispose());
    }
    // @ts-expect-error -- the same feature twice: one unit name, one `summary` wire key
    await expect(defineApp('t').infra(database).features([reports, reports]).boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.DuplicateUnit },
    });
  });

  it('re-derives a nested child under the copy; a child need on the same handle follows the rebind', async () => {
    const audit = defineFeature('reports.audit')
      .needs({ db: database.provides.db })
      .usecases({
        region:
          ({ db }) =>
          () =>
            db.region,
      })
      .provides({ trail: ({ usecases }) => usecases.region() })
      .entrypoints();
    const parent = defineFeature('reports')
      .needs({ db: database.provides.db })
      .infra(store)
      .features(audit)
      .usecases({})
      .provides({})
      .entrypoints();
    const eu = parent.instance('eu', { db: databaseEu.provides.dbEu });
    expect(eu.features.map(c => c.name)).toEqual(['reports#eu.audit']);
    expectTypeOf(eu.features[0].name).toEqualTypeOf<'reports#eu.audit'>();
    expectTypeOf<NeedKeysOf<(typeof eu.features)[0], 0>>().toEqualTypeOf<'dbEu'>();
    const childNeeds = eu
      .units()
      .filter(u => u.name === 'reports#eu.audit')
      .flatMap(u => Object.values(u.needs).map(w => ('key' in w ? w.key : undefined)));
    expect(childNeeds).toEqual(['dbEu']);

    const app = orThrow(await defineApp('t').infra(databaseEu).features([eu]).boot());
    try {
      expect(app.services['reports#eu.audit.trail']).toBe('eu');
    } finally {
      orThrow(await app.dispose());
    }
  });

  // Why: `entrypointOnly` keeps a handle (the gateway's db) away from usecases. A rebind swaps the
  // provider, not the rule, so the lazy form of a rebound entrypoint-only need must stay flagged;
  // if it lost the flag, the need would reach the usecases' deps after `feature.instance(...)`.
  it('keeps a lazy entrypointOnly need entrypoint-only after a rebind', () => {
    const probe = defineFeature('reports.probe')
      .needs({ db: entrypointOnly(database.provides.db).lazy })
      .usecases({})
      .entrypoints();
    const parent = defineFeature('reports')
      .needs({ db: database.provides.db })
      .features(probe)
      .usecases({})
      .provides({})
      .entrypoints();
    const eu = parent.instance('eu', { db: databaseEu.provides.dbEu });
    const rebound = eu.features[0].units()[0].needs['db'];
    // The EU lazy form, still flagged entrypoint-only, with the EU lazy form as its origin.
    expect(rebound).toMatchObject({ entrypointOnly: true, origin: databaseEu.provides.dbEu.lazy });
  });

  it('follows the rebind for a lazy child need, with the new lazy form', async () => {
    const audit = defineFeature('reports.audit')
      .needs({ db: database.provides.db.lazy })
      .usecases({
        region:
          ({ db }) =>
          async () =>
            orThrow(await db.get()).region,
      })
      .provides({ trail: ({ usecases }) => usecases.region() })
      .entrypoints();
    const parent = defineFeature('reports')
      .needs({ db: database.provides.db })
      .features(audit)
      .usecases({})
      .provides({})
      .entrypoints();
    const eu = parent.instance('eu', { db: databaseEu.provides.dbEu });
    // The child's need is the EU handle, still in its lazy form.
    expectTypeOf<NeedKeysOf<(typeof eu.features)[0], 0>>().toEqualTypeOf<'dbEu'>();
    expect(eu.features[0].units()[0].needs['db']).toBe(databaseEu.provides.dbEu.lazy);
    const app = orThrow(await defineApp('t').infra(databaseEu).features([eu]).boot());
    try {
      // The kernel awaits a provides factory, so the resolved trail is the EU region string.
      expect(app.services['reports#eu.audit.trail']).toBe('eu');
    } finally {
      orThrow(await app.dispose());
    }
  });

  it('gives each copy its own rpc contract identity, so the app contract mounts both', () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    const us = reports.instance('us');
    expect(eu.contract).not.toBe(reports.contract);
    expect(eu.contract).not.toBe(us.contract);
    const router = routerFor({ eu: eu.contract, us: us.contract }, [eu, us]);
    expect(router.eu).toBe(eu.router);
    expect(router.us).toBe(us.router);
  });

  it('keeps the instance name through override() and shows the copies in `dot explain`', () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    const us = reports.instance('us').override({ repos: { region: () => 'faked' } });
    expect(us.name).toBe('reports#us');
    const configured = orThrow(defineApp('t').infra(database).infra(databaseEu).features([eu, us]).configure());
    const explained = textUi();
    renderExplainText(configured.manifest, explained.ui);
    const text = explained.text();
    const names = configured.manifest.plugins.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['reports#eu/store', 'reports#eu', 'reports#us/store', 'reports#us']));
    expect(text).toContain('reports#eu --[reports#eu.repos]--> reports#eu/store');
    expect(text).toContain('reports#us --[reports#us.repos]--> reports#us/store');
  });

  it('instanceOf(): the instance segment of a name, for adapters', () => {
    expect(instanceOf('reports#eu')).toBe('eu');
    expect(instanceOf('reports#eu.audit')).toBe('eu');
    expect(instanceOf('reports#eu.audit.deep')).toBe('eu');
    expect(instanceOf('reports#eu/store')).toBe('eu');
    expect(instanceOf('reports#eu.audit/store')).toBe('eu');
    expect(instanceOf('reports')).toBeUndefined();
    expect(instanceOf('reports.audit')).toBeUndefined();
  });

  it('refuses a rebind of a non-need, another service type, a bad instance name and `#` in a declared name', () => {
    // @ts-expect-error -- `x` is not a need of `reports`
    expect(() => reports.instance('eu', { x: databaseEu.provides.dbEu })).toThrow(/not a need/);
    const other = infra({ name: 'other', provides: { n: () => 1 } });
    // @ts-expect-error -- `n` carries a number; `db` carries a Region
    reports.instance('eu', { db: other.provides.n });
    // @ts-expect-error -- one plain segment: "." nests
    expect(() => reports.instance('eu.west')).toThrow(/one plain segment/);
    // @ts-expect-error -- "#" marks an instance
    expect(() => defineFeature('reports#eu')).toThrow(/marks an instance/);
  });
});
