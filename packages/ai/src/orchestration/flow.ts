import type { Failure } from '@arki/failure';
import { sleep } from '@arki/async';
import { isFailure } from '@arki/failure';

import { debugOrchestration } from '../debug.js';
import { Cancelled, FlowNodeFailed, FlowStepLimitReached, FlowTimedOut } from '../failures.js';

/**
 * The expected ways a flow run stops early, returned by `Flow.run`: the caller aborted (`Cancelled`),
 * a node ran past its `timeoutMs` (`FlowTimedOut`), the flow took more than `maxSteps` steps
 * (`FlowStepLimitReached`), or a node still threw after its retries (`FlowNodeFailed`).
 */
export type FlowFailure = Cancelled | FlowTimedOut | FlowStepLimitReached | FlowNodeFailed;

export type FlowEvent<State> =
  | { type: 'flow:start'; state: State; timestamp: number }
  | { type: 'node:start'; nodeId: string; attempt: number; state: State; timestamp: number }
  | {
      type: 'node:success';
      nodeId: string;
      attempt: number;
      durationMs: number;
      state: State;
      patch?: Partial<State>;
      timestamp: number;
    }
  | { type: 'node:error'; nodeId: string; attempt: number; error: Error; timestamp: number }
  | { type: 'flow:complete'; state: State; steps: number; timestamp: number }
  | { type: 'flow:failed'; nodeId: string; failure: FlowFailure; steps: number; timestamp: number };

/** A state patch cannot carry the canonical failure brand, even if fields overlap. */
type FlowOutput<Output> = Output extends Failure | void ? Output : Output & { readonly '~failure'?: never };

type FlowTask<State, Context, Output> = {
  id: string;
  description?: string;
  run: (state: State, ctx: Context, signal?: AbortSignal) => Promise<Output & FlowOutput<Output>>;
  next?: string | ((state: State, ctx: Context) => string | null | undefined);
  retries?: number;
  retryDelayMs?: number;
  retryBackoffFactor?: number;
  timeoutMs?: number;
};

/** Use `satisfies` to retain the node's concrete return type when it can refuse. */
export type FlowNode<State, Context, Refusal extends Failure = never> = FlowTask<
  State,
  Context,
  Partial<State> | void | Refusal
>;

/** Output is the node return type; infer it with the curried `createFlow` builder. */
export type FlowConfig<State, Context, Output extends Partial<State> | void | Failure = Partial<State> | void> = {
  start: string;
  nodes: Record<string, FlowTask<State, Context, Output>>;
  maxSteps?: number;
  mergeState?: (state: State, patch: Partial<State>) => State;
  onEvent?: (event: FlowEvent<State>) => void;
  signal?: AbortSignal;
  /**
   * Cooperative checkpoint awaited at each node boundary, *before* the node runs.
   * Unlike {@link FlowConfig.onEvent} (fire-and-forget), this is `await`ed — so a
   * consumer can park the flow on a resumable promise to implement pause/resume/step
   * without ever interrupting an in-flight node. The sibling of {@link FlowConfig.signal}:
   * `signal` aborts running nodes cooperatively, `onCheckpoint` can hold between nodes.
   */
  onCheckpoint?: (nodeId: string, state: State) => Promise<void>;
};

/** A broken flow definition: the start node or a `next` target does not exist. A caller bug, thrown. */
export class FlowError extends Error {
  readonly nodeId?: string;
  readonly attempt?: number;
  override readonly cause?: Error;

  constructor(message: string, options?: { nodeId?: string; attempt?: number; cause?: Error }) {
    super(message);
    this.name = 'FlowError';
    this.nodeId = options?.nodeId;
    this.attempt = options?.attempt;
    this.cause = options?.cause;
  }
}

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_RETRY_BACKOFF = 2;

/** Why `runAttempt` stopped a node: the caller's abort or the node's timeout. */
class FlowInterruptedError extends FlowError {
  constructor(
    readonly reason: 'aborted' | 'timeout',
    message: string,
    nodeId?: string,
  ) {
    super(message, { nodeId });
  }
}

