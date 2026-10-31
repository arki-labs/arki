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

import type { RuntimeEvent } from '../../runtime/types.js';
import { Cancelled, ConnectionLost } from '../../failures.js';
import { thrownRunFailure } from '../../runtime/types.js';
import { initialRuntimeUiState, runtimeEventReducer  } from '../../runtime/ui-state.js';
import type {RuntimeUiState} from '../../runtime/ui-state.js';

export type UseRuntimeStreamResult = {
  state: RuntimeUiState;
  /**
   * Consume a RuntimeEvent stream to completion, updating `state` as events arrive. `source` gets the
   * signal `stop()` aborts: pass it on (`signal => fetchRuntimeEventStream(url, { signal })`, or
   * `runToolLoop({ ..., signal })`) so stopping really cancels the request. A new `run` stops the last one.
   */
  run: (source: (signal: AbortSignal) => AsyncIterable<RuntimeEvent>) => Promise<void>;
  /** Abort the in-flight stream. The run ends with status `error` and a `Cancelled` failure. */
  stop: () => void;
  isStreaming: boolean;
}

export function useRuntimeStream(): UseRuntimeStreamResult {
  const [state, setState] = useState<RuntimeUiState>(initialRuntimeUiState);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every `run`, so a superseded run never writes over the state of the run that replaced it.
  const runIdRef = useRef(0);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const run = useCallback(async (source: (signal: AbortSignal) => AsyncIterable<RuntimeEvent>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runIdRef.current += 1;
    const runId = runIdRef.current;
    const isCurrent = () => runIdRef.current === runId;

    let accumulated = initialRuntimeUiState;
    setState(accumulated);

    try {
      for await (const event of source(controller.signal)) {
        if (controller.signal.aborted) break;
        accumulated = runtimeEventReducer(accumulated, event);
        setState(accumulated);
      }
    } catch (error) {
      accumulated = runtimeEventReducer(accumulated, {
        type: 'run:error',
        failure: thrownRunFailure(error, controller.signal),
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }

    // A stream that stopped without run:finish or run:error did not finish: never leave it `running`.
    if (accumulated.status === 'running' || accumulated.status === 'idle') {
      accumulated = runtimeEventReducer(accumulated, {
        type: 'run:error',
        failure: controller.signal.aborted ? Cancelled() : ConnectionLost(),
      });
    }
    if (isCurrent()) setState(accumulated);
  }, []);

  return { state, run, stop, isStreaming: state.status === 'running' };
}
