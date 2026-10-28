import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Failure } from '@arki/failure';
import { defineFailure, UnexpectedDefect } from '@arki/failure';

import type { FlowConfig, FlowNode } from './flow';
import { createFlow, Flow } from './flow';

const PersistenceRefused = defineFailure('flow_test.persistence_refused', {
  message: 'Persistence refused',
});

const ApprovalRefused = defineFailure('flow_test.approval_refused', {
  message: 'Approval refused',
});

describe('returned node failures', () => {
  it('preserves the refusal without merging it, retrying, or continuing the flow', async () => {
    const refusal = PersistenceRefused();
    const events: string[] = [];
    let attempts = 0;
    let merges = 0;
    let continued = false;
    const state = { saved: false };
    const flow = createFlow<{ saved: boolean }, Record<string, never>>()({
      start: 'save',
      onEvent: event => events.push(event.type),
      mergeState: (previous, patch) => {
        merges += 1;
        return { ...previous, ...patch };
      },
      nodes: {
        save: {
          id: 'save',
          retries: 2,
          retryDelayMs: 0,
          run: () => {
            attempts += 1;
            return Promise.resolve(refusal);
          },
          next: 'publish',
        },
        publish: {
          id: 'publish',
          run: () => {
            continued = true;
            return Promise.resolve({ saved: true });
          },
        },
      },
    });

    const result = await flow.run(state, {});
    expectTypeOf(result).toEqualTypeOf<
      typeof state | ReturnType<typeof PersistenceRefused> | ReturnType<typeof UnexpectedDefect>
    >();
    expect(result).toBe(refusal);
    expect(state).toEqual({ saved: false });
    expect(attempts).toBe(1);
    expect(merges).toBe(0);
    expect(continued).toBe(false);
    expect(events).not.toContain('node:success');
    expect(events).not.toContain('flow:complete');
  });
});

it('infers distinct node failures from their definitions without widening them', async () => {
  type State = { saved: boolean };
  type Context = { approval: boolean };
  const save = {
    id: 'save',
    run: (_state, ctx) => Promise.resolve(ctx.approval ? { saved: true } : PersistenceRefused()),
    next: 'approve',
  } satisfies FlowNode<State, Context, Failure>;
  const approve = {
    id: 'approve',
    run: () => Promise.resolve(ApprovalRefused()),
  } satisfies FlowNode<State, Context, Failure>;
  const flow = createFlow<State, Context>()({ start: 'save', nodes: { save, approve } });
  const result = await flow.run({ saved: false }, { approval: true });
  expectTypeOf(result).toEqualTypeOf<
    | State
    | ReturnType<typeof PersistenceRefused>
    | ReturnType<typeof ApprovalRefused>
    | ReturnType<typeof UnexpectedDefect>
  >();
  expect(ApprovalRefused.is(result)).toBe(true);
});

it('returns successful state unwrapped and keeps failure-free authoring compatible', async () => {
  type State = { saved: boolean };
  const flow = createFlow<State, Record<string, never>>({
    start: 'prepare',
    nodes: {
      prepare: { id: 'prepare', run: () => Promise.resolve(), next: 'save' },
      save: { id: 'save', run: () => Promise.resolve({ saved: true }) },
    },
  });
  const result = await flow.run({ saved: false }, {});
  expectTypeOf(result).toEqualTypeOf<State | ReturnType<typeof UnexpectedDefect>>();
  expect(result).toEqual({ saved: true });
});

it('recognizes a failure even when its type is also admitted as state', async () => {
  const refusal = PersistenceRefused();
  let merged = false;
  const config: FlowConfig<typeof refusal, Record<string, never>, typeof refusal> = {
    start: 'save',
    mergeState: state => {
      merged = true;
      return state;
    },
    nodes: { save: { id: 'save', run: () => Promise.resolve(refusal) } },
  };
  const flow = new Flow(config);
  const result = await flow.run(refusal, {});
  expectTypeOf(result).toEqualTypeOf<typeof refusal | ReturnType<typeof UnexpectedDefect>>();
  expect(result).toBe(refusal);
  expect(merged).toBe(false);
});

it('contextually types inline nodes while inferring their concrete failure', async () => {
  type State = { saved: boolean };
  type Context = { allowed: boolean };
  const flow = createFlow<State, Context>()({
    start: 'save',
    nodes: {
      save: {
        id: 'save',
        run: (state, ctx) => Promise.resolve(ctx.allowed ? { saved: !state.saved } : PersistenceRefused()),
      },
    },
  });
  const result = await flow.run({ saved: false }, { allowed: true });
  expectTypeOf(result).toEqualTypeOf<
    State | ReturnType<typeof PersistenceRefused> | ReturnType<typeof UnexpectedDefect>
  >();
  expect(result).toEqual({ saved: true });
});

it('rejects hidden refusals when a partial state shares canonical failure fields', () => {
  type State = { code: string; saved: boolean };
  type Context = Record<string, never>;
  const nodes = { save: { id: 'save', run: () => Promise.resolve(PersistenceRefused()) } };

  // @ts-expect-error The direct builder cannot promise State while returning a refusal without saved.
  const direct = createFlow<State, Context>({ start: 'save', nodes });
  const config: FlowConfig<State, Context> = {
    start: 'save',
    // @ts-expect-error Annotating a config must not erase a structurally compatible refusal.
    nodes,
  };
  // @ts-expect-error The constructor follows the same failure-free output contract.
  const constructed = new Flow<State, Context>({ start: 'save', nodes });
  // @ts-expect-error An explicitly broad patch output must not bypass refusal checking.
  const broad = createFlow<State, Context, Partial<State> | void>({ start: 'save', nodes });

  expectTypeOf(direct).toBeObject();
  expectTypeOf(config).toBeObject();
  expectTypeOf(constructed).toBeObject();
  expectTypeOf(broad).toBeObject();
});

it('infers overlapping refusals precisely alongside state patches and void nodes', async () => {
  type State = { code: string; saved: boolean };
  const refusal = PersistenceRefused();
  const flow = createFlow<State, Record<string, never>>()({
    start: 'prepare',
    nodes: {
      prepare: { id: 'prepare', run: () => Promise.resolve(), next: 'save' },
      save: { id: 'save', run: () => Promise.resolve({ saved: true }), next: 'persist' },
      persist: { id: 'persist', run: () => Promise.resolve(refusal) },
    },
  });

  const result = await flow.run({ code: 'ready', saved: false }, {});
  expectTypeOf(result).toEqualTypeOf<State | typeof refusal | ReturnType<typeof UnexpectedDefect>>();
  expect(result).toBe(refusal);
});

it('returns a retry-wait defect unchanged without another attempt or a success event', async () => {
  const { SystemClock } = await import('@arki/clock');
  const { vi } = await import('vitest');
  const cause = new Error('timer provider failed');
  const defect = UnexpectedDefect({ cause });
  const wait = vi.spyOn(SystemClock.prototype, 'sleep').mockResolvedValue(defect);
  let attempts = 0;
  const events: string[] = [];
  try {
    const flow = createFlow<{ saved: boolean }, Record<string, never>>({
      start: 'save',
      onEvent: event => {
        events.push(event.type);
      },
      nodes: {
        save: {
          id: 'save',
          retries: 1,
          run: () => {
            attempts++;
            return Promise.reject(new Error('retryable callback'));
          },
        },
      },
    });
    expect(await flow.run({ saved: false }, {})).toBe(defect);
    expect(attempts).toBe(1);
    expect(events).not.toContain('flow:complete');
  } finally {
    wait.mockRestore();
  }
});
