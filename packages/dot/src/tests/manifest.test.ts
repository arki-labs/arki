/**
 * Manifest contract tests for the DOT kernel (v2).
 *
 * The manifest exposes six top-level arrays — pips, actions, services,
 * lifecycle, dependencies, projections — even on an empty app. Dependency
 * edges are observed from actual service wiring at boot time.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { toJsonObject } from '../manifest.js';
import { pip, service } from '../pip-contract.js';

describe('DOT manifest', () => {
  it('exposes all six arrays on an empty app', async () => {
    const app = await defineApp('empty-app', { version: '1.0.0' }).boot();
    expect(app.manifest).toEqual({
      manifestVersion: 2,
      app: { name: 'empty-app', version: '1.0.0' },
      pips: [],
      actions: [],
      services: [],
      lifecycle: [],
      dependencies: [],
      projections: [],
    });
    await app.dispose();
  });

  it('reflects pip contributions: services, actions, and projections registered in configure', async () => {
    const billing = pip({
      name: 'billing',
      version: '2.3.4',
      configure: ctx => {
        ctx.registerService('stripe', 'custom');
        ctx.registerAction({
          id: 'billing.charge',
          binding: 'http',
          direction: 'in',
          address: 'POST /charge',
          summary: 'Charge a customer',
          metaSchema: '@arki/http/action-meta@1',
          meta: {
            method: 'POST',
            path: '/charge',
          },
        });
        ctx.registerProjection({
          format: 'openapi',
          binding: 'http',
          module: '@arki/http/projection',
        });
        ctx.declareProvides('payments');
      },
    });

    const app = await defineApp('test').use(billing).boot();
    const m = app.manifest;
    expect(m.pips).toEqual([{ name: 'billing', version: '2.3.4', dependencies: [], provides: ['payments'] }]);
    expect(m.actions).toEqual([
      {
        id: 'billing.charge',
        pip: 'billing',
        binding: 'http',
        direction: 'in',
        address: 'POST /charge',
        summary: 'Charge a customer',
        metaSchema: '@arki/http/action-meta@1',
        meta: {
          method: 'POST',
          path: '/charge',
        },
      },
    ]);
    expect(m.projections).toEqual([
      { format: 'openapi', binding: 'http', module: '@arki/http/projection', pip: 'billing' },
    ]);
    expect(m.services).toEqual([{ name: 'stripe', pip: 'billing', kind: 'custom' }]);
    await app.dispose();
  });

  it('collects declarative actions from hook-less pips without adding configure lifecycle entries', () => {
    const health = pip({
      name: 'health',
      actions: [
        {
          id: 'health.check',
          binding: 'http',
          direction: 'in',
          address: 'GET /health',
        },
      ],
    });

    const configured = defineApp('test').use(health).configure();
    expect(configured.manifest.actions).toEqual([
      {
        id: 'health.check',
        pip: 'health',
        binding: 'http',
        direction: 'in',
        address: 'GET /health',
      },
    ]);
    expect(configured.manifest.lifecycle).toEqual([{ pip: 'health', hooks: [] }]);
  });

  it('keeps registerRoute as a lossless deprecated shim over registerAction', () => {
    const legacy = pip({
      name: 'legacy',
      configure: ctx => {
        ctx.registerRoute({
          id: 'legacy.health',
          method: 'GET',
          path: '/health',
          transport: 'http',
          description: 'Health check',
          input: { query: { type: 'object' } },
          output: { type: 'object' },
          streaming: true,
        });
      },
    });

    const configured = defineApp('test').use(legacy).configure();
    expect(configured.manifest.actions).toEqual([
      {
        id: 'legacy.health',
        pip: 'legacy',
        binding: 'http',
        direction: 'in',
        address: 'GET /health',
        summary: 'Health check',
        meta: {
          method: 'GET',
          path: '/health',
          input: { query: { type: 'object' } },
          output: { type: 'object' },
          streaming: true,
        },
      },
    ]);
  });

  it('surfaces duplicate action ids within a binding as DOT_LIFECYCLE_E016 issues', () => {
    const duplicate = pip({
      name: 'dup',
      actions: [
        { id: 'same', binding: 'http', direction: 'in' },
        { id: 'same', binding: 'http', direction: 'out' },
        { id: 'same', binding: 'queue', direction: 'in' },
      ],
    });

    const configured = defineApp('test').use(duplicate).configure();
    expect(configured.manifest.actions.map(action => `${action.binding}:${action.id}`)).toEqual([
      'http:same',
      'http:same',
      'queue:same',
    ]);
    const issue = configured.diagnostics.issues.find(i => i.code === DotLifecycleErrorCode.DuplicateAction);
    expect(issue).toMatchObject({
      severity: 'error',
      pip: 'dup',
      metadata: { binding: 'http', id: 'same' },
    });
  });

  it('rejects non-JSON action metadata with DOT_LIFECYCLE_E017 diagnostics', () => {
    const bad = pip({
      name: 'bad-meta',
      actions: [
        {
          id: 'bad.nan',
          binding: 'http',
          direction: 'in',
          meta: { value: Number.NaN },
        },
      ],
    });

    const configured = defineApp('test').use(bad).configure();
    expect(configured.diagnostics.issues).toContainEqual(
      expect.objectContaining({
        code: DotLifecycleErrorCode.ActionMetaNotJson,
        severity: 'error',
        pip: 'bad-meta',
        metadata: expect.objectContaining({ actionId: 'bad.nan' }),
      }),
    );
  });

  it('narrows unknown values to JsonObject only after the JSON round-trip check passes', () => {
    expect(toJsonObject({ type: 'object', properties: { id: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(() => toJsonObject({ value: Number.POSITIVE_INFINITY })).toThrow(/JSON-serializable/);
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
        ctx.registerAction({ id: 'p.ping', binding: 'orpc', direction: 'in' });
      },
    });

    const app1 = await defineApp('test').use(p).boot();
    const app2 = await defineApp('test').use(p).boot();
    expect(app1.manifest).toEqual(app2.manifest);
    await app1.dispose();
    await app2.dispose();
  });
});
