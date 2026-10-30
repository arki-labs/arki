/**
 * `.parallel` at definition time: what the builder refuses, the shape it stores, and the shape hashes that must not move.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { JournalError } from '../errors.js';
import { order, orderId, OrderPlaced } from '../test-support.js';
import { workflow } from './define.js';

const input = z.object({});
const payload = z.object({ v: z.int() });
const base = (name = 'p') => workflow(name, { version: 1, input });

describe('shape hashes of the node kinds that existed before parallel', () => {
  const kid = base('kid').step('a', () => 1).finish();
  const cases = {
    step: base().step('a', () => 1, { undo: () => undefined }).finish(),
    waitFor: base().waitFor('a', { signal: 's', schema: payload }).finish(),
    eventWait: base()
      .waitFor('a', { on: { o: { entity: order, match: () => orderId(1), events: [OrderPlaced] } }, timeout: '1h' })
      .finish(),
    sleep: base().sleep('a', '1h').finish(),
    child: base().child('a', kid, { input: () => ({}) }).finish(),
    map: base().map('a', kid, { items: () => [1], input: () => ({}) }).finish(),
  };
  it('are the values they had before parallel existed', () => {
    const hashes = Object.fromEntries(Object.entries(cases).map(([kind, def]) => [kind, def.shapeHash]));
    // Pinned: a running workflow stores its shape hash, so a change here would strand it.
    expect(hashes).toEqual({
      step: '0ac660f55802b456',
      waitFor: '21f292cafa531d07',
      eventWait: '7b024bf173866674',
      sleep: '03f75076cecca7c7',
      child: '981ac500d8d88eda',
      map: '3293337bf66b8ff6',
    });
  });
  it('a parallel node hashes its branches, so changing one changes the hash', () => {
    const one = base()
      .parallel('p', { x: b => b.step('a', () => 1).finish() }, { wait: 'all' })
      .finish();
    const changed = base()
      .parallel('p', { x: b => b.step('b', () => 1).finish() }, { wait: 'all' })
      .finish();
    const wait = base()
      .parallel('p', { x: b => b.step('a', () => 1).finish() }, { wait: 'any' })
      .finish();
    expect(new Set([one.shapeHash, changed.shapeHash, wait.shapeHash]).size).toBe(3);
    expect(one.shape.nodes[0]).toMatchObject({
      name: 'p',
      kind: 'parallel',
      wait: 'all',
      branches: [{ name: 'x', shape: { nodes: [{ name: 'a', kind: 'step' }] } }],
    });
  });
});

describe('the builder refuses a wrong parallel', () => {
  const refused = (build: () => unknown, text: string) => {
    let error: unknown;
    try {
      build();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JournalError);
    expect(error).toMatchObject({ code: 'BAD_DEFINITION' });
    expect(String(error)).toContain(text);
  };

  it('a branch name that is not a plain key', () => {
    refused(() => base().parallel('p', { 'a b': b => b.step('a', () => 1).finish() }, { wait: 'all' }), "branch 'a b'");
  });
  it('a branch node named like an earlier node of the workflow', () => {
    refused(
      () =>
        base()
          .step('a', () => 1)
          // @ts-expect-error the types refuse it too; the runtime check is for erased builders
          .parallel('p', { x: b => b.step('a', () => 1).finish() }, { wait: 'all' }),
      "branch 'x' has a node 'a'",
    );
  });
  it('two branches waiting for one signal with different schema objects', () => {
    refused(
      () =>
        base().parallel(
          'p',
          {
            x: b => b.waitFor('w', { signal: 's', schema: z.object({ v: z.int() }) }).finish(),
            y: b => b.waitFor('w', { signal: 's', schema: z.object({ v: z.int() }) }).finish(),
          },
          { wait: 'all' },
        ),
      "signal 's'",
    );
  });
  it('a later wait for a signal a branch already waits for, with another schema', () => {
    refused(
      () =>
        base()
          .parallel('p', { x: b => b.waitFor('w', { signal: 's', schema: payload }).finish() }, { wait: 'all' })
          .waitFor('late', { signal: 's', schema: z.object({ v: z.int() }) }),
      "signal 's'",
    );
  });
  it('two branches that wait for one signal with the same schema object are fine', () => {
    const def = base()
      .parallel(
        'p',
        {
          x: b => b.waitFor('w', { signal: 's', schema: payload }).finish(),
          y: b => b.waitFor('w', { signal: 's', schema: payload }).finish(),
        },
        { wait: 'all' },
      )
      .finish();
    expect(def.nodes).toHaveLength(1);
  });
  it('a branch that returns a definition its builder did not finish', () => {
    const other = base('other').step('a', () => 1).finish();
    refused(() => base().parallel('p', { x: () => other }, { wait: 'all' }), 'must return the definition its builder finished');
  });
  it('no branch', () => {
    refused(() => base().parallel('p', {}, { wait: 'all' }), 'at least one branch');
  });
  it('a duplicate node name', () => {
    refused(
      () =>
        base()
          .parallel('p', { x: b => b.step('a', () => 1).finish() }, { wait: 'all' })
          // @ts-expect-error the types refuse it too
          .step('p', () => 1),
      "node 'p' is declared twice",
    );
  });
});

describe('a branch definition', () => {
  it('is named after the parent and the node, has the parent version and limits, and reads the parent nodes', () => {
    const def = workflow('par', { version: 3, input, limits: { transitions: 7 } })
      .step('first', () => 1)
      .parallel('p', { x: b => b.step('a', () => 1).finish() }, { wait: 'all' })
      .finish();
    const [node] = def.nodes.slice(1);
    if (node?.kind !== 'parallel') throw new Error('expected a parallel node');
    const [branch] = node.branches;
    expect(branch?.def).toMatchObject({ name: 'par/p/x', version: 3, limits: { transitions: 7 } });
    expect(branch?.def.inherited.map(inherited => inherited.name)).toEqual(['first']);
  });
});
