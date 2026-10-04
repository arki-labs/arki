import { debugOrchestration } from '../debug';

export type FlowEvent<State> =
  | { type: 'flow:start'; state: State; timestamp: number }
  | { type: 'node:start'; nodeId: string; attempt: number; state: State; timestamp: number }
  | { type: 'node:success'; nodeId: string; attempt: number; durationMs: number; state: State; patch?: Partial<State>; timestamp: number }
  | { type: 'node:error'; nodeId: string; attempt: number; error: Error; timestamp: number }
  | { type: 'flow:complete'; state: State; steps: number; timestamp: number }
  | { type: 'flow:failed'; nodeId: string; error: Error; steps: number; timestamp: number };

export type FlowNode<State, Context> = {
  id: string;
  description?: string;
  run: (state: State, ctx: Context, signal?: AbortSignal) => Promise<Partial<State> | void>;
  next?: string | ((state: State, ctx: Context) => string | null | undefined);
  retries?: number;
  retryDelayMs?: number;
  retryBackoffFactor?: number;
  timeoutMs?: number;
};

export type FlowConfig<State, Context> = {
  start: string;
  nodes: Record<string, FlowNode<State, Context>>;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FlowInterruptedError extends FlowError {}

/** Bound the attempt on interruption; never retry work that may still be stopping. */
async function runAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  nodeId?: string,
): Promise<T> {
  const controller = new AbortController();
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error ? reason : new FlowInterruptedError('Flow aborted by signal', { nodeId }));
    }, { once: true });
  });
  const abort = () => controller.abort(new FlowInterruptedError('Flow aborted by signal', { nodeId }));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = timeoutMs ? setTimeout(() => {
    controller.abort(new FlowInterruptedError(`Flow node timed out after ${timeoutMs}ms`, { nodeId }));
  }, timeoutMs) : undefined;

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

export class Flow<State, Context> {
  private readonly nodes: Map<string, FlowNode<State, Context>>;
  private readonly start: string;
  private readonly maxSteps: number;
  private readonly mergeState: (state: State, patch: Partial<State>) => State;
  private readonly onEvent?: (event: FlowEvent<State>) => void;
  private readonly signal?: AbortSignal;
  private readonly onCheckpoint?: (nodeId: string, state: State) => Promise<void>;

  constructor(config: FlowConfig<State, Context>) {
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

  async run(initialState: State, ctx: Context): Promise<State> {
    let state = initialState;
    let current = this.start;
    let steps = 0;

    debugOrchestration('[Flow] Starting (start: %s)', current);
    this.emit({ type: 'flow:start', state, timestamp: Date.now() });

    while (current) {
      if (this.signal?.aborted) {
        const error = new FlowError('Flow aborted by signal');
        this.emit({ type: 'flow:failed', nodeId: current, error, steps, timestamp: Date.now() });
        throw error;
      }

      steps += 1;
      if (steps > this.maxSteps) {
        const error = new FlowError(`Flow exceeded max steps (${this.maxSteps})`, { nodeId: current });
        this.emit({ type: 'flow:failed', nodeId: current, error, steps, timestamp: Date.now() });
        throw error;
      }

      const node = this.nodes.get(current);
      if (!node) {
        const error = new FlowError(`Flow node not found: ${current}`, { nodeId: current });
        this.emit({ type: 'flow:failed', nodeId: current, error, steps, timestamp: Date.now() });
        throw error;
      }

      // Cooperative pause point — held at the node boundary, never mid-node. A consumer
      // can park the flow here (pause/step); abort during the hold is honored next.
      if (this.onCheckpoint) {
        await this.onCheckpoint(node.id, state);
        if (this.signal?.aborted) {
          const error = new FlowError('Flow aborted by signal');
          this.emit({ type: 'flow:failed', nodeId: current, error, steps, timestamp: Date.now() });
          throw error;
        }
      }

      const maxAttempts = Math.max(1, (node.retries ?? 0) + 1);
      let attempt = 0;
      let patch: Partial<State> | void | undefined;

      while (attempt < maxAttempts) {
        attempt += 1;
        const startTime = Date.now();
        debugOrchestration('[Flow] Node start (node: %s, attempt: %d)', node.id, attempt);
        this.emit({ type: 'node:start', nodeId: node.id, attempt, state, timestamp: Date.now() });

        try {
          patch = await runAttempt(signal => node.run(state, ctx, signal), this.signal, node.timeoutMs, node.id);

          if (patch && typeof patch === 'object') {
            state = this.mergeState(state, patch);
          }

          const durationMs = Date.now() - startTime;
          debugOrchestration('[Flow] Node success (node: %s, duration: %dms)', node.id, durationMs);
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
          debugOrchestration('[Flow] Node error (node: %s, attempt: %d): %s', node.id, attempt, err.message);
          this.emit({ type: 'node:error', nodeId: node.id, attempt, error: err, timestamp: Date.now() });

          if (err instanceof FlowInterruptedError || this.signal?.aborted || attempt >= maxAttempts) {
            const flowError = new FlowError(`Flow node failed: ${node.id}`, {
              nodeId: node.id,
              attempt,
              cause: err,
            });
            this.emit({ type: 'flow:failed', nodeId: node.id, error: flowError, steps, timestamp: Date.now() });
            throw flowError;
          }

          const delay = (node.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
            * Math.pow(node.retryBackoffFactor ?? DEFAULT_RETRY_BACKOFF, attempt - 1);
          await sleep(delay);
        }
      }

      const next = typeof node.next === 'function' ? node.next(state, ctx) : node.next;
      current = next ?? '';
    }

    debugOrchestration('[Flow] Completed (steps: %d)', steps);
    this.emit({ type: 'flow:complete', state, steps, timestamp: Date.now() });
    return state;
  }
}

export function createFlow<State, Context>(config: FlowConfig<State, Context>): Flow<State, Context> {
  return new Flow(config);
}
