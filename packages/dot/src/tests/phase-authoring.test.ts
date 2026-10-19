import { describe, expect, it } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { driver, feature } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { plugin } from '../plugin-contract.js';

const Refused = defineFailure('test.phase_authoring.refused');

describe('lifecycle authoring', () => {
  it('runs object feature hooks with its provided service before driving adapters', async () => {
    const calls: string[] = [];
    const factory = initPlugins.context<{ value: number }>().create();
    const app = orThrow(
      await defineApp('object-hooks')
        .features([
          feature('domain', {
            configure() {
              calls.push('feature.configure');
            },
            provides: { value: () => 42 },
            start({ value }) {
              calls.push(`feature.start:${value}`);
            },
            stop({ value }) {
              calls.push(`feature.stop:${value}`);
            },
            dispose({ value }) {
              calls.push(`feature.dispose:${value}`);
            },
          }),
        ])
        .serve(
          driver(() =>
            factory.plugin({
              name: 'driving',
              needs: ['value'],
              start({ value }) {
                calls.push(`driver.start:${value}`);
              },
              stop({ value }) {
                calls.push(`driver.stop:${value}`);
              },
              dispose({ value }) {
                calls.push(`driver.dispose:${value}`);
              },
            }),
          ),
        )
        .start(),
    );
    orThrow(await app.dispose());
    expect(calls).toEqual([
      'feature.configure',
      'feature.start:42',
      'driver.start:42',
      'driver.stop:42',
      'feature.stop:42',
      'driver.dispose:42',
      'feature.dispose:42',
    ]);
  });

  it('runs a spread override of configure instead of its original callback', () => {
    const failure = Refused();
    let originalCalls = 0;
    const original = plugin({
      name: 'original',
      configure() {
        originalCalls++;
      },
    });
    const overridden = { ...original, hooks: { ...original.hooks, configure: () => failure } };
    expect(defineApp('configure-override').use(overridden).configure()).toBe(failure);
    expect(originalCalls).toBe(0);
  });

  it('runs a spread override of start instead of its original callback', async () => {
    const failure = Refused();
    let originalCalls = 0;
    const original = plugin({
      name: 'original',
      start() {
        originalCalls++;
      },
    });
    const overridden = { ...original, hooks: { ...original.hooks, start: () => failure } };
    expect(await defineApp('start-override').use(overridden).start()).toBe(failure);
    expect(originalCalls).toBe(0);
  });

  it.each(['stop', 'dispose'])('runs a spread override of %s during shutdown', async phase => {
    const failure = Refused();
    const original = plugin({
      name: 'original',
      stop() {
        /* The override must replace this callback. */
      },
      dispose() {
        /* The override must replace this callback. */
      },
    });
    const overridden = { ...original, hooks: { ...original.hooks, [phase]: () => failure } };
    const app = orThrow(await defineApp('shutdown-override').use(overridden).start());
    expect(await app.dispose()).toBe(failure);
  });

  it('preserves a returned feature configure failure', () => {
    const failure = Refused();
    const configured = defineApp('feature-configure-refusal')
      .features([feature('domain', { configure: () => failure })])
      .configure();
    expect(configured).toBe(failure);
  });

  it('preserves a returned key-array plugin start failure', async () => {
    const failure = Refused();
    const factory = initPlugins.context<{ value: number }>().create();
    const started = await defineApp('key-array-start-refusal')
      .use(factory.plugin({ name: 'refused', start: () => Promise.resolve(failure) }))
      .start();
    expect(started).toBe(failure);
  });

  it('preserves a returned witness plugin dispose failure', async () => {
    const failure = Refused();
    const factory = initPlugins.context<{ value: number }>().create();
    const app = orThrow(
      await defineApp('witness-dispose-refusal')
        .use(factory.plugin({ name: 'refused', needs: {}, dispose: () => Promise.resolve(failure) }))
        .boot(),
    );
    expect(await app.dispose()).toBe(failure);
  });
});
