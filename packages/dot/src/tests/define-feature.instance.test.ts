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

import { renderExplain } from '../cli/render-explain.js';
import { defineFeature, instanceOf, mountFeatures, routerFor } from '../feature.js';
import { defineApp } from '../index.js';
import { rpc } from '../orpc.js';
import { plugin, rename, service } from '../plugin-contract.js';

type Region = { readonly region: string; readonly rows: string[] };
const regionDb = (region: string) =>
  plugin({ name: 'database', provides: { db: (): Region => ({ region, rows: [] }) } });
const database = regionDb('us');
const databaseEu = rename(regionDb('eu'), { db: 'dbEu' }, 'databaseEu');

const store = plugin({
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
    expectTypeOf(eu.handles.db.key).toEqualTypeOf<'dbEu'>();
    expect(eu.plugins().map(u => u.name)).toEqual(['reports#eu/store', 'reports#eu']);

    const app = await defineApp('t').use(database).use(databaseEu).features([eu, us]).boot();
    try {
      expect(app.services['reports#eu.summary']).toEqual({ region: 'eu' });
      expect(app.services['reports#us.summary']).toEqual({ region: 'us' });
    } finally {
      await app.dispose();
    }
  });

  it('mounts the original next to a copy; the original twice is still refused', async () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    expect(() => mountFeatures([reports, eu])).not.toThrow();
    const app = await defineApp('t').use(database).use(databaseEu).features([reports, eu]).boot();
    try {
      expect(app.services.summary).toEqual({ region: 'us' });
      expect(app.services['reports#eu.summary']).toEqual({ region: 'eu' });
    } finally {
      await app.dispose();
    }
    // @ts-expect-error -- the same feature twice: one plugin name, one `summary` wire key
    await expect(defineApp('t').use(database).features([reports, reports]).boot()).rejects.toThrow();
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
    expectTypeOf(eu.features[0].handles.db.key).toEqualTypeOf<'dbEu'>();
    const childNeeds = eu
      .plugins()
      .filter(u => u.name === 'reports#eu.audit')
      .flatMap(u => Object.values(u.needs).map(w => ('key' in w ? w.key : undefined)));
    expect(childNeeds).toEqual(['dbEu']);

    const app = await defineApp('t').use(databaseEu).features([eu]).boot();
    try {
      expect(app.services['reports#eu.audit.trail']).toBe('eu');
    } finally {
      await app.dispose();
    }
  });

  it('follows the rebind for a lazy child need, with the new lazy form', async () => {
    const audit = defineFeature('reports.audit')
      .needs({ db: database.provides.db.lazy })
      .usecases({
        region:
          ({ db }) =>
          async () =>
            (await db.get()).region,
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
    expectTypeOf(eu.features[0].handles.db).toEqualTypeOf<typeof databaseEu.provides.dbEu.lazy>();
    const app = await defineApp('t').use(databaseEu).features([eu]).boot();
    try {
      // The kernel awaits a provides factory, so the resolved trail is the EU region string.
      expect(app.services['reports#eu.audit.trail']).toBe('eu');
    } finally {
      await app.dispose();
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

  it('keeps the instance name through override() and shows the copies in `dot explain`', async () => {
    const eu = reports.instance('eu', { db: databaseEu.provides.dbEu });
    const us = reports.instance('us').override({ repos: { region: () => 'faked' } });
    expect(us.name).toBe('reports#us');
    const configured = await defineApp('t').use(database).use(databaseEu).features([eu, us]).configure();
    let text = '';
    renderExplain({ manifest: configured.manifest }, { json: false, out: line => (text += line) });
    const names = configured.manifest.plugins.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['reports#eu/store', 'reports#eu', 'reports#us/store', 'reports#us']));
    expect(text).toContain('reports#eu --[reports#eu.repos]--> reports#eu/store');
    expect(text).toContain('reports#us --[reports#us.repos]--> reports#us/store');
  });

  it('instanceOf(): the instance segment of a name, for adapters', () => {
    expect(instanceOf('reports#eu')).toBe('eu');
    expect(instanceOf('reports#eu.audit')).toBe('eu');
    expect(instanceOf('reports#eu.audit.deep')).toBe('eu');
    expect(instanceOf('reports')).toBeUndefined();
    expect(instanceOf('reports.audit')).toBeUndefined();
  });

  it('refuses a rebind of a non-need, another service type, a bad instance name and `#` in a declared name', () => {
    // @ts-expect-error -- `x` is not a need of `reports`
    expect(() => reports.instance('eu', { x: databaseEu.provides.dbEu })).toThrow(/not a need/);
    const other = plugin({ name: 'other', provides: { n: () => 1 } });
    // @ts-expect-error -- `n` carries a number; `db` carries a Region
    reports.instance('eu', { db: other.provides.n });
    // @ts-expect-error -- one plain segment: "." nests
    expect(() => reports.instance('eu.west')).toThrow(/one plain segment/);
    // @ts-expect-error -- "#" marks an instance
    expect(() => defineFeature('reports#eu')).toThrow(/marks an instance/);
  });
});
