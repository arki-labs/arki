/**
 * Plugins get handles exactly like features. An adapter's `provides` is one
 * factory per key, so `database.provides.db` is a typed handle before
 * anything boots. That is why these tests exist:
 *
 * - a consumer names the handle and never restates the adapter's type;
 * - the kernel checks order and rings against adapters at configure time,
 *   with the fix named — not E012 at boot;
 * - `rename()` moves the handle with the mounted object, so a stale handle
 *   fails loudly instead of silently aliasing;
 * - there is one way to publish: a value-returning `boot` does not compile.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Handle, Lazy, Provided } from '../plugin-contract.js';
import { runExplain } from '../cli/index.js';
import { defineApp } from '../define-app.js';
import { feature, providesOf } from '../feature.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { plugin, rename } from '../plugin-contract.js';
import { fake } from '../test-harness.js';

type Rows = { readonly url: string; readonly query: (sql: string) => readonly string[] };

/** A db-shaped adapter generic over nothing but its options — the type comes from the factory. */
function makeDb(url: string, opened: string[] = []) {
  return plugin({
    name: 'db',
    provides: {
      db: async (): Promise<Rows> => {
        await Promise.resolve();
        opened.push(url);
        return { url, query: sql => [`${url}:${sql}`] };
      },
    },
    dispose: ({ db }) => void opened.push(`closed:${db.url}`),
  });
}

describe('plugin handles are data before boot', () => {
  it('names its keys and provider without running a factory', () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    expect(Object.keys(database.provides)).toEqual(['db']);
    expect(database.provides.db).toMatchObject({ key: 'db', provider: 'db' });
    expect(database.provides.db.lazy).toMatchObject({ key: 'db', provider: 'db', lazy: true });
    expect(opened).toEqual([]);
    expectTypeOf(database.provides.db).toEqualTypeOf<Handle<Rows, 'db', 'db'>>();
    expectTypeOf<Provided<typeof database.provides.db>>().toEqualTypeOf<Rows>();
  });

  it('types a consumer from the handle alone; dispose sees the factory value', async () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    const reports = feature('reports', {
      needs: { db: database.provides.db },
      provides: { report: ({ db }) => db.query('select 1') },
    });
    const app = await defineApp('handles').use(database).features([reports]).boot();
    expectTypeOf(app.services.report).toEqualTypeOf<readonly string[]>();
    expect(app.services.report).toEqual(['pg://main:select 1']);
    await app.dispose();
    expect(opened).toEqual(['pg://main', 'closed:pg://main']);
  });

  it('a value-returning plugin boot does not compile — publish through provides', () => {
    plugin({
      name: 'legacy',
      // @ts-expect-error -- boot is side effects only
      boot: () => ({ db: 1 }),
    });
    plugin({
      name: 'legacy-async',
      // @ts-expect-error -- an async boot resolving to a value is the same mistake
      boot: async () => {
        await Promise.resolve();
        return { db: 1 };
      },
    });
    const sideEffectOnly = plugin({ name: 'seed', boot: ({ $app }) => void $app });
    expect(Object.keys(sideEffectOnly.provides)).toEqual([]);
    expectTypeOf<keyof typeof sideEffectOnly.provides>().toEqualTypeOf<never>();
  });
});

