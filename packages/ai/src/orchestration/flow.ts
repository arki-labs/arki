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
  run: (state: State, ctx: Context) => Promise<Partial<State> | void>;
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  nodeId?: string,
): Promise<T> {
  if (!timeoutMs) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new FlowError(`Flow node timed out after ${timeoutMs}ms`, { nodeId }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Flow<State, Context> {
  private readonly nodes: Map<string, FlowNode<State, Context>>;
  private readonly start: string;
  private readonly maxSteps: number;
  private readonly mergeState: (state: State, patch: Partial<State>) => State;
  private readonly onEvent?: (event: FlowEvent<State>) => void;
  private readonly signal?: AbortSignal;

  constructor(config: FlowConfig<State, Context>) {
    this.nodes = new Map(Object.entries(config.nodes));
    this.start = config.start;
    this.maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;
    this.mergeState = config.mergeState ?? ((state, patch) => ({ ...state, ...patch }));
    this.onEvent = config.onEvent;
    this.signal = config.signal;

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

      const maxAttempts = Math.max(1, (node.retries ?? 0) + 1);
      let attempt = 0;
      let patch: Partial<State> | void | undefined;

      while (attempt < maxAttempts) {
        attempt += 1;
        const startTime = Date.now();
        debugOrchestration('[Flow] Node start (node: %s, attempt: %d)', node.id, attempt);
        this.emit({ type: 'node:start', nodeId: node.id, attempt, state, timestamp: Date.now() });

        try {
          patch = await withTimeout(node.run(state, ctx), node.timeoutMs, node.id);

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

          if (attempt >= maxAttempts) {
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
