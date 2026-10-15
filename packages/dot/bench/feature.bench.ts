// Feature declarations: @arki/dot/feature against the hand-written wiring it replaces.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// There is no npm competitor, so each table ranks @arki/dot/feature against the
// loop a team writes by hand, only where both return the same record. The
// hand-written merge without a duplicate-key check keeps a weaker promise and
// is shown without a ratio.

import type { AnyFeature, FeatureSlice } from '../src/feature.js';
import { compare, defineSuite } from '@arki/bench';
import { composeRepos, composeRouter, feature } from '../src/feature.js';

type Db = { tag: string };
type Repo = { database: Db; kind: string };
type Fragment = { list: string; get: string };

/** What one feature declares: router fragments, repository factories, boot-time slices. */
type Spec = {
  name: string;
  router?: Record<string, Fragment>;
  repos?: Record<string, (database: Db) => Repo>;
  use?: FeatureSlice<string, { job: number }, unknown>[];
};

/** A plain value of the same shape, written by hand. */
type HandFeature = {
  name: string;
  router: Record<string, Fragment>;
  repos: Record<string, (database: Db) => Repo>;
  use: readonly FeatureSlice<string, { job: number }, unknown>[];
  actions: readonly never[];
  needs: Record<string, never>;
  factories: Record<string, never>;
  boot: undefined;
  provides: Record<string, never>;
};

const db: Db = { tag: 'db' };

const fragment = (key: string): Fragment => ({ list: `${key}.list`, get: `${key}.get` });

/** One full feature: one router fragment, one repository factory, one boot-time slice. */
function full(index: number, name = `feature${index}`): Spec {
  return {
    name,
    router: { [name]: fragment(name) },
    repos: { [name]: database => ({ database, kind: `${name}-repo` }) },
    use: [{ key: 'queue', actions: [], resolve: () => ({ job: index }) }],
  };
}

/** A feature that mounts three router fragments and declares nothing else. */
function routerOnly(index: number): Spec {
  const name = `api${index}`;
  return {
    name,
    router: {
      [`${name}a`]: fragment(`${name}a`),
      [`${name}b`]: fragment(`${name}b`),
      [`${name}c`]: fragment(`${name}c`),
    },
  };
}

// Inputs: plain-data recipes for lists of distinct features, so the harness can copy
// them per case; the specs (with their repository factories) are built in `setup`.
// No list repeats a router or repo key: a duplicate makes @arki/dot/feature throw,
// which is the check, not the timed path.
type Recipe = { kind: 'full'; index: number; name?: string } | { kind: 'router'; index: number };
const build = (recipes: readonly Recipe[]): Spec[] =>
  recipes.map(recipe => (recipe.kind === 'full' ? full(recipe.index, recipe.name) : routerOnly(recipe.index)));

const fullRecipes = (count: number): Recipe[] => Array.from({ length: count }, (_, index) => ({ kind: 'full', index }));
const lists: Recipe[][] = [
  fullRecipes(50),
  fullRecipes(1),
  [],
  Array.from({ length: 10 }, (_, index): Recipe => ({ kind: index % 2 === 0 ? 'full' : 'router', index })),
  [
    { kind: 'full', index: 0, name: 'café' },
    { kind: 'full', index: 1, name: '注文' },
    { kind: 'full', index: 2, name: 'a-b_c' },
  ],
];

const defineAll = (specs: readonly Spec[]) => specs.map(spec => feature(spec.name, spec));

// The same defaults `feature` fills in, written by hand.
const handDefine = (spec: Spec): HandFeature => ({
  name: spec.name,
  router: spec.router ?? {},
  repos: spec.repos ?? {},
  use: spec.use ?? [],
  actions: [],
  needs: {},
  factories: {},
  boot: undefined,
  provides: {},
});
const handDefineAll = (specs: readonly Spec[]): HandFeature[] => specs.map(spec => handDefine(spec));

// Hand-written composition, the way a backend does it before reaching for a helper.
function handRouter(features: readonly HandFeature[]): Record<string, Fragment> {
  const merged: Record<string, Fragment> = {};
  for (const feature of features) Object.assign(merged, feature.router);
  return merged;
}

function handRouterChecked(features: readonly HandFeature[]): Record<string, Fragment> {
  const merged: Record<string, Fragment> = {};
  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.router)) {
      if (key in merged) throw new Error(`duplicate router key ${key}`);
      merged[key] = value;
    }
  }
  return merged;
}

function handRepos(features: readonly HandFeature[], database: Db): Record<string, Repo> {
  const repos: Record<string, Repo> = {};
  for (const feature of features) {
    for (const [key, factory] of Object.entries(feature.repos)) repos[key] = factory(database);
  }
  return repos;
}

