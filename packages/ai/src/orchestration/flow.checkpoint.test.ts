import { describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import { createFlow } from './flow';

type CountState = { value: number; trail: string[] };
type EmptyContext = Record<string, never>;

/** Default for a not-yet-assigned pause-gate releaser (replaced when the flow parks). */
const NOOP = (): void => {
  // intentionally empty until the flow parks at a boundary
};

/**
 * A three-node linear flow: a -> b -> c, each appending its id to the trail. Used to assert
 * the onCheckpoint hook fires at node boundaries and can hold the flow between nodes.
 */
function buildLinearFlow(onCheckpoint?: (nodeId: string, state: CountState) => Promise<void>, signal?: AbortSignal) {
  return createFlow<CountState, EmptyContext>({
    start: 'a',
    nodes: {
      a: { id: 'a', run: s => Promise.resolve({ trail: [...s.trail, 'a'] }), next: 'b' },
      b: { id: 'b', run: s => Promise.resolve({ trail: [...s.trail, 'b'] }), next: 'c' },
      c: { id: 'c', run: s => Promise.resolve({ trail: [...s.trail, 'c'] }), next: undefined },
    },
    onCheckpoint,
    signal,
  });
}

describe('Flow onCheckpoint', () => {
  it('fires at every node boundary, before the node runs, in dispatch order', async () => {
    const checkpoints: string[] = [];
    const flow = buildLinearFlow((nodeId, state) => {
      // The hook sees the node BEFORE it runs: when checkpointing 'b', only 'a' has run.
      checkpoints.push(`${nodeId}:[${state.trail.join(',')}]`);
      return Promise.resolve();
    });

    const result = orThrow(await flow.run({ value: 0, trail: [] }, {}));

    expect(result.trail).toEqual(['a', 'b', 'c']);
    expect(checkpoints).toEqual(['a:[]', 'b:[a]', 'c:[a,b]']);
  });

  it('holds the flow at the boundary until the gate resolves', async () => {
    const order: string[] = [];
    let parkedAtB = false;
    let releaseB: () => void = NOOP;

    const flow = buildLinearFlow(async nodeId => {
      order.push(`checkpoint:${nodeId}`);
      if (nodeId === 'b') {
        parkedAtB = true;
        // Park the flow on a promise we resolve from the outside — the pause-gate.
        await new Promise<void>(resolve => {
          releaseB = resolve;
        });
        order.push('released:b');
      }
    });

    const runPromise = flow.run({ value: 0, trail: [] }, {});

    // Let the flow advance until it parks at b's checkpoint.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(['checkpoint:a', 'checkpoint:b']);
    expect(parkedAtB).toBe(true);

    // Release the gate; the flow finishes b and c.
    releaseB();
    const result = orThrow(await runPromise);

    expect(order).toEqual(['checkpoint:a', 'checkpoint:b', 'released:b', 'checkpoint:c']);
    expect(result.trail).toEqual(['a', 'b', 'c']);
  });

  it('honors an abort that arrives while the flow is held at a boundary', async () => {
    const controller = new AbortController();
    let releaseB: (() => void) | null = null;

    const flow = buildLinearFlow(async nodeId => {
      if (nodeId === 'b') {
        await new Promise<void>(resolve => {
          releaseB = resolve;
          // The real service wires resume() to the abort signal so a cancel releases the hold.
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }, controller.signal);

    const runPromise = flow.run({ value: 0, trail: [] }, {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // Abort while held at b — the gate releases, then the post-checkpoint abort check returns Cancelled.
    controller.abort();
    const result = await runPromise;
    expect(isFailure(result) && result.code).toBe('ai.cancelled');
    expect(releaseB).not.toBeNull();
  });
});
