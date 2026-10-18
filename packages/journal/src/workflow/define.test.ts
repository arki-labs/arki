import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isJournalError } from '../errors.js';
import { workflow } from './define.js';

const undo = () => 0;
const hash = (def: { shapeHash: string }) => def.shapeHash;
const input = z.object({ paymentId: z.string() });
const base = (name = 'payments.refund') => workflow(name, { version: 1, input });

function refusal(build: () => unknown) {
  try {
    build();
  } catch (error) {
    if (isJournalError(error, 'BAD_DEFINITION')) return error.message;
    throw error;
  }
  throw new Error('expected BAD_DEFINITION, nothing was thrown');
}

const refund = () =>
  base()
    .step('hold', () => ({ holdId: 'h' }), { undo: () => 0 })
    .step('payBack', () => ({ id: 'p' }))
    .waitFor('settled', { signal: 'provider.refund.settled', schema: z.object({ id: z.string() }), timeout: '3d' })
    .sleep('coolOff', '24h')
    .finish();

describe('the shape manifest', () => {
  it('lists every node with its kind, in declaration order, with undo flags', () => {
    const def = refund();
    expect(def.shape).toEqual({
      nodes: [
        { name: 'hold', kind: 'step', undo: true },
        { name: 'payBack', kind: 'step', undo: false },
        { name: 'settled', kind: 'waitFor', undo: false },
        { name: 'coolOff', kind: 'sleep', undo: false },
      ],
    });
    expect(def.nodes.map(node => node.name)).toEqual(def.shape.nodes.map(node => node.name));
  });

  it('covers child and map nodes', () => {
    const item = base('item')
      .step('work', () => 1)
      .finish();
    const def = base('parent')
      .child('one', item, { input: () => ({ paymentId: 'a' }) })
      .map('many', item, { items: () => ['a', 'b'], input: (_ctx, id) => ({ paymentId: id }) })
      .finish();
    expect(def.shape.nodes.map(node => [node.name, node.kind])).toEqual([
      ['one', 'child'],
      ['many', 'map'],
    ]);
  });

  it('the definition is frozen all the way down, so a run cannot drift from its shape', () => {
    const def = refund();
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.shape)).toBe(true);
    expect(Object.isFrozen(def.shape.nodes)).toBe(true);
    expect(Object.isFrozen(def.shape.nodes[0])).toBe(true);
    expect(Object.isFrozen(def.nodes)).toBe(true);
    expect(Object.isFrozen(def.nodes[0])).toBe(true);
  });

  it('carries the workflow options with their defaults', () => {
    const def = refund();
    expect(def).toMatchObject({
      name: 'payments.refund',
      version: 1,
      onDeadStep: 'wait',
      limits: { payload: 65_536, transitions: 1000, children: 1000 },
      concurrency: undefined,
      output: undefined,
    });
    const tuned = workflow('t', {
      version: 2,
      input,
      deadline: '14d',
      onDeadStep: 'compensate',
      limits: { transitions: 5 },
      concurrency: { key: i => i.paymentId, limit: 1, onBusy: 'refuse' },
    })
      .step('a', () => 1)
      .finish();
    expect(tuned).toMatchObject({ version: 2, deadline: '14d', onDeadStep: 'compensate' });
    expect(tuned.limits).toEqual({ payload: 65_536, transitions: 5, children: 1000 });
    expect(tuned.concurrency?.limit).toBe(1);
  });

  it('building twice does not share nodes: an earlier builder is not changed by a later step', () => {
    const first = base().step('a', () => 1);
    const longer = first.step('b', () => 2).finish();
    const shorter = first.finish();
    expect(longer.shape.nodes).toHaveLength(2);
    expect(shorter.shape.nodes).toHaveLength(1);
  });
});