function handReposChecked(features: readonly HandFeature[], database: Db): Record<string, Repo> {
  const repos: Record<string, Repo> = {};
  for (const feature of features) {
    for (const [key, factory] of Object.entries(feature.repos)) {
      if (key in repos) throw new Error(`duplicate repo key ${key}`);
      repos[key] = factory(database);
    }
  }
  return repos;
}

/** Every feature as one comparable line: its name and the keys it declares, with the defaults filled in. */
const describe = (features: readonly AnyFeature[] | readonly HandFeature[]): string[] =>
  features.map(
    feature =>
      `${feature.name} router=${Object.keys(feature.router).join('+')} repos=${Object.keys(feature.repos).join('+')} use=${feature.use.map(slice => slice.key).join('+')} actions=${feature.actions.length} needs=${Object.keys(feature.needs).length} provides=${Object.keys(feature.provides).join('+')} boot=${typeof feature.boot}`,
  );

const unchecked = 'no duplicate-key check: a repeated key silently overwrites the earlier one';

export default defineSuite({
  id: '@arki/dot/feature',
  intro:
    'There is no direct npm competitor for `@arki/dot/feature`: it is a small declaration layer for backend domain modules. So the comparison is against the hand-written wiring a team would write without it: a plain object of the same shape and a loop that merges them. The main input is 50 features, each with a router fragment, a repository factory and a boot-time slice; smaller and mixed lists are checked too.',
  notes: [
    '`feature` copies a spec into the declared shape and fills in defaults. The hand-written object fills in the same defaults and does no checking.',
    '`composeRouter` and `composeRepos` throw a coded error when two features claim the same key (and fail to compile under TypeScript). The plain merge (`Object.assign`) silently lets the last feature win, so it keeps a weaker promise and has no ratio; the ranked hand-written row is the loop with its own duplicate check.',
    'The checked inputs never repeat a key: throwing on a duplicate is the check itself, not the path a running app takes.',
    'All of this runs once at module load, not per request. The numbers show it costs microseconds, not that it needs tuning.',
  ],
  groups: [
    compare<Recipe[]>({
      id: 'define',
      title: 'Declare features',
      note: 'Build the feature values from ready-made specs.',
      contract: {
        id: 'feature-define/v1',
        description:
          'one value per spec with name, router, repos and use, and empty defaults for what the spec leaves out',
      },
      inputs: lists,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/dot/feature feature',
          package: '@arki/dot/feature',
          setup: build,
          run: defineAll,
          normalize: describe,
        }),
        hand: c({ label: 'hand-written object literal', setup: build, run: handDefineAll, normalize: describe }),
      }),
    }),
    compare<Recipe[]>({
      id: 'compose-router',
      title: 'Compose the router fragments',
      note: '`composeRouter` rejects duplicate mount keys. The first hand-written row does not check; the second does.',
      contract: {
        id: 'feature-compose-router/v1',
        description: 'one router holding every mount key and fragment, throwing when two features claim the same key',
      },
      inputs: lists,
      expected: recipes => Object.fromEntries(build(recipes).flatMap(spec => Object.entries(spec.router ?? {}))),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/dot/feature composeRouter',
          package: '@arki/dot/feature',
          setup: recipes => defineAll(build(recipes)),
          run: features => composeRouter(features),
        }),
        handChecked: c({
          label: 'hand-written merge with duplicate check',
          setup: recipes => handDefineAll(build(recipes)),
          run: handRouterChecked,
        }),
        hand: c({
          label: 'hand-written merge (Object.assign, no check)',
          differs: unchecked,
          setup: recipes => handDefineAll(build(recipes)),
          run: handRouter,
        }),
      }),
    }),
    compare<Recipe[]>({
      id: 'compose-repos',
      title: 'Build the repositories over one database handle',
      note: 'Calls each repository factory once. `composeRepos` rejects duplicate repo keys; the hand-written rows show the loop without and with that check.',
      contract: {
        id: 'feature-compose-repos/v1',
        description:
          'one repository per repo key, built from the shared handle, throwing when two features claim the same key',
      },
      inputs: lists,
      expected: recipes =>
        Object.fromEntries(
          build(recipes)
            .flatMap(spec => Object.keys(spec.repos ?? {}))
            .map(key => [key, { database: db, kind: `${key}-repo` }]),
        ),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/dot/feature composeRepos',
          package: '@arki/dot/feature',
          setup: recipes => defineAll(build(recipes)),
          run: features => composeRepos(features, db),
        }),
        handChecked: c({
          label: 'hand-written loop with duplicate check',
          setup: recipes => handDefineAll(build(recipes)),
          run: features => handReposChecked(features, db),
        }),
        hand: c({
          label: 'hand-written loop (no check)',
          differs: unchecked,
          setup: recipes => handDefineAll(build(recipes)),
          run: features => handRepos(features, db),
        }),
      }),
    }),
  ],
});