describe('the kernel checks adapters at configure time', () => {
  it('a feature mounted before its db() adapter fails configure() with E020 naming .use() — nothing boots', () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    const digest = feature('daily-digest', { needs: { db: database.provides.db } });
    // @ts-expect-error -- driven adapters cannot follow the domain; the erased path is the kernel's job
    const builder = defineApp('late-adapter').features([digest]).use(database);
    expect(() => builder.configure()).toThrow(
      expect.objectContaining({
        code: DotLifecycleErrorCode.ProviderMountedLater,
        phase: 'configure',
        plugin: 'daily-digest',
        message: expect.stringContaining('Mount "db" with .use() before "daily-digest".'),
      }),
    );
    expect(opened).toEqual([]);
  });

  it('a ring through an adapter fails configure() with E019', () => {
    const billing = feature('billing', {
      provides: { entitlements: () => ({ plan: 'pro' as const }) },
    });
    const audit = plugin({
      name: 'audit',
      needs: { access: billing.provides.entitlements },
      provides: { audit: ({ access }) => ({ record: (what: string) => `${access.plan}:${what}` }) },
    });
    const ringed = feature('billing', {
      needs: { audit: audit.provides.audit },
      provides: { entitlements: () => ({ plan: 'pro' as const }) },
    });
    // @ts-expect-error -- audit needs entitlements, which nothing before it provides
    const builder = defineApp('ring').use(audit).features([ringed]);
    expect(() => builder.configure()).toThrow(
      expect.objectContaining({
        code: DotLifecycleErrorCode.CapabilityRing,
        message: expect.stringContaining('audit needs entitlements ← billing needs audit ← audit'),
      }),
    );
  });

  it('dot explain draws the labelled db edge for an adapter consumer without booting', async () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    const digest = feature('daily-digest', { needs: { db: database.provides.db } });
    const configured = defineApp('explain-db').use(database).features([digest]).configure();
    let table = '';
    await runExplain(configured, { json: false, out: line => (table += line) });
    expect(table).toContain('daily-digest --[db]--> db');
    expect(configured.manifest.plugins.find(p => p.name === 'db')?.provides).toEqual(['db']);
    expect(configured.manifest.dependencies).toEqual([{ from: 'daily-digest', to: 'db', kind: 'requires', key: 'db' }]);
    expect(opened).toEqual([]);
  });
});

describe('rename() moves the handle with the mounted object', () => {
  it('types the renamed handle, rejects the stale one at compile time and at boot', async () => {
    const reportsDb = rename(makeDb('pg://reports'), { db: 'reportsDb' }, 'reports-db');
    expect(reportsDb.provides.reportsDb).toMatchObject({ key: 'reportsDb', provider: 'reports-db' });
    expectTypeOf(reportsDb.provides.reportsDb).toEqualTypeOf<Handle<Rows, 'reportsDb', 'reports-db'>>();
    // @ts-expect-error -- the old key is gone after rename
    expect(reportsDb.provides.db).toBeUndefined();

    const fresh = feature('analytics', { needs: { db: reportsDb.provides.reportsDb } });
    const app = await defineApp('renamed').use(reportsDb).features([fresh]).boot();
    expect(app.services.reportsDb.url).toBe('pg://reports');
    await app.dispose();

    // A handle taken from the object before the rename keeps the old key.
    const stale = feature('stale', { needs: { db: makeDb('pg://x').provides.db } });
    // @ts-expect-error -- `db` is not provided: only `reportsDb` is mounted
    const builder = defineApp('stale').use(reportsDb).features([stale]);
    await expect(builder.boot()).rejects.toMatchObject({ code: DotLifecycleErrorCode.UnsatisfiedNeed });
  });
});

describe('handle.lazy', () => {
  it('delivers a Lazy<T> even when the provider is eager', async () => {
    const database = makeDb('pg://main');
    const slow = plugin({
      name: 'slow',
      needs: { db: database.provides.db.lazy },
      provides: {
        first: async ({ db }) => {
          const rows = await db.get();
          return rows.query('q')[0];
        },
      },
      boot: ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Rows>>();
      },
    });
    const app = await defineApp('lazy').use(database).use(slow).boot();
    expect(app.services.first).toBe('pg://main:q');
    await app.dispose();
  });
});

describe('fake(handle, value) and providesOf over plugins', () => {
  it('mounts a fake under the real handle, type-checked against it', async () => {
    const database = makeDb('pg://main');
    const reports = feature('reports', {
      needs: { db: database.provides.db },
      provides: { report: ({ db }) => db.query('q') },
    });
    const fakeDb: Rows = { url: 'fake', query: () => ['faked'] };
    const app = await defineApp('faked').use(fake(database.provides.db, fakeDb)).features([reports]).boot();
    expect(app.services.report).toEqual(['faked']);
    expect(app.manifest.plugins[0]?.name).toBe('fake:db');
    await app.dispose();

    // @ts-expect-error -- a wrong-shaped fake fails at the call site
    fake(database.provides.db, { url: 'fake' });
  });

  it('providesOf() merges plugin handles with feature handles', () => {
    const database = makeDb('pg://main');
    const billing = feature('billing', { provides: { entitlements: () => 'pro' as const } });
    const merged = providesOf([database, billing]);
    expect(Object.keys(merged)).toEqual(['db', 'entitlements']);
    expectTypeOf(merged.db).toEqualTypeOf<Handle<Rows, 'db', 'db'>>();
    expect(merged.db).toBe(database.provides.db);
  });
});
