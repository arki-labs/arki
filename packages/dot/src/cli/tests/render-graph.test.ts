/**
 * Tests for `--graph` rendering.
 *
 * Unit layer: `buildMermaidGraph` output shape (declaration-order node
 * numbering, edge mapping, label escaping). Integration layer: a real
 * booted app's manifest renders its OBSERVED edges — the wiring the kernel
 * recorded while satisfying needs, not anything declared up front.
 */

import { orThrow } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import type { DotAppManifest } from '../../manifest.js';
import { defineApp } from '../../define-app.js';
import { feature } from '../../feature.js';
import { entrypoint, infra, service } from '../../unit-contract.js';
import { buildMermaidGraph, renderGraph } from '../render-graph.js';

function manifestOf(overrides: Partial<DotAppManifest>): DotAppManifest {
  return {
    manifestVersion: 2,
    app: { name: 'test' },
    plugins: [],
    services: [],
    actions: [],
    dependencies: [],
    lifecycle: [],
    projections: [],
    ...overrides,
  };
}

describe('buildMermaidGraph', () => {
  it('renders declaration-ordered nodes and kind-labelled edges', () => {
    const manifest = manifestOf({
      plugins: [
        { name: 'db', dependencies: [], provides: ['db'] },
        { name: 'billing', dependencies: ['db'], provides: [] },
      ],
      dependencies: [{ from: 'billing', to: 'db', kind: 'requires' }],
    });

    expect(buildMermaidGraph(manifest)).toBe(
      [
        'flowchart TD',
        '  %% numbers = boot order',
        '  p0["1 · db"]',
        '  p1["2 · billing"]',
        '  p1 -->|requires| p0',
        '',
      ].join('\n'),
    );
  });

  it('escapes double quotes in unit names and skips edges to unknown units', () => {
    const manifest = manifestOf({
      plugins: [{ name: 'we"ird', dependencies: [], provides: [] }],
      dependencies: [{ from: 'we"ird', to: 'ghost', kind: 'requires' }],
    });

    const source = buildMermaidGraph(manifest);
    expect(source).toContain('p0["1 · we#quot;ird"]');
    expect(source).not.toContain('ghost');
  });
});

describe('renderGraph', () => {
  it('returns the Mermaid source as `{ format, source }`: text mode prints `source` as is', () => {
    const manifest = manifestOf({
      plugins: [{ name: 'solo', dependencies: [], provides: [] }],
    });

    expect(renderGraph(manifest)).toEqual({
      format: 'mermaid',
      source: 'flowchart TD\n  %% numbers = boot order\n  p0["1 · solo"]\n',
    });
  });

  it('a booted app renders its OBSERVED wiring edges', async () => {
    const provider = infra({ name: 'db', provides: { db: () => ({ ok: true }) } });
    const consumer = infra({
      name: 'billing',
      needs: { db: service<{ ok: boolean }>() },
      provides: { billing: ({ db }) => db.ok },
    });

    const app = orThrow(await defineApp('graph-int').infra(provider).infra(consumer).boot());
    const source = buildMermaidGraph(app.manifest);
    expect(source).toContain('p0["1 · db"]');
    expect(source).toContain('p1["2 · billing"]');
    expect(source).toContain('p1 -->|db| p0');
    orThrow(await app.dispose());
  });

  it('draws a .features()/.entrypoints() app as the hexagon: infra → features → entrypoints, numbered in boot order', async () => {
    const db = infra({ name: 'db', provides: { db: () => ({ ok: true }) } });
    const orders = feature('orders', { needs: { db: service<{ ok: boolean }>() } });
    const health = entrypoint({
      name: 'health',
      needs: { db: service<{ ok: boolean }>() },
      provides: { health: ({ db: handle }) => handle.ok },
    });

    const app = orThrow(await defineApp('hexagon').infra(db).features([orders]).entrypoints(health).boot());
    const source = buildMermaidGraph(app.manifest);
    const groups = source.split('\n').filter(line => line.trim().startsWith('subgraph'));
    // The groups appear in boot order, so the drawing reads like the builder chain.
    expect(groups).toEqual([
      '  subgraph infra["infra · what features need"]',
      '  subgraph features["features · the domain"]',
      '  subgraph entrypoints["entrypoints · what calls the features"]',
    ]);
    expect(source).toContain('    p1["2 · orders"]');
    expect(source).toContain('p1 -->|db| p0');
    orThrow(await app.dispose());
  });
});
