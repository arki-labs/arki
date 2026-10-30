/**
 * Manifest contract tests for the DOT kernel (v2).
 *
 * The manifest exposes six top-level arrays — units, actions, services,
 * lifecycle, dependencies, projections — even on an empty app. Dependency
 * edges are observed from actual service wiring at boot time.
 */

import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import type { JsonObject } from '../manifest.js';
import { toJsonObject } from '../manifest.js';
import { infra, service } from '../unit-contract.js';

describe('DOT manifest', () => {
  it('exposes all six arrays on an empty app', async () => {
    const app = orThrow(await defineApp('empty-app', { version: '1.0.0' }).boot());
    expect(app.manifest).toEqual({
      manifestVersion: 2,
      app: { name: 'empty-app', version: '1.0.0' },
      plugins: [],
      actions: [],
      services: [],
      lifecycle: [],
      dependencies: [],
      projections: [],
    });
    orThrow(await app.dispose());
  });

  it('reflects unit contributions: services, actions, and projections registered in configure', async () => {
    const billing = infra({
      name: 'billing',
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

    const app = orThrow(await defineApp('test').infra(billing).boot());
    const m = app.manifest;
    expect(m.plugins).toEqual([{ name: 'billing', role: 'infra', dependencies: [], provides: ['payments'] }]);
    expect(m.actions).toEqual([
      {
        id: 'billing.charge',
        plugin: 'billing',
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
      { format: 'openapi', binding: 'http', module: '@arki/http/projection', plugin: 'billing' },
    ]);
    expect(m.services).toEqual([{ name: 'stripe', plugin: 'billing', kind: 'custom' }]);
    orThrow(await app.dispose());
  });

  // Why: a projection module reads its `meta` from the manifest file, so the meta must stay plain JSON.
  it("keeps a projection's JSON meta, and refuses meta that does not survive a JSON round trip", () => {
    const flow = (meta: Readonly<JsonObject>) =>
      infra({
        name: 'flow',
        configure(ctx) {
          ctx.registerProjection({ format: 'flow', binding: 'journal', module: './flow.js', meta });
        },
      });
    const configured = orThrow(defineApp('meta').infra(flow({ events: ['A'] })).configure());
    expect(configured.manifest.projections).toEqual([
      { format: 'flow', binding: 'journal', module: './flow.js', plugin: 'flow', meta: { events: ['A'] } },
    ]);
    // NaN types as a number, but JSON turns it into null.
    const lossy = defineApp('lossy').infra(flow({ count: Number.NaN })).configure();
    expect(lossy).toMatchObject({
      code: 'failure.unexpected_defect',
      cause: { message: expect.stringContaining('JSON-serializable object without lossy coercions') },
    });
  });

  it('collects declarative actions from hook-less units without adding configure lifecycle entries', () => {
    const health = infra({
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

    const configured = orThrow(defineApp('test').infra(health).configure());
    expect(configured.manifest.actions).toEqual([
      {
        id: 'health.check',
        plugin: 'health',
        binding: 'http',
        direction: 'in',
        address: 'GET /health',
      },
    ]);
    expect(configured.manifest.lifecycle).toEqual([{ plugin: 'health', hooks: [] }]);
  });

  it('keeps registerRoute as a lossless deprecated shim over registerAction', () => {
    const legacy = infra({
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

    const configured = orThrow(defineApp('test').infra(legacy).configure());
    expect(configured.manifest.actions).toEqual([
      {
        id: 'legacy.health',
        plugin: 'legacy',
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

  it('surfaces duplicate action ids within a binding as ARKI_DOT_E016 issues', () => {
    const duplicate = infra({
      name: 'dup',
      actions: [
        { id: 'same', binding: 'http', direction: 'in' },
        { id: 'same', binding: 'http', direction: 'out' },
        { id: 'same', binding: 'queue', direction: 'in' },
      ],
    });

    const configured = orThrow(defineApp('test').infra(duplicate).configure());
    expect(configured.manifest.actions.map(action => `${action.binding}:${action.id}`)).toEqual([
      'http:same',
      'http:same',
      'queue:same',
    ]);
    const issue = configured.diagnostics.issues.find(i => i.code === DotLifecycleErrorCode.DuplicateAction);
    expect(issue).toMatchObject({
      severity: 'error',
      plugin: 'dup',
      metadata: { binding: 'http', id: 'same' },
    });
  });

  it('rejects non-JSON action metadata with ARKI_DOT_E017 diagnostics', () => {
    const bad = infra({
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

    const configured = orThrow(defineApp('test').infra(bad).configure());
    expect(configured.diagnostics.issues).toContainEqual(
      expect.objectContaining({
        code: DotLifecycleErrorCode.ActionMetaNotJson,
        severity: 'error',
        plugin: 'bad-meta',
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

  it('lifecycle entries include every hook the unit participates in', async () => {
    const noop = () => {
      // Explicit absence keeps detached hooks from erasing returned failures.
      // eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined prevents void from erasing returned failures.
      return undefined;
    };
    const p = infra({
      name: 'p',
      configure: noop,
      boot: () => {
        /* side effects only */
      },
      start: noop,
      stop: noop,
      dispose: noop,
    });
    const app = orThrow(await defineApp('test').infra(p).start());
    expect(app.manifest.lifecycle).toEqual([
      { plugin: 'p', hooks: expect.arrayContaining(['configure', 'boot', 'start']) },
    ]);
    // Hooks are detected from the unit shape, so all five are included.
    expect(app.manifest.lifecycle[0]!.hooks).toEqual(
      expect.arrayContaining(['configure', 'boot', 'start', 'stop', 'dispose']),
    );
    orThrow(await app.dispose());
  });

  it('dependency edges are observed from service wiring at boot', async () => {
    const a = infra({ name: 'a', provides: { alpha: () => 1 } });
    const b = infra({
      name: 'b',
      needs: { alpha: service<number>() },
      provides: { beta: () => 2 },
    });
    const c = infra({
      name: 'c',
      needs: { beta: service<number>() },
      boot: () => {
        /* side effects only */
      },
    });
    const app = orThrow(await defineApp('test').infra(a).infra(b).infra(c).boot());
    expect(app.manifest.dependencies).toEqual(
      expect.arrayContaining([
        { from: 'b', to: 'a', kind: 'requires', key: 'alpha' },
        { from: 'c', to: 'b', kind: 'requires', key: 'beta' },
      ]),
    );
    expect(app.manifest.dependencies).toHaveLength(2);
    // The declarative per-unit view carries the wire keys.
    expect(app.manifest.plugins.find(p => p.name === 'b')?.dependencies).toEqual(['alpha']);
    // Published wire keys surface in `provides`.
    expect(app.manifest.plugins.find(p => p.name === 'a')?.provides).toEqual(['alpha']);
    orThrow(await app.dispose());
  });

  it('snapshot stability — same units produce equal manifests across runs', async () => {
    const p = infra({
      name: 'p',
      configure: ctx => {
        ctx.registerService('logger', 'logger');
        ctx.registerAction({ id: 'p.ping', binding: 'orpc', direction: 'in' });
      },
    });

    const app1 = orThrow(await defineApp('test').infra(p).boot());
    const app2 = orThrow(await defineApp('test').infra(p).boot());
    expect(app1.manifest).toEqual(app2.manifest);
    orThrow(await app1.dispose());
    orThrow(await app2.dispose());
  });
});
