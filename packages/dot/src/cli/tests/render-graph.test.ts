/**
 * Tests for `--graph` rendering.
 *
 * Unit layer: `buildMermaidGraph` output shape (declaration-order node
 * numbering, edge mapping, label escaping). Integration layer: a real
 * booted app's manifest renders its OBSERVED edges — the wiring the kernel
 * recorded while satisfying needs, not anything declared up front.
 */

import { describe, expect, it } from 'vitest';

import type { DotAppManifest } from '../../manifest.js';
import { defineApp } from '../../define-app.js';
import { pip, service } from '../../pip-contract.js';
import { buildMermaidGraph, renderGraph } from '../render-graph.js';

function manifestOf(overrides: Partial<DotAppManifest>): DotAppManifest {
  return {
    app: { name: 'test' },
    pips: [],
    services: [],
    routes: [],
    dependencies: [],
    lifecycle: [],
    ...overrides,
  } as DotAppManifest;
}

describe('buildMermaidGraph', () => {
  it('renders declaration-ordered nodes and kind-labelled edges', () => {
    const manifest = manifestOf({
      pips: [
        { name: 'db', version: '1.2.0', dependencies: [], provides: ['db'] },
        { name: 'billing', dependencies: ['db'], provides: [] },
      ],
      dependencies: [{ from: 'billing', to: 'db', kind: 'requires' }],
    });

    expect(buildMermaidGraph(manifest)).toBe(
      ['flowchart TD', '  p0["1 · db@1.2.0"]', '  p1["2 · billing"]', '  p1 -->|requires| p0', ''].join('\n'),
    );
  });

  it('escapes double quotes in pip names and skips edges to unknown pips', () => {
    const manifest = manifestOf({
      pips: [{ name: 'we"ird', dependencies: [], provides: [] }],
      dependencies: [{ from: 'we"ird', to: 'ghost', kind: 'requires' }],
    });

    const source = buildMermaidGraph(manifest);
    expect(source).toContain('p0["1 · we#quot;ird"]');
    expect(source).not.toContain('ghost');
  });
});

describe('renderGraph', () => {
  it('plain mode prints raw mermaid; --json wraps it in the standard envelope', () => {
    const manifest = manifestOf({
      pips: [{ name: 'solo', dependencies: [], provides: [] }],
    });

    const plainLines: string[] = [];
    renderGraph(
      { manifest, command: 'explain' },
      { json: false, out: line => plainLines.push(line), now: () => new Date(0) },
    );
    expect(plainLines.join('')).toBe('flowchart TD\n  p0["1 · solo"]\n');

    const jsonLines: string[] = [];
    const envelope = renderGraph(
      { manifest, command: 'doctor' },
      { json: true, out: line => jsonLines.push(line), now: () => new Date(0) },
    );
    expect(envelope).toMatchObject({
      status: 'success',
      command: 'doctor',
      generatedAt: '1970-01-01T00:00:00.000Z',
      data: { format: 'mermaid' },
    });
    expect(JSON.parse(jsonLines.join('')) as unknown).toMatchObject({ data: { format: 'mermaid' } });
  });

  it('a booted app renders its OBSERVED wiring edges', async () => {
    const provider = pip({ name: 'db', boot: () => ({ db: { ok: true } }) });
    const consumer = pip({
      name: 'billing',
      needs: { db: service<{ ok: boolean }>() },
      boot: ({ db }) => ({ billing: db.ok }),
    });

    const app = await defineApp('graph-int').use(provider).use(consumer).boot();
    const source = buildMermaidGraph(app.manifest);
    expect(source).toContain('p0["1 · db"]');
    expect(source).toContain('p1["2 · billing"]');
    expect(source).toContain('p1 -->|requires| p0');
    await app.dispose();
  });
});
