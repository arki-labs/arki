'use client';

/**
 * React binding for the agent-runtime UI adapter (P2). Consumes a normalized
 * `RuntimeEvent` stream and folds it into renderable state via the pure
 * `runtimeEventReducer`, so any surface — the bespoke War Room, `@arki/chat-ui`,
 * a TanStack panel — renders uniformly regardless of which runtime backend
 * (AI SDK / Mastra / …) produced the events.
 *
 * The `source` is any `AsyncIterable<RuntimeEvent>`: a runtime's `runToolLoop()`
 * directly (same process), or a client-side stream decoded from SSE/fetch. This
 * hook owns only the reduction + abort lifecycle; transport is the caller's choice.
 */

import { useCallback, useRef, useState } from 'react';

import type { RuntimeEvent } from '../../runtime/types';
import { initialRuntimeUiState, runtimeEventReducer, type RuntimeUiState } from '../../runtime/ui-state';

export interface UseRuntimeStreamResult {
  state: RuntimeUiState;
  /** Consume a RuntimeEvent stream to completion, updating `state` as events arrive. */
  run: (source: AsyncIterable<RuntimeEvent>) => Promise<void>;
  /** Abort the in-flight stream (state keeps whatever was reduced so far). */
  stop: () => void;
  isStreaming: boolean;
}

export function useRuntimeStream(): UseRuntimeStreamResult {
  const [state, setState] = useState<RuntimeUiState>(initialRuntimeUiState);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const run = useCallback(async (source: AsyncIterable<RuntimeEvent>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let accumulated = initialRuntimeUiState;
    setState(accumulated);

    try {
      for await (const event of source) {
        if (controller.signal.aborted) break;
        accumulated = runtimeEventReducer(accumulated, event);
        setState(accumulated);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        setState(runtimeEventReducer(accumulated, { type: 'run:error', error: message }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { state, run, stop, isStreaming: state.status === 'running' };
}