function isStatePatch<State>(value: Partial<State> | void | Failure): value is Partial<State> | void {
  return !isFailure<unknown>(value);
}

function isNodeFailure<Value>(value: Value): value is Extract<Value, Failure> {
  return isFailure<unknown>(value);
}

/** Bound the attempt on interruption; never retry work that may still be stopping. */
async function runAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  nodeId?: string,
): Promise<T> {
  const controller = new AbortController();
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason: unknown = controller.signal.reason;
        reject(reason instanceof Error ? reason : new FlowInterruptedError('aborted', 'Flow aborted by signal', nodeId));
      },
      { once: true },
    );
  });
  const abort = () => controller.abort(new FlowInterruptedError('aborted', 'Flow aborted by signal', nodeId));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = timeoutMs
    ? setTimeout(() => {
        controller.abort(new FlowInterruptedError('timeout', `Flow node timed out after ${timeoutMs}ms`, nodeId));
      }, timeoutMs)
    : undefined;

  try {
    try {
      const result = await Promise.race([
        interrupted,
        (async () => {
          controller.signal.throwIfAborted();
          return operation(controller.signal);
        })(),
      ]);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      controller.signal.throwIfAborted();
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export class Flow<State, Context, Output extends Partial<State> | void | Failure = Partial<State> | void> {
  private readonly nodes: Map<string, FlowTask<State, Context, Output>>;
  private readonly start: string;
  private readonly maxSteps: number;
  private readonly mergeState: (state: State, patch: Partial<State>) => State;
  private readonly onEvent?: (event: FlowEvent<State>) => void;
  private readonly signal?: AbortSignal;
  private readonly onCheckpoint?: (nodeId: string, state: State) => Promise<void>;

  constructor(config: FlowConfig<State, Context, Output>) {
    this.nodes = new Map(Object.entries(config.nodes));
    this.start = config.start;
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
    this.mergeState = config.mergeState ?? ((state, patch) => ({ ...state, ...patch }));
    this.onEvent = config.onEvent;
    this.signal = config.signal;
    this.onCheckpoint = config.onCheckpoint;

    if (!this.nodes.has(this.start)) {
      throw new FlowError(`Flow start node not found: ${this.start}`);
    }
  }

  private emit(event: FlowEvent<State>) {
    this.onEvent?.(event);
  }

  /** Emit `flow:failed` for an expected early stop and hand the failure back for `run` to return. */
  private stopped<F extends FlowFailure>(nodeId: string, failure: F, steps: number): F {
    debugOrchestration.debug('[Flow] Stopped at {node}: {code}', { node: nodeId, code: failure.code });
    this.emit({ type: 'flow:failed', nodeId, failure, steps, timestamp: Date.now() });
    return failure;
  }

  /**
   * Run the flow from its start node. Returns the final state, a node's own refusal, or a
   * {@link FlowFailure}. Throws `FlowError` only for a broken definition (a `next` to a missing node).
   */
  async run(initialState: State, ctx: Context) {
    let state = initialState;
    let current = this.start;
    let steps = 0;

    debugOrchestration.debug('[Flow] Starting (start: {start})', { start: current });
    this.emit({ type: 'flow:start', state, timestamp: Date.now() });

    while (current) {
      if (this.signal?.aborted) return this.stopped(current, Cancelled(), steps);

      steps += 1;
      if (steps > this.maxSteps)
        return this.stopped(current, FlowStepLimitReached({ nodeId: current, maxSteps: this.maxSteps }), steps);

      const node = this.nodes.get(current);
      if (!node) throw new FlowError(`Flow node not found: ${current}`, { nodeId: current });

      // Cooperative pause point — held at the node boundary, never mid-node. A consumer
      // can park the flow here (pause/step); abort during the hold is honored next.
      if (this.onCheckpoint) {
        await this.onCheckpoint(node.id, state);
        if (this.signal?.aborted) return this.stopped(current, Cancelled(), steps);
      }

      const maxAttempts = Math.max(1, (node.retries ?? 0) + 1);
      let attempt = 0;

      while (attempt < maxAttempts) {
        attempt += 1;
        const startTime = Date.now();
        debugOrchestration.debug('[Flow] Node start (node: {node}, attempt: {attempt})', { node: node.id, attempt });
        this.emit({ type: 'node:start', nodeId: node.id, attempt, state, timestamp: Date.now() });

        try {
          const result = await runAttempt<Output>(
            signal => node.run(state, ctx, signal),
            this.signal,
            node.timeoutMs,
            node.id,
          );
          // Separate truthful guards retain the exact failure even when State can
          // itself contain a Failure; a generic negative guard cannot prove a patch.
          if (!isStatePatch<State>(result) && isNodeFailure(result)) return result;
          const patch = isStatePatch<State>(result) ? result : undefined;

          if (patch && typeof patch === 'object') {
            state = this.mergeState(state, patch);
          }

          const durationMs = Date.now() - startTime;
          debugOrchestration.debug('[Flow] Node success (node: {node}, duration: {duration}ms)', {
            node: node.id,
            duration: durationMs,
          });
          this.emit({
            type: 'node:success',
            nodeId: node.id,
            attempt,
            durationMs,
            state,
            patch: patch && typeof patch === 'object' ? patch : undefined,
            timestamp: Date.now(),
          });
          break;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          debugOrchestration.debug('[Flow] Node error (node: {node}, attempt: {attempt}): {errMessage}', {
            node: node.id,
            attempt,
            errMessage: err.message,
          });
          this.emit({ type: 'node:error', nodeId: node.id, attempt, error: err, timestamp: Date.now() });

          if (this.signal?.aborted || (err instanceof FlowInterruptedError && err.reason === 'aborted'))
            return this.stopped(node.id, Cancelled({ cause: err }), steps);
          if (err instanceof FlowInterruptedError)
            return this.stopped(
              node.id,
              FlowTimedOut({ nodeId: node.id, timeoutMs: node.timeoutMs ?? 0 }, { cause: err }),
              steps,
            );
          if (attempt >= maxAttempts)
            return this.stopped(node.id, FlowNodeFailed({ nodeId: node.id, attempts: attempt }, { cause: err }), steps);

          const delay =
            (node.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) *
            Math.pow(node.retryBackoffFactor ?? DEFAULT_RETRY_BACKOFF, attempt - 1);
          const waited = await sleep(delay);
          if (isFailure(waited)) return waited;
        }
      }

      const next = typeof node.next === 'function' ? node.next(state, ctx) : node.next;
      current = next ?? '';
    }

    debugOrchestration.debug('[Flow] Completed (steps: {steps})', { steps });
    this.emit({ type: 'flow:complete', state, steps, timestamp: Date.now() });
    return state;
  }
}

type InferredFlowConfig<State, Context, Outputs extends Record<string, Partial<State> | void | Failure>> = Omit<
  FlowConfig<State, Context>,
  'nodes'
> & {
  nodes: { [Name in keyof Outputs]: FlowTask<State, Context, Outputs[Name]> };
};

export function createFlow<State, Context>(): <Outputs extends Record<string, Partial<State> | void | Failure>>(
  config: InferredFlowConfig<State, Context, Outputs>,
) => Flow<State, Context, Outputs[keyof Outputs]>;
export function createFlow<State, Context, Output extends Partial<State> | void | Failure = Partial<State> | void>(
  config: FlowConfig<State, Context, Output>,
): Flow<State, Context, Output>;
export function createFlow<State, Context, Output extends Partial<State> | void | Failure = Partial<State> | void>(
  config?: FlowConfig<State, Context, Output>,
) {
  if (config) return new Flow(config);
  return <Outputs extends Record<string, Partial<State> | void | Failure>>(
    flowConfig: InferredFlowConfig<State, Context, Outputs>,
  ) => new Flow<State, Context, Outputs[keyof Outputs]>(flowConfig);
}
