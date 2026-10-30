/**
 * `@arki/journal/projection`: reading the event-map graph back from a manifest, merging a scan into it, and
 * printing it.
 *
 * Why these tests exist: the graph travels in the manifest as plain JSON, so a manifest from another
 * version or a second journal must merge or be skipped, never crash `dot explain`. And the text view
 * is what a reader trusts to say what runs in the write and what runs later.
 */
import { describe, expect, it } from 'vitest';

import type { EventMapGraph } from './projection.js';
import { projectGraph, render, withEntrypoints } from './projection.js';

const graph: EventMapGraph = {
  nodes: [
    { id: 'event:OrderPlaced', kind: 'event', name: 'OrderPlaced' },
    { id: 'tap:live', kind: 'tap', name: 'live', deps: ['hub'] },
    {
      id: 'workflow:refund@2',
      kind: 'workflow',
      name: 'refund',
      version: 2,
      deps: [],
      signals: ['approved'],
      opaqueSteps: [],
    },
    { id: 'feature:orders', kind: 'feature', name: 'orders' },
  ],
  edges: [
    { kind: 'reacts', from: 'tap:live', to: 'event:OrderPlaced', timing: 'after-commit', delivery: 'at-most-once' },
    { kind: 'owned-by', from: 'tap:live', to: 'feature:orders' },
    { kind: 'owned-by', from: 'workflow:refund@2', to: 'feature:orders' },
  ],
};
const registered = (meta: unknown) => ({ format: 'event-map', module: '@arki/journal/event-map', meta });
const withRoot = { ...graph, entrypointRoot: 'src/features' };

describe('projectGraph(manifest)', () => {
  it('merges the graphs of two journals, each node and edge once, and skips a meta that is not a graph', () => {
    const { document, entrypointRoot } = projectGraph({
      projections: [registered(withRoot), registered(withRoot), registered({ edges: 'old' }), registered(graph)],
    });
    expect(document).toEqual({ format: 'event-map', ...graph, problems: [] });
    expect(entrypointRoot).toBe('src/features');
  });
});

describe('withEntrypoints(document, scan, problems)', () => {
  // Why: a command imported by two procedure files is one node with two callers, not two commands.
  it('adds one command node for a command two files import, with its writes edge once', () => {
    const base = projectGraph({ projections: [registered(withRoot)] }).document;
    const command = { name: 'place-order', writes: ['OrderPlaced'] };
    const document = withEntrypoints(
      base,
      [
        { feature: 'orders', file: 'orders/entrypoints/a.ts', commands: [command] },
        { feature: 'orders', file: 'orders/entrypoints/b.ts', commands: [command] },
      ],
      [{ file: 'orders/entrypoints/c.ts', reason: 'broken' }],
    );
    expect(document.nodes.filter(node => node.kind === 'command')).toEqual([
      { id: 'command:place-order', kind: 'command', name: 'place-order' },
    ]);
    expect(document.edges.filter(edge => edge.kind === 'writes')).toHaveLength(1);
    expect(document.edges.filter(edge => edge.kind === 'calls').map(edge => edge.from)).toEqual([
      'entrypoint:orders/entrypoints/a.ts',
      'entrypoint:orders/entrypoints/b.ts',
    ]);
    expect(document.problems).toEqual([{ file: 'orders/entrypoints/c.ts', reason: 'broken' }]);
  });
});

describe('render(document)', () => {
  it('prints a tap as lossy, and a workflow no event starts at the end', () => {
    expect(render(projectGraph({ projections: [registered(withRoot)] }).document).split('\n')).toEqual([
      'OrderPlaced',
      '  tap live  [after commit, at most once]  owner orders; deps hub; no retry',
      '',
      'Started by no event',
      '  workflow refund@2  owner orders; deps none; retry per step',
    ]);
  });

  it('says so when the document is not a graph', () => {
    expect(render({ edges: 'old' })).toBe('event-map: the document is not an event-map graph.');
  });
});
