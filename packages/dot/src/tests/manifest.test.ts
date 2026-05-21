/**
 * Manifest contract tests for the DOT kernel.
 *
 * The manifest exposes five top-level arrays — plugins, routes, services,
 * lifecycle, dependencies — even on an empty app.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { defineDotPlugin } from '../plugin-contract.js';

describe('DOT manifest', () => {
  it('exposes all five arrays on an empty app', async () => {
    const app = await defineApp('empty-app', { version: '1.0.0' }).boot();
    expect(app.manifest).toEqual({
      app: { name: 'empty-app', version: '1.0.0' },
      plugins: [],
      routes: [],
      services: [],
      lifecycle: [],
      dependencies: [],
    });
    await app.dispose();
  });

  it('reflects plugin contributions: services + routes registered in configure', async () => {
    const billing = defineDotPlugin({
      name: 'billing',
      version: '2.3.4',
      configure: ctx => {
        ctx.registerService('stripe', 'custom');
        ctx.registerRoute({ id: 'billing.charge', method: 'POST', path: '/charge', transport: 'http' });
        ctx.declareProvides('payments');
      },
    });

    const app = await defineApp('test').use(billing).boot();
    const m = app.manifest;
    expect(m.plugins).toEqual([{ name: 'billing', version: '2.3.4', dependencies: [], provides: ['payments'] }]);
    expect(m.routes).toEqual([
      {
        id: 'billing.charge',
        plugin: 'billing',
        method: 'POST',
        path: '/charge',
        transport: 'http',
      },
    ]);
    expect(m.services).toEqual([{ name: 'stripe', plugin: 'billing', kind: 'custom' }]);
    await app.dispose();
  });

  it('lifecycle entries include every hook the plugin participates in', async () => {
    const noop = () => {
      // intentional no-op — we only care that the plugin object exposes the hook.
    };
    const p = defineDotPlugin({
      name: 'p',
      configure: noop,
      boot: () => ({}),
      start: noop,
      stop: noop,
      dispose: noop,
    });
    const app = await defineApp('test').use(p).start();
    expect(app.manifest.lifecycle).toEqual([
      { plugin: 'p', hooks: expect.arrayContaining(['configure', 'boot', 'start']) },
    ]);
    // Hooks are detected from the plugin shape, so all five are included.
    expect(app.manifest.lifecycle[0]!.hooks).toEqual(
      expect.arrayContaining(['configure', 'boot', 'start', 'stop', 'dispose']),
    );
    await app.dispose();
  });

  it('dependency edges reflect plugin.dependencies declarations', async () => {
    const a = defineDotPlugin({ name: 'a' });
    const b = defineDotPlugin({ name: 'b', dependencies: ['a'] });
    const c = defineDotPlugin({ name: 'c', dependencies: ['b'] });
    const app = await defineApp('test').use(a).use(b).use(c).boot();
    expect(app.manifest.dependencies).toEqual(
      expect.arrayContaining([
        { from: 'b', to: 'a', kind: 'requires' },
        { from: 'c', to: 'b', kind: 'requires' },
      ]),
    );
    expect(app.manifest.dependencies).toHaveLength(2);
    await app.dispose();
  });

  it('snapshot stability — same plugins produce equal manifests across runs', async () => {
    const p = defineDotPlugin({
      name: 'p',
      configure: ctx => {
        ctx.registerService('logger', 'logger');
        ctx.registerRoute({ id: 'p.ping', transport: 'orpc' });
      },
    });

    const app1 = await defineApp('test').use(p).boot();
    const app2 = await defineApp('test').use(p).boot();
    expect(app1.manifest).toEqual(app2.manifest);
    await app1.dispose();
    await app2.dispose();
  });
});
