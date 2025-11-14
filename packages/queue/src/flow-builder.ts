/* eslint-disable drizzle/enforce-delete-with-where */
/**
 * Flow builder implementation
 * Provides chainable API for creating multi-step workflows
 *
 * Flows define multi-step workflows where steps can depend on each other:
 * - Each step runs a job with data derived from flow input
 * - Steps can specify dependencies (must run after other steps complete)
 * - Middleware applies to all steps in the flow
 *
 * @example
 * ```typescript
 * const orderFlow = q.flow
 *   .name('orders:process')
 *   .input(z.object({ orderId: z.string() }))
 *   .use(loggingMiddleware())
 *   .step('validate', {
 *     job: validateJob,
 *     data: input => ({ orderId: input.orderId }),
 *   })
 *   .step('payment', {
 *     job: paymentJob,
 *     data: input => ({ orderId: input.orderId }),
 *     dependsOn: ['validate'],
 *   })
 *   .build();
 * ```
 */

import type { z } from '@arki/contracts';

import type { FlowBuilderStart, FlowBuilderWithInput, FlowDefinition } from './types/builder.ts';
import type { JobDefinition } from './types/job.ts';
import type { JobMiddleware } from './types/middleware.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';

/**
 * Internal step representation
 */
type FlowStepInternal = {
  id: string;
  job: JobDefinition<unknown, unknown, unknown>;
  data: (input: unknown) => unknown;
  queueName?: string;
  opts?: unknown;
  dependsOn?: readonly string[];
};

/**
 * Internal flow definition structure
 * This is what gets stored in FlowDefinition._internal
 */
export type InternalFlowDefinition<TInput = unknown> = {
  /**
   * Flow name
   */
  name: string;

  /**
   * Input schema for the flow
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Steps in the flow
   */
  steps: readonly FlowStepInternal[];

  /**
   * Middleware chain applied to all steps
   */
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];

  /**
   * Queue configuration
   */
  config: QueueConfig;
};

/**
 * Internal state for flow builder
 */
type FlowBuilderState<TInput> = {
  config: QueueConfig;
  name: string;
  inputSchema?: z.ZodType<TInput>;
  middlewares: readonly JobMiddleware<unknown, unknown, QueueMeta>[];
  steps: FlowStepInternal[];
};

/**
 * Validate flow dependencies
 * Ensures all step dependencies reference valid step IDs
 * @internal
 */
function validateFlowDependencies(steps: readonly FlowStepInternal[]): void {
  const stepIds = new Set(steps.map(step => step.id));

  for (const step of steps) {
    if (!step.dependsOn) continue;

    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new Error(
          `Step "${step.id}" depends on "${dependency}", but no step with that ID exists. ` +
            `Available step IDs: ${[...stepIds].join(', ')}`,
        );
      }
    }
  }

  // Check for circular dependencies
  detectCircularDependencies(steps);
}

/**
 * Detect circular dependencies in flow steps
 * @internal
 */
function detectCircularDependencies(steps: readonly FlowStepInternal[]): void {
  const graph = new Map<string, Set<string>>();

  // Build dependency graph
  for (const step of steps) {
    graph.set(step.id, new Set(step.dependsOn ?? []));
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(stepId: string): boolean {
    visited.add(stepId);
    recursionStack.add(stepId);

    const dependencies = graph.get(stepId) ?? new Set();
    for (const dep of dependencies) {
      if (!visited.has(dep)) {
        if (hasCycle(dep)) return true;
      } else if (recursionStack.has(dep)) {
        return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id) && hasCycle(step.id)) {
      throw new Error(`Circular dependency detected in flow steps starting from step "${step.id}"`);
    }
  }
}

/**
 * Create a flow builder start (after name is set)
 * @internal
 */
export function createFlowBuilder<TContext, TMeta extends QueueMeta>(
  name: string,
  config: QueueConfig,
): FlowBuilderStart<TContext, TMeta> {
  return {
    input<TInput>(schema: z.ZodType<TInput>): FlowBuilderWithInput<TContext, TMeta, TInput> {
      return createFlowBuilderWithInput<TContext, TMeta, TInput>({
        config,
        name,
        inputSchema: schema,
        middlewares: [],
        steps: [],
      });
    },
  };
}

/**
 * Create a flow builder with input
 * @internal
 */
function createFlowBuilderWithInput<TContext, TMeta extends QueueMeta, TInput>(
  state: FlowBuilderState<TInput>,
): FlowBuilderWithInput<TContext, TMeta, TInput> {
  return {
    use(middleware: JobMiddleware<unknown, unknown, TMeta>) {
      return createFlowBuilderWithInput<TContext, TMeta, TInput>({
        ...state,
        middlewares: [...state.middlewares, middleware as JobMiddleware<unknown, unknown, QueueMeta>],
      });
    },

    step<const TId extends string>(
      id: TId,
      config: {
        job: JobDefinition<unknown, unknown, unknown>;
        data: (input: TInput) => unknown;
        queueName?: string;
        opts?: unknown;
        dependsOn?: readonly string[];
      },
    ) {
      const newStep: FlowStepInternal = {
        id,
        job: config.job,
        data: config.data as (input: unknown) => unknown,
        queueName: config.queueName,
        opts: config.opts,
        dependsOn: config.dependsOn,
      };

      return createFlowBuilderWithInput<TContext, TMeta, TInput>({
        ...state,
        steps: [...state.steps, newStep],
      });
    },

    build(): FlowDefinition {
      if (!state.inputSchema) {
        throw new Error('Input schema is required. Call .input() first.');
      }

      if (state.steps.length === 0) {
        throw new Error('At least one step is required. Call .step() before .build().');
      }

      // Validate step dependencies
      validateFlowDependencies(state.steps);

      const internal: InternalFlowDefinition<TInput> = {
        name: state.name,
        inputSchema: state.inputSchema,
        steps: state.steps,
        middlewares: state.middlewares,
        config: state.config,
      };

      return {
        _type: 'flow',
        _internal: internal,
      };
    },
  };
}
