import { describe, expect, it } from 'vitest';

import type { RuntimeEvent } from './types';
import { initialRuntimeUiState, runtimeEventReducer, type RuntimeUiState } from './ui-state';

/** Fold a sequence of events from the initial state. */
function reduceAll(events: RuntimeEvent[]): RuntimeUiState {
  return events.reduce(runtimeEventReducer, initialRuntimeUiState);
}

describe('runtimeEventReducer', () => {
  it('accumulates text deltas and finalizes on run:finish with usage', () => {
    // WHY: the War Room/chat surfaces render `text` live; if deltas stop accumulating or the
    // final text/usage is dropped, the UI shows a truncated or usage-less result.
    const state = reduceAll([
      { type: 'run:start' },
      { type: 'text:delta', delta: 'Lumora ' },
      { type: 'text:delta', delta: 'is solid.' },
      { type: 'run:finish', text: 'Lumora is solid.', usage: { totalTokens: 42 } },
    ]);
    expect(state.status).toBe('done');
    expect(state.text).toBe('Lumora is solid.');
    expect(state.usage?.totalTokens).toBe(42);
  });

  it('tracks a tool call through running → done, matching result to its start', () => {
    // WHY: tool chips render status; a result must settle the matching running call, not
    // spawn a duplicate.
    const state = reduceAll([
      { type: 'run:start' },
      { type: 'tool:start', tool: 'analyze_distinctiveness', args: { reason: 'has competitors' } },
      { type: 'tool:result', tool: 'analyze_distinctiveness', result: { claims: ['close to Lunar'] } },
    ]);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]?.status).toBe('done');
    expect(state.toolCalls[0]?.result).toEqual({ claims: ['close to Lunar'] });
  });

  it('marks a tool call errored without losing it', () => {
    const state = reduceAll([
      { type: 'run:start' },
      { type: 'tool:start', tool: 'analyze_linguistic_form', args: {} },
      { type: 'tool:error', tool: 'analyze_linguistic_form', error: 'boom' },
    ]);
    expect(state.toolCalls[0]?.status).toBe('error');
    expect(state.toolCalls[0]?.error).toBe('boom');
  });

  it('run:start resets prior state (re-run in the same surface)', () => {
    const first = reduceAll([
      { type: 'run:start' },
      { type: 'text:delta', delta: 'old' },
      { type: 'run:finish', text: 'old', usage: {} },
    ]);
    const second = runtimeEventReducer(first, { type: 'run:start' });
    expect(second).toEqual({ status: 'running', text: '', toolCalls: [] });
  });

  it('captures run:error as terminal error status', () => {
    const state = reduceAll([{ type: 'run:start' }, { type: 'run:error', error: 'model unreachable' }]);
    expect(state.status).toBe('error');
    expect(state.error).toBe('model unreachable');
  });
});
