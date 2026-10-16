/**
 * Identity, not shape: the types read WHICH handle a need names, as the
 * runtime does. Two graphs found in round 9 (docs/arki/research/09-di-typing)
 * compiled with zero diagnostics and failed later:
 *
 * - A1: a child needs the GLOBAL `database.provides.db`; its parent owns a
 *   same-shaped private infra `db`. The type-level remap went by key, so the
 *   app compiled without `database` and booted into `UnsatisfiedNeed` (E012).
 * - A2: an infra plugin binds its need to `dbB.provides.db`; the feature
 *   declares `dbA.provides.db`. The shapes matched; `.infra()` threw E026.
 *
 * Both are compile errors now, at the step that can see them. Their
 * compiling twins boot, so the runtime and the types agree either way.
 */
import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { defineFeature, entrypointOnly } from '../define-feature.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { plugin, service } from '../plugin-contract.js';
import { testApp } from '../test-harness.js';

type Db = { readonly query: (sql: string) => Promise<readonly string[]> };
const dbOf = (tag: string) => (): Db => ({ query: sql => Promise.resolve([`${tag}:${sql}`]) });

describe('A1: a child need is remapped onto the parent only when it names the parent’s own infra handle', () => {
  const database = plugin({ name: 'database', provides: { db: dbOf('global') } });
  const privateDb = plugin({ name: 'private-db', provides: { db: dbOf('private') } });

  const readsGlobal = defineFeature('parent.child')
    .needs({ db: database.provides.db })
    .provides({ reader: ({ db }) => ({ run: () => db.query('x') }) })
    .entrypoints();
  const parent = defineFeature('parent').infra(privateDb).features(readsGlobal).entrypoints();

  const readsOwn = defineFeature('owner.child')
    .needs({ db: privateDb.provides.db })
    .provides({ reader: ({ db }) => ({ run: () => db.query('x') }) })
    .entrypoints();
  const owner = defineFeature('owner').infra(privateDb).features(readsOwn).entrypoints();

  it('the global handle stays a global need: the app must provide it', async () => {
    // @ts-expect-error -- `db` of "parent.child" is `database`'s handle; the parent's private `db` is another service
    const hole = defineApp('hole').features([parent]);
    await expect(hole.boot()).rejects.toMatchObject({ code: DotLifecycleErrorCode.UnsatisfiedNeed });

    const app = await defineApp('ok').infra(database).features([parent]).start();
    await expect(app.services['parent.child.reader'].run()).resolves.toEqual(['global:x']);
    await app.dispose();
  });

  it('the parent’s own infra handle is remapped: no global provider needed', async () => {
    const app = await defineApp('own').features([owner]).start();
    await expect(app.services['owner.child.reader'].run()).resolves.toEqual(['private:x']);
    await app.dispose();
  });

  it('the raw unit list says the same thing', async () => {
    // @ts-expect-error -- the raw list needs `db` before anything provides it; the type guard on testApp's argument says so too
    await expect(testApp(parent.plugins()).boot()).rejects.toMatchObject({
      code: DotLifecycleErrorCode.UnsatisfiedNeed,
    });
    const app = await testApp(owner.plugins()).boot();
    await app.dispose();
  });
});

describe('A2: an infra plugin bound to a handle must be bound to the feature’s handle', () => {
  const dbA = plugin({ name: 'dbA', provides: { db: dbOf('a') } });
  const dbB = plugin({ name: 'dbB', provides: { db: dbOf('b') } });
  const storeBoundToB = plugin({
    name: 'store',
    needs: { db: dbB.provides.db },
    provides: { repos: ({ db }) => ({ all: () => db.query('all') }) },
  });

  it('another plugin’s same-shaped handle is refused at .infra()', () => {
    expect(() =>
      // @ts-expect-error -- the store binds `db` to "dbB"; this feature's `db` is "dbA"
      defineFeature('f').needs({ db: dbA.provides.db }).infra(storeBoundToB),
    ).toThrow(/binds "db" to a handle other than the feature's/);
  });

  it('the same handle, plain or entrypoint-only, is accepted', async () => {
    const plain = defineFeature('g').needs({ db: dbB.provides.db }).infra(storeBoundToB).entrypoints();
    const flagged = defineFeature('h')
      .needs({ db: entrypointOnly(dbB.provides.db) })
      .infra(storeBoundToB)
      .entrypoints();
    const app = await defineApp('ok').infra(dbB).features([plain, flagged]).start();
    await expect(app.services['g.repos'].all()).resolves.toEqual(['b:all']);
    await app.dispose();
  });

  it('a feature that declares the need anonymously cannot take a bound plugin', () => {
    const anonymous = defineFeature('k').needs({ db: service<Db>() });
    expect(() =>
      // @ts-expect-error -- the store binds `db` to "dbB"; an anonymous need is not that handle
      anonymous.infra(storeBoundToB),
    ).toThrow(/binds "db" to a handle other than the feature's/);
  });
});
