/**
 * `fromFeatures` at runtime: one declaration, bound once per app.
 *
 * Why these tests exist: a `fromFeatures` unit (the journal worker, the
 * scheduler, the HTTP server) keeps a live resource between its hooks. Two
 * apps built from the same declaration must each get their own `$state`, or
 * stopping one app would stop the other's worker. And every factory and hook
 * must see the app's real mounted feature list, because adapters build their
 * handlers and actions from it.
 */
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { defineFeature } from '../feature.js';
import { entrypoint, infra } from '../unit-contract.js';

const orders = defineFeature('orders').entrypoints();
const billing = defineFeature('billing').entrypoints();

describe('fromFeatures', () => {
  it('gives each app that binds one declaration its own $state', async () => {
    const made: { started: number; stopped: number }[] = [];
    const worker = entrypoint.fromFeatures({
      name: 'worker',
      state: () => {
        const state = { started: 0, stopped: 0 };
        made.push(state);
        return state;
      },
      start({ $state }) {
        $state.started += 1;
      },
      stop({ $state }) {
        $state.stopped += 1;
      },
    });
    const first = orThrow(await defineApp('first').features([orders]).entrypoints(worker).start());
    const second = orThrow(await defineApp('second').features([billing]).entrypoints(worker).start());
    expect(made).toHaveLength(2);
    expect(made[0]).not.toBe(made[1]);
    orThrow(await first.stop());
    // Stopping the first app touched only the first app's state.
    expect(made).toEqual([
      { started: 1, stopped: 1 },
      { started: 1, stopped: 0 },
    ]);
    orThrow(await first.dispose());
    orThrow(await second.dispose());
  });

  it('hands every factory and hook the mounted feature list as $features', async () => {
    const seen: string[] = [];
    const record = (where: string, features: readonly { readonly name: string }[]) =>
      seen.push(`${where}:${features.map(f => f.name).join(',')}`);
    const registry = infra.fromFeatures({
      name: 'registry',
      configure: ({ $features }) => {
        record('configure', $features);
      },
      provides: {
        registry: ({ $features }) => {
          record('provides', $features);
          return $features.length;
        },
      },
      boot: ({ $features }) => {
        record('boot', $features);
      },
      start: ({ $features }) => {
        record('start', $features);
      },
      stop: ({ $features }) => {
        record('stop', $features);
      },
      dispose: ({ $features }) => {
        record('dispose', $features);
      },
    });
    const app = orThrow(await defineApp('listed').infra(registry).features([orders, billing]).start());
    expect(app.services.registry).toBe(2);
    orThrow(await app.dispose());
    expect(seen).toEqual(
      ['configure', 'provides', 'boot', 'start', 'stop', 'dispose'].map(where => `${where}:orders,billing`),
    );
  });

  it('derives static actions from the features when actions is a function', async () => {
    const consumer = entrypoint.fromFeatures({
      name: 'consumer',
      actions: features =>
        features.map(f => ({
          id: `${f.name}:sync.consume`,
          binding: 'queue',
          direction: 'in' as const,
          address: `${f.name}:sync`,
        })),
    });
    const app = orThrow(defineApp('actions').features([orders, billing]).entrypoints(consumer).configure());
    expect(app.manifest.actions.filter(a => a.plugin === 'consumer').map(a => a.id)).toEqual([
      'orders:sync.consume',
      'billing:sync.consume',
    ]);
  });

  it('resolves a need on a binder handle to the value its factory returned', async () => {
    const appJournal = infra.fromFeatures({
      name: 'journal',
      provides: { journal: ({ $features }) => ({ features: $features.length }) },
    });
    const reader = defineFeature('reader')
      .needs({ journal: appJournal.provides.journal })
      .usecases({ count: ({ journal }: { readonly journal: { readonly features: number } }) => journal.features })
      .provides({ count: ({ usecases }) => usecases.count })
      .entrypoints();
    const app = orThrow(await defineApp('handles').infra(appJournal).features([orders, reader]).boot());
    expect(app.services.count).toBe(2);
    orThrow(await app.dispose());
  });

  it('names a misplaced binder by its own name', () => {
    const worker = entrypoint.fromFeatures({ name: 'worker' });
    // @ts-expect-error an entrypoint binder cannot be mounted as infra; the runtime check names it too
    const misplaced = defineApp('misplaced').infra(worker);
    expect(misplaced.configure()).toMatchObject({
      cause: { code: 'ARKI_DOT_E033', message: expect.stringContaining('Unit "worker" is an entrypoint unit') },
    });
  });
});
