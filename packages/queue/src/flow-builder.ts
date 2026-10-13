/* eslint-disable drizzle/enforce-delete-with-where */
/**
 * Flow builder implementation
 * Provides chainable API for creating multi-step workflows
 *
 * Flows define multi-step workflows where steps can depend on each other:
 * - Each step runs a job with data derived from flow input
 * - Steps can specify dependencies (must run after other steps complete)
 * - Each step runs in its own job's worker, with that job's middleware (a flow has no `.use()`)
 *
 * @example
 * ```typescript
 * const orderFlow = q.flow
 *   .name('orders:process')
 *   .input(z.object({ orderId: z.string() }))
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

import type { FlowBuilderNeedsStep, FlowBuilderStart, FlowBuilderWithInput, FlowDefinition } from './types/builder.ts';
import type { AnyJobDefinition, JobDefinition } from './types/job.ts';
import type { QueueConfig, QueueMeta } from './types/queue.ts';
import { debugBuilder } from './debug.ts';
import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';

/**
 * Internal step representation.
 *
 * The builder stores each step's job as `AnyJobDefinition` (steps have
 * different job types); the queue reads `_internal` back with the default
 * `TJob`, the same erasure boundary schedules use.
 */
type FlowStepInternal<TJob = JobDefinition<unknown, unknown, unknown>> = {
  id: string;
  job: TJob;
  data: (input: unknown) => unknown;
  queueName?: string;
  opts?: unknown;
  dependsOn?: readonly string[];
};

/**
 * Internal flow definition structure
 * This is what gets stored in FlowDefinition._internal
 */
export type InternalFlowDefinition<TInput = unknown, TJob = JobDefinition<unknown, unknown, unknown>> = {
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
  steps: readonly FlowStepInternal<TJob>[];

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
  steps: FlowStepInternal<AnyJobDefinition>[];
};

/**
 * Validate flow dependencies
 * Ensures all step dependencies reference valid step IDs
 * @internal
 */
function validateFlowDependencies(steps: readonly FlowStepInternal<AnyJobDefinition>[]): void {
  debugBuilder.debug('Validating flow dependencies for {stepsLength} steps', { stepsLength: steps.length });

  const stepIds = new Set(steps.map(step => step.id));

  for (const step of steps) {
    if (!step.dependsOn) continue;

    debugBuilder.debug('[{stepId}] Validating dependencies: {dependencies}', {
      stepId: step.id,
      dependencies: step.dependsOn.join(', '),
    });

    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        debugBuilder.debug('[{stepId}] Invalid dependency detected: {detected}', {
          stepId: step.id,
          detected: dependency,
        });
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.unknownStepDependency,
          message:
            `Step "${step.id}" depends on "${dependency}", but no step with that ID exists. ` +
            `Available step IDs: ${[...stepIds].join(', ')}`,
          remediation: 'Fix the id in dependsOn, or add the missing .step() to the flow.',
        });
      }
    }
  }

  // Check for circular dependencies
  detectCircularDependencies(steps);
  debugBuilder.debug('Flow dependencies validated successfully');
}

/**
 * Detect circular dependencies in flow steps
 * @internal
 */
function detectCircularDependencies(steps: readonly FlowStepInternal<AnyJobDefinition>[]): void {
  debugBuilder.debug('Checking for circular dependencies in flow');

  const graph = new Map<string, Set<string>>();

  // Build dependency graph
  for (const step of steps) {
    graph.set(step.id, new Set(step.dependsOn));
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
        debugBuilder.debug('Circular dependency detected: {detected} -> {dep}', { detected: stepId, dep });
        return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id) && hasCycle(step.id)) {
      throw new QueueDefinitionError({
        code: QUEUE_DEFINITION_ERROR_CODES.circularStepDependency,
        message: `Circular dependency detected in flow steps starting from step "${step.id}"`,
        remediation: 'Remove one dependsOn entry so the steps form a chain with no loop.',
      });
    }
  }

  debugBuilder.debug('No circular dependencies found');
}

/**
 * Create a flow builder start (after name is set)
 * @internal
 */
export function createFlowBuilder<TContext, TMeta extends QueueMeta>(
  name: string,
  config: QueueConfig,
): FlowBuilderStart<TContext, TMeta> {
  debugBuilder.debug('[{name}] Creating flow builder', { name });

  return {
    input<TInput>(schema: z.ZodType<TInput>): FlowBuilderNeedsStep<TContext, TMeta, TInput> {
      debugBuilder.debug('[{name}] Setting input schema for flow', { name });

      // One runtime object serves both typestates: the FlowBuilderNeedsStep
      // type hides `.build()` until the first `.step()`; the throw below backs it up.
      return createFlowBuilderWithInput<TContext, TMeta, TInput>({
        config,
        name,
        inputSchema: schema,
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
    step<const TId extends string, TStepInput>(
      id: TId,
      config: {
        job: JobDefinition<TStepInput, unknown, never>;
        data: (input: TInput) => NoInfer<TStepInput>;
        queueName?: string;
        opts?: unknown;
        dependsOn?: readonly string[];
      },
    ) {
      debugBuilder.debug('[{stateName}] Adding step "{id}" (job: {job}, dependencies: {dependencies})', {
        stateName: state.name,
        id,
        job: config.job._internal.name,
        dependencies: config.dependsOn?.join(', ') ?? 'none',
      });

      const newStep: FlowStepInternal<AnyJobDefinition> = {
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
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingInput,
          message: 'Input schema is required. Call .input() first.',
          remediation: 'Add .input(schema) right after q.flow.name(...).',
        });
      }

      if (state.steps.length === 0) {
        throw new QueueDefinitionError({
          code: QUEUE_DEFINITION_ERROR_CODES.missingSteps,
          message: 'At least one step is required. Call .step() before .build().',
          remediation: 'Add at least one .step(id, { job, data }) before .build().',
        });
      }

      debugBuilder.debug('[{stateName}] Building flow definition with {stepsLength} steps', {
        stateName: state.name,
        stepsLength: state.steps.length,
      });

      // Validate step dependencies
      validateFlowDependencies(state.steps);

      const internal: InternalFlowDefinition<TInput, AnyJobDefinition> = {
        name: state.name,
        inputSchema: state.inputSchema,
        steps: state.steps,
        config: state.config,
      };

      debugBuilder.debug('[{stateName}] Flow definition built successfully', { stateName: state.name });

      return {
        _type: 'flow',
        _internal: internal,
      };
    },
  };
}
