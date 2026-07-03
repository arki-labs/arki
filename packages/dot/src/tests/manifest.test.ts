/**
 * Manifest contract tests for the DOT kernel (v2).
 *
 * The manifest exposes five top-level arrays — pips, routes, services,
 * lifecycle, dependencies — even on an empty app. Dependency edges are
 * observed from actual service wiring at boot time.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { pip, service } from '../pip-contract.js';

describe('DOT manifest', () => {
  it('exposes all five arrays on an empty app', async () => {
    const app = await defineApp('empty-app', { version: '1.0.0' }).boot();
    expect(app.manifest).toEqual({
      app: { name: 'empty-app', version: '1.0.0' },
      pips: [],
      routes: [],
      services: [],
      lifecycle: [],
      dependencies: [],
    });
    await app.dispose();
  });

  it('reflects pip contributions: services + routes registered in configure', async () => {
    const billing = pip({
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
    expect(m.pips).toEqual([{ name: 'billing', version: '2.3.4', dependencies: [], provides: ['payments'] }]);
    expect(m.routes).toEqual([
      {
        id: 'billing.charge',
        pip: 'billing',
        method: 'POST',
        path: '/charge',
        transport: 'http',
      },
    ]);
    expect(m.services).toEqual([{ name: 'stripe', pip: 'billing', kind: 'custom' }]);
    await app.dispose();
  });

  it('lifecycle entries include every hook the pip participates in', async () => {
    const noop = () => {
      // intentional no-op — we only care that the pip object exposes the hook.
    };
    const p = pip({
      name: 'p',
      configure: noop,
      boot: () => ({}),
      start: noop,
      stop: noop,
      dispose: noop,
    });
    const app = await defineApp('test').use(p).start();
    expect(app.manifest.lifecycle).toEqual([
      { pip: 'p', hooks: expect.arrayContaining(['configure', 'boot', 'start']) },
    ]);
    // Hooks are detected from the pip shape, so all five are included.
    expect(app.manifest.lifecycle[0]!.hooks).toEqual(
      expect.arrayContaining(['configure', 'boot', 'start', 'stop', 'dispose']),
    );
    await app.dispose();
  });

  it('dependency edges are observed from service wiring at boot', async () => {
    const a = pip({ name: 'a', boot: () => ({ alpha: 1 }) });
    const b = pip({
      name: 'b',
      needs: { alpha: service<number>() },
      boot: () => ({ beta: 2 }),
    });
    const c = pip({
      name: 'c',
      needs: { beta: service<number>() },
      boot: () => ({}),
    });
    const app = await defineApp('test').use(a).use(b).use(c).boot();
    expect(app.manifest.dependencies).toEqual(
      expect.arrayContaining([
        { from: 'b', to: 'a', kind: 'requires' },
        { from: 'c', to: 'b', kind: 'requires' },
      ]),
    );
    expect(app.manifest.dependencies).toHaveLength(2);
    // The declarative per-pip view carries the wire keys.
    expect(app.manifest.pips.find(p => p.name === 'b')?.dependencies).toEqual(['alpha']);
    // Published wire keys surface in `provides`.
    expect(app.manifest.pips.find(p => p.name === 'a')?.provides).toEqual(['alpha']);
    await app.dispose();
  });

  it('snapshot stability — same pips produce equal manifests across runs', async () => {
    const p = pip({
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
