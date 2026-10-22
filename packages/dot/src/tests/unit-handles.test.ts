/**
 * Units get handles exactly like features. An adapter's `provides` is one
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

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { Handle, Lazy, Provided } from '../unit-contract.js';
import { renderExplainText } from '../cli/render-explain.js';
import { textUi } from '../cli/tests/text-ui.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { providesOf } from '../feature.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { fake } from '../test-harness.js';
import { infra, rename } from '../unit-contract.js';

type Rows = { readonly url: string; readonly query: (sql: string) => readonly string[] };

/** A db-shaped adapter generic over nothing but its options — the type comes from the factory. */
function makeDb(url: string, opened: string[] = []) {
  return infra({
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

describe('unit handles are data before boot', () => {
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
    const reports = defineFeature('reports')
      .needs({ db: database.provides.db })
      .usecases({ report: ({ db }) => db.query('select 1') })
      .provides({ report: ({ usecases }) => usecases.report })
      .entrypoints();
    const app = orThrow(await defineApp('handles').infra(database).features([reports]).boot());
    expectTypeOf(app.services.report).toEqualTypeOf<readonly string[]>();
    expect(app.services.report).toEqual(['pg://main:select 1']);
    orThrow(await app.dispose());
    expect(opened).toEqual(['pg://main', 'closed:pg://main']);
  });

  it('a value-returning unit boot does not compile — publish through provides', () => {
    infra({
      name: 'legacy',
      // @ts-expect-error -- publish values through provides, never boot
      boot: () => ({ db: 1 }),
    });
    infra({
      name: 'legacy-async',
      // @ts-expect-error -- async publication also belongs in provides
      boot: async () => {
        await Promise.resolve();
        return { db: 1 };
      },
    });
    const sideEffectOnly = infra({ name: 'seed', boot: ({ $app }) => void $app });
    expect(Object.keys(sideEffectOnly.provides)).toEqual([]);
    expectTypeOf<keyof typeof sideEffectOnly.provides>().toEqualTypeOf<never>();
  });
});

describe('the kernel checks adapters at configure time', () => {
  it('a feature mounted before its db() adapter fails configure() with E020 naming .infra() — nothing boots', () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    const digest = defineFeature('daily-digest').needs({ db: database.provides.db }).entrypoints();
    // @ts-expect-error -- driven adapters cannot follow the domain; the erased path is the kernel's job
    const builder = defineApp('late-adapter').features([digest]).infra(database);
    expect(builder.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ProviderMountedLater,
        phase: 'configure',
        plugin: 'daily-digest',
        message: expect.stringContaining('Mount "db" with .infra() before "daily-digest".'),
      },
    });
    expect(opened).toEqual([]);
  });

  it('a ring through an adapter fails configure() with E019', () => {
    const billing = defineFeature('billing')
      .provides({ entitlements: () => ({ plan: 'pro' as const }) })
      .entrypoints();
    const audit = infra({
      name: 'audit',
      needs: { access: billing.provides.entitlements },
      provides: { audit: ({ access }) => ({ record: (what: string) => `${access.plan}:${what}` }) },
    });
    const ringed = defineFeature('billing')
      .needs({ audit: audit.provides.audit })
      .provides({ entitlements: () => ({ plan: 'pro' as const }) })
      .entrypoints();
    // @ts-expect-error -- audit needs entitlements, which nothing before it provides
    const builder = defineApp('ring').infra(audit).features([ringed]);
    expect(builder.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.CapabilityRing,
        message: expect.stringContaining('audit needs entitlements ← billing needs audit ← audit'),
      },
    });
  });

  it('dot explain draws the labelled db edge for an adapter consumer without booting', async () => {
    const opened: string[] = [];
    const database = makeDb('pg://main', opened);
    const digest = defineFeature('daily-digest').needs({ db: database.provides.db }).entrypoints();
    const configured = orThrow(defineApp('explain-db').infra(database).features([digest]).configure());
    const explained = textUi();
    renderExplainText(configured.manifest, explained.ui);
    const table = explained.text();
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

    const fresh = defineFeature('analytics').needs({ db: reportsDb.provides.reportsDb }).entrypoints();
    const app = orThrow(await defineApp('renamed').infra(reportsDb).features([fresh]).boot());
    expect(app.services.reportsDb.url).toBe('pg://reports');
    orThrow(await app.dispose());

    // A handle taken from the object before the rename keeps the old key.
    const stale = defineFeature('stale')
      .needs({ db: makeDb('pg://x').provides.db })
      .entrypoints();
    // @ts-expect-error -- `db` is not provided: only `reportsDb` is mounted
    const builder = defineApp('stale').infra(reportsDb).features([stale]);
    await expect(builder.boot()).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.UnsatisfiedNeed },
    });
  });
});

describe('handle.lazy', () => {
  it('delivers a Lazy<T> even when the provider is eager', async () => {
    const database = makeDb('pg://main');
    const slow = infra({
      name: 'slow',
      needs: { db: database.provides.db.lazy },
      provides: {
        first: async ({ db }) => {
          const rows = orThrow(await db.get());
          return rows.query('q')[0];
        },
      },
      boot: ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<Lazy<Rows>>();
      },
    });
    const app = orThrow(await defineApp('lazy').infra(database).infra(slow).boot());
    expect(app.services.first).toBe('pg://main:q');
    orThrow(await app.dispose());
  });
});

describe('fake(handle, value) and providesOf over units', () => {
  it('mounts a fake under the real handle, type-checked against it', async () => {
    const database = makeDb('pg://main');
    const reports = defineFeature('reports')
      .needs({ db: database.provides.db })
      .usecases({ report: ({ db }) => db.query('q') })
      .provides({ report: ({ usecases }) => usecases.report })
      .entrypoints();
    const fakeDb: Rows = { url: 'fake', query: () => ['faked'] };
    const app = orThrow(await defineApp('faked').infra(fake(database.provides.db, fakeDb)).features([reports]).boot());
    expect(app.services.report).toEqual(['faked']);
    expect(app.manifest.plugins[0]?.name).toBe('fake:db');
    orThrow(await app.dispose());

    // @ts-expect-error -- a wrong-shaped fake fails at the call site
    fake(database.provides.db, { url: 'fake' });
  });

  it('providesOf() merges unit handles with feature handles', () => {
    const database = makeDb('pg://main');
    const billing = defineFeature('billing')
      .provides({ entitlements: () => 'pro' as const })
      .entrypoints();
    const merged = providesOf([database, billing]);
    expect(Object.keys(merged)).toEqual(['db', 'entitlements']);
    expectTypeOf(merged.db).toEqualTypeOf<Handle<Rows, 'db', 'db'>>();
    expect(merged.db).toBe(database.provides.db);
  });
});
