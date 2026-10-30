/**
 * `@arki/journal/projection`: reading the journal-flow graph back from a manifest, and printing it.
 *
 * Why these tests exist: the graph travels in the manifest as plain JSON, so a manifest from another
 * version or a second journal must merge or be skipped, never crash `dot explain`. And the text view
 * is what a reader trusts to say what runs in the write and what runs later.
 */
import { describe, expect, it } from 'vitest';

import type { JournalFlowGraph } from './projection.js';
import { project, render } from './projection.js';

const graph: JournalFlowGraph = {
  nodes: [
    { id: 'event:OrderPlaced', kind: 'event', name: 'OrderPlaced' },
    { id: 'tap:live', kind: 'tap', name: 'live', deps: ['hub'] },
    { id: 'workflow:refund@2', kind: 'workflow', name: 'refund', version: 2, deps: [], signals: ['approved'] },
    { id: 'feature:orders', kind: 'feature', name: 'orders' },
  ],
  edges: [
    { kind: 'reacts', from: 'tap:live', to: 'event:OrderPlaced', timing: 'after-commit', delivery: 'at-most-once' },
    { kind: 'owned-by', from: 'tap:live', to: 'feature:orders' },
    { kind: 'owned-by', from: 'workflow:refund@2', to: 'feature:orders' },
  ],
};
const registered = (meta: unknown) => ({ format: 'journal-flow', module: '@arki/journal/projection', meta });

describe('project(manifest)', () => {
  it('merges the graphs of two journals, each node and edge once, and skips a meta that is not a graph', () => {
    const document = project({ projections: [registered(graph), registered(graph), registered({ edges: 'old' })] });
    expect(document).toEqual({ format: 'journal-flow', ...graph });
  });
});

describe('render(document)', () => {
  it('prints a tap as lossy, and a workflow no event starts at the end', () => {
    expect(render(project({ projections: [registered(graph)] })).split('\n')).toEqual([
      'OrderPlaced',
      '  tap live  [after commit, at most once]  owner orders; deps hub; no retry',
      '',
      'Started by no event',
      '  workflow refund@2  owner orders; deps none; retry per step',
    ]);
  });

  it('says so when the document is not a graph', () => {
    expect(render({ edges: 'old' })).toBe('journal-flow: the document is not a journal-flow graph.');
  });
});
