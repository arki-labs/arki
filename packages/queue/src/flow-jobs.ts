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

import { InvalidInput, isFailure, UnexpectedDefect, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { FlowDefinition, FlowEnqueueResult } from './types/builder.ts';
import type { AnyJobDefinition } from './types/job.ts';
import { debugFlow, observeQueue } from './debug.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { jobDefaultOptions, jobRetryOptions } from './job-options.ts';
import { jobTraceOptions } from './job-trace.ts';
import { QueueAcceptanceUnknown } from './trigger.ts';

export const FLOW_ENQUEUE_FAILURES = [InvalidInput, ValidatorDefect, UnexpectedDefect, QueueAcceptanceUnknown] as const;
export type FlowEnqueueFailure = ReturnType<(typeof FLOW_ENQUEUE_FAILURES)[number]>;

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
    opts: {
      ...jobDefaultOptions(job._internal.options),
      ...jobTraceOptions(),
      ...tree.step.opts,
      ...jobRetryOptions(job._internal.options),
    },
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

/**
 * Validate `input` with the flow's schema (async: the enqueue call already awaits).
 * Returns `InvalidInput` when the input does not match, or `ValidatorDefect` when the schema cannot run.
 */
export async function parseFlowInput(flow: FlowDefinition, input: unknown): Promise<unknown> {
  const internal = flow._internal as BuiltFlow;
  return parseAsync(internal.inputSchema, input);
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
 * Invalid input or a broken data mapper returns a canonical failure before opening the producer.
 */
export async function addFlow(
  openProducer: () => FlowProducer,
  flow: FlowDefinition,
  input: unknown,
): Promise<FlowEnqueueResult | FlowEnqueueFailure> {
  const internal = flow._internal as BuiltFlow;
  return withEnqueueSpan(() => addFlowOwned(openProducer, flow, input, internal), internal.name, 'queue.flow.enqueue');
}

async function addFlowOwned(
  openProducer: () => FlowProducer,
  flow: FlowDefinition,
  input: unknown,
  internal: BuiltFlow,
): Promise<FlowEnqueueResult | FlowEnqueueFailure> {
  const validated = await parseFlowInput(flow, input);
  if (InvalidInput.is(validated) || ValidatorDefect.is(validated)) return validated;
  let jobs: FlowJob[];
  try {
    jobs = toFlowJobs(flow, validated);
    const validateTree = async (tree: StepTree, node: FlowJobNode): Promise<FlowEnqueueFailure | undefined> => {
      // A mapper declares job input, not a business outcome. Never enqueue a refusal inside a success tree.
      if (isFailure<unknown>(node.data)) return UnexpectedDefect({ cause: node.data });
      const parsed = await parseAsync(tree.step.job._internal.inputSchema, node.data);
      if (InvalidInput.is(parsed) || ValidatorDefect.is(parsed)) return parsed;
      for (const [index, child] of tree.children.entries()) {
        const childNode = node.children?.[index];
        if (childNode === undefined) return UnexpectedDefect();
        const failure = await validateTree(child, childNode);
        if (failure !== undefined) return failure;
      }
      return undefined;
    };
    for (const [index, tree] of stepTrees(internal).entries()) {
      const node = jobs[index];
      if (node === undefined) return UnexpectedDefect();
      const failure = await validateTree(tree, node);
      if (failure !== undefined) return failure;
    }
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
  let nodes: JobNode[];
  try {
    nodes = await openProducer().addBulk(jobs);
  } catch (error) {
    return QueueAcceptanceUnknown({ cause: error });
  }

  const jobIds: Record<string, string> = {};
  collectJobIds(stepTrees(internal), nodes, jobIds);
  observeQueue(() =>
    debugFlow.debug('[{flow}] Started flow with {roots} root job(s)', { flow: internal.name, roots: nodes.length }),
  );
  return { flow: internal.name, jobIds };
}
