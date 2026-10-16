import type { RuntimeEvent, RuntimeUsage, ToolFailure } from './types';

/**
 * UI-adapter layer (P2): a framework-agnostic reduction of the normalized `RuntimeEvent`
 * stream into renderable state. This is the seam that lets ANY UI — the bespoke War Room,
 * `@arki/chat-ui` (assistant-ui), a TanStack surface — render uniformly from one runtime,
 * regardless of which backend (AI SDK / Mastra / …) produced the events.
 *
 * Pure + synchronous so it is trivially testable and reusable on server or client. The React
 * binding (`useRuntimeStream`) lives in `@arki/ai/react` and is a thin wrapper over this.
 */
export type RuntimeUiStatus = 'idle' | 'running' | 'done' | 'error';

export interface RuntimeToolCall {
  tool: string;
  args?: unknown;
  result?: unknown;
  /** The failure the tool returned (an expected outcome the model can correct), not a thrown error. */
  failure?: ToolFailure;
  error?: string;
  status: 'running' | 'done' | 'failed' | 'error';
}

export interface RuntimeUiState {
  status: RuntimeUiStatus;
  /** Accumulated assistant text (deltas joined; finalized on run:finish). */
  text: string;
  /** Tool calls in start order, each progressing running → done|failed|error. */
  toolCalls: RuntimeToolCall[];
  usage?: RuntimeUsage;
  error?: string;
}

export const initialRuntimeUiState: RuntimeUiState = {
  status: 'idle',
  text: '',
  toolCalls: [],
};

/** Update the most recent still-running tool call with the given name; append if none matches. */
function settleToolCall(
  toolCalls: RuntimeToolCall[],
  tool: string,
  patch: Partial<RuntimeToolCall>,
): RuntimeToolCall[] {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const candidate = toolCalls[i];
    if (candidate && candidate.tool === tool && candidate.status === 'running') {
      const next = toolCalls.slice();
      next[i] = { ...candidate, ...patch };
      return next;
    }
  }
  // No matching running call (e.g. a result without a prior start) — record it as settled.
  return [...toolCalls, { tool, status: 'done', ...patch }];
}

/** Fold one RuntimeEvent into the UI state. Pure. */
export function runtimeEventReducer(state: RuntimeUiState, event: RuntimeEvent): RuntimeUiState {
  switch (event.type) {
    case 'run:start':
      return { status: 'running', text: '', toolCalls: [] };
    case 'text:delta':
      return { ...state, text: state.text + event.delta };
    case 'tool:start':
      return { ...state, toolCalls: [...state.toolCalls, { tool: event.tool, args: event.args, status: 'running' }] };
    case 'tool:result':
      return {
        ...state,
        toolCalls: settleToolCall(state.toolCalls, event.tool, { result: event.result, status: 'done' }),
      };
    case 'tool:failure': {
      return {
        ...state,
        toolCalls: settleToolCall(state.toolCalls, event.tool, { failure: event.failure, status: 'failed' }),
      };
    }
    case 'tool:error':
      return {
        ...state,
        toolCalls: settleToolCall(state.toolCalls, event.tool, { error: event.error, status: 'error' }),
      };
    case 'run:finish':
      return { ...state, status: 'done', text: event.text.length > 0 ? event.text : state.text, usage: event.usage };
    case 'run:error':
      return { ...state, status: 'error', error: event.error };
    default:
      return state;
  }
}