describe('the shape hash', () => {
  it('is the same for identical definitions, even with different bodies', () => {
    const one = base()
      .step('a', () => 1)
      .step('b', () => 2)
      .finish();
    const two = base()
      .step('a', () => 'different body')
      .step('b', () => 3)
      .finish();
    expect(one.shapeHash).toBe(two.shapeHash);
    expect(one.shapeHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a node is added, renamed, reordered, changes kind or gains an undo', () => {
    const original = hash(
      base()
        .step('a', () => 1)
        .step('b', () => 2)
        .finish(),
    );
    const added = hash(
      base()
        .step('a', () => 1)
        .step('b', () => 2)
        .step('c', () => 3)
        .finish(),
    );
    const renamed = hash(
      base()
        .step('a', () => 1)
        .step('renamed', () => 2)
        .finish(),
    );
    const reordered = hash(
      base()
        .step('b', () => 2)
        .step('a', () => 1)
        .finish(),
    );
    const undone = hash(
      base()
        .step('a', () => 1, { undo: () => 0 })
        .step('b', () => 2)
        .finish(),
    );
    const otherKind = hash(
      base()
        .step('a', () => 1)
        .sleep('b', '1h')
        .finish(),
    );
    const all = [original, added, renamed, reordered, undone, otherKind];
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not depend on node names that only differ by where the boundary falls', () => {
    const one = base()
      .step('ab', () => 1)
      .step('c', () => 2)
      .finish();
    const two = base()
      .step('a', () => 1)
      .step('bc', () => 2)
      .finish();
    expect(one.shapeHash).not.toBe(two.shapeHash);
  });
});

describe('definition rules, each throws BAD_DEFINITION naming the workflow', () => {
  it('refuses a duplicate node name, across kinds', () => {
    const message = refusal(() =>
      base()
        .step('a', () => 1)
        // @ts-expect-error the types refuse a repeated name too; this checks the runtime rule for plain JS
        .sleep('a', '1h'),
    );
    expect(message).toContain('payments.refund');
    expect(message).toContain("'a'");
  });

  it('refuses an empty workflow', () => {
    expect(refusal(() => base('empty.flow').finish())).toContain('empty.flow');
  });

  it('refuses a static next that names a later, unknown or own node', () => {
    // The types refuse these too; the directives let plain-JS callers reach the runtime rule.
    // @ts-expect-error `b` is not an earlier node
    expect(refusal(() => base('loose').step('a', () => 1, { next: 'b' }))).toContain('loose');
    // @ts-expect-error a step cannot jump to itself
    expect(refusal(() => base().step('a', () => 1, { next: 'a' }))).toContain('not an earlier node');
    expect(
      refusal(() =>
        base()
          .step('a', () => 1)
          // @ts-expect-error `c` comes later
          .step('b', () => 2, { next: 'c' })
          .step('c', () => 3),
      ),
    ).toContain("next: 'c'");
  });

  it('accepts next to an earlier node, and next: "next"', () => {
    const def = base()
      .step('gate', () => 1)
      .step('generate', () => 2, { next: 'gate' })
      .step('done', () => 3, { next: () => 'next' })
      .finish();
    expect(def.shape.nodes).toHaveLength(3);
  });

  it('refuses undo on kinds that cannot have one', () => {
    const child = base('child')
      .step('a', () => 1)
      .finish();
    // @ts-expect-error sleep takes no options
    expect(refusal(() => base().sleep('s', '1h', { undo }))).toContain('cannot have an undo');
    // @ts-expect-error waitFor has no undo option
    expect(refusal(() => base('loose').waitFor('w', { signal: 's', schema: z.string(), undo }))).toContain('loose');
    expect(
      // @ts-expect-error map has no undo option
      refusal(() => base().map('m', child, { items: () => [], input: () => ({ paymentId: 'x' }), undo })),
    ).toContain('cannot have an undo');
  });

  it("refuses a node called 'next' and an empty node name", () => {
    expect(refusal(() => base().step('next', () => 1))).toContain("'next'");
    expect(refusal(() => base().step('', () => 1))).toContain('empty');
  });

  it('refuses a bad version, limits, concurrency limit, map concurrency and an unnamed signal', () => {
    expect(refusal(() => workflow('v', { version: 0, input }))).toContain('version');
    expect(refusal(() => workflow('v', { version: 1.5, input }))).toContain('version');
    expect(refusal(() => workflow('v', { version: 1, input, limits: { payload: 0 } }))).toContain('limits.payload');
    expect(
      refusal(() => workflow('v', { version: 1, input, concurrency: { key: () => 'k', limit: 0, onBusy: 'refuse' } })),
    ).toContain('concurrency.limit');
    expect(refusal(() => base().waitFor('w', { signal: '', schema: z.string() }))).toContain('signal');
    const item = base('item')
      .step('a', () => 1)
      .finish();
    expect(
      refusal(() => base().map('m', item, { items: () => [], input: () => ({ paymentId: 'x' }), concurrency: 0 })),
    ).toContain('concurrency');
    expect(refusal(() => workflow('', { version: 1, input }))).toContain('needs a name');
  });
});

describe('one signal name, one payload schema', () => {
  it('two waits for one signal with different schemas are refused, so the payload type of a signal is never ambiguous', () => {
    const message = refusal(() =>
      base('shared')
        .waitFor('first', { signal: 'provider.settled', schema: z.object({ id: z.string() }) })
        .waitFor('second', { signal: 'provider.settled', schema: z.object({ id: z.string() }) }),
    );
    expect(message).toContain('shared');
    expect(message).toContain('provider.settled');
  });

  it('two waits for one signal may share the same schema object, as a loop does', () => {
    const settled = z.object({ id: z.string() });
    const def = base('loop')
      .waitFor('first', { signal: 'provider.settled', schema: settled })
      .waitFor('second', { signal: 'provider.settled', schema: settled })
      .finish();
    expect(def.nodes.map(node => node.name)).toEqual(['first', 'second']);
  });
});

describe('node options are kept for the runner', () => {
  it('stores waitFor and child defaults', () => {
    const child = base('c')
      .step('a', () => 1)
      .finish();
    const def = base()
      .waitFor('w', { signal: 'sig', schema: z.string() })
      .child('k', child, { input: () => ({ paymentId: 'x' }) })
      .finish();
    expect(def.nodes[0]).toMatchObject({ kind: 'waitFor', signal: 'sig', onTimeout: 'fail' });
    expect(def.nodes[1]).toMatchObject({ kind: 'child', onCancel: 'cancel' });
  });

  it('keeps the step body and the finish body', () => {
    const def = base()
      .step('a', ({ input: given }) => given.paymentId.toUpperCase())
      .finish(({ results }) => ({ out: results.a }));
    const [node] = def.nodes;
    expect(node?.kind).toBe('step');
    expect(def.finish?.({ runId: 'wfr_1', input: { paymentId: 'p1' }, results: { a: 'P1' } })).toEqual({ out: 'P1' });
  });
});
