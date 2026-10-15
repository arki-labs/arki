/**
 * Turn a built flow into BullMQ flow jobs, and start it.
 *
 * A flow is a BullMQ tree. A step that no other step depends on is a root.
 * The steps in its `dependsOn` become its children, recursively. BullMQ runs
 * the children first and the parent once all of them completed. The flow
 * builder already rejected cycles and steps with two dependents, so every
 * step lands in exactly one tree, exactly once.
 */

import type { FlowJob, FlowJobNode, FlowProducer, JobNode } from 'bullmq';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { FlowDefinition, FlowEnqueueResult } from './types/builder.ts';
import type { AnyJobDefinition } from './types/job.ts';
import { debugFlow } from './debug.ts';
import { QUEUE_INPUT_ERROR_CODES, QueueInputError } from './errors.ts';
import { jobDefaultOptions } from './job-options.ts';

type BuiltFlow = InternalFlowDefinition<unknown, AnyJobDefinition>;
type FlowStep = BuiltFlow['steps'][number];

/** One step with the steps that must finish before it. */
type StepTree = {
  readonly step: FlowStep;
  readonly children: readonly StepTree[];
};

/** The flow's steps as trees, roots in declaration order. */
function stepTrees(flow: BuiltFlow): readonly StepTree[] {
  const byId = new Map(flow.steps.map(step => [step.id, step]));
  const hasDependent = new Set(flow.steps.flatMap(step => step.dependsOn ?? []));

  const treeOf = (step: FlowStep): StepTree => ({
    step,
    children: [...new Set(step.dependsOn)].flatMap(id => {
      const child = byId.get(id);
      return child === undefined ? [] : [treeOf(child)];
    }),
  });

  return flow.steps.filter(step => !hasDependent.has(step.id)).map(step => treeOf(step));
}

function toFlowJobNode(tree: StepTree, input: unknown): FlowJobNode {
  const { job } = tree.step;
  // The worker of a job reads the queue named after the job: the same queue `enqueue(job)` adds to.
  const queueName = job._internal.name;
  const node = {
    name: queueName,
    queueName,
    data: tree.step.data(input),
    // What the job's queue would apply on `add()`, then the step's own options
    opts: { ...jobDefaultOptions(job._internal.options), ...tree.step.opts },
  };
  if (tree.children.length === 0) return node;
  return { ...node, children: tree.children.map(child => toFlowJobNode(child, input)) };
}

/**
 * The BullMQ flow jobs of a built flow for one (already validated) input:
 * one tree per root step. Pure: touches no Redis.
 */
export function toFlowJobs(flow: FlowDefinition, input: unknown): FlowJob[] {
  const internal = flow._internal as BuiltFlow;
  return stepTrees(internal).map(tree => toFlowJobNode(tree, input));
}

/** Validate `input` with the flow's schema. Throws `ARKI_QUEUE_E018` on failure. */
export function parseFlowInput(flow: FlowDefinition, input: unknown): unknown {
  const internal = flow._internal as BuiltFlow;
  const result = internal.inputSchema.safeParse(input);
  if (result.success) return result.data;
  throw new QueueInputError({
    code: QUEUE_INPUT_ERROR_CODES.invalidFlowInput,
    message: `Input of flow "${internal.name}" does not match its schema: ${result.error.message}`,
    remediation: 'Pass enqueue(flow, input) an input that matches the schema given to .input(); see `cause`.',
    cause: result.error,
  });
}

function collectJobIds(trees: readonly StepTree[], nodes: readonly JobNode[], into: Record<string, string>): void {
  // BullMQ returns each node's children in the order they were given
  for (const [index, tree] of trees.entries()) {
    const node = nodes[index];
    if (node === undefined) continue;
    into[tree.step.id] = node.job.id ?? '';
    collectJobIds(tree.children, node.children ?? [], into);
  }
}

/**
 * Validate the input, then add the whole flow in one atomic `addBulk`.
 * An invalid input throws before the producer is opened: nothing is written.
 */
export async function addFlow(
  openProducer: () => FlowProducer,
  flow: FlowDefinition,
  input: unknown,
): Promise<FlowEnqueueResult> {
  const internal = flow._internal as BuiltFlow;
  const validated = parseFlowInput(flow, input);
  const nodes = await openProducer().addBulk(toFlowJobs(flow, validated));

  const jobIds: Record<string, string> = {};
  collectJobIds(stepTrees(internal), nodes, jobIds);
  debugFlow.debug('[{flow}] Started flow with {roots} root job(s)', { flow: internal.name, roots: nodes.length });
  return { flow: internal.name, jobIds };
}
