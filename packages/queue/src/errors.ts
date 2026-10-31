/**
 * Coded errors for mistakes in job, schedule, flow and cron declarations,
 * and the typed failures a job trigger returns.
 *
 * Most builder-order mistakes are already compile errors; these throws are
 * the runtime backstop for plain JS, casts, and the checks types cannot
 * express (unknown step ids, dependency cycles, out-of-range cron values,
 * duplicate schedule names).
 *
 * Browser-safe (`@arki/queue/errors`): an oRPC contract can list
 * `JOB_TRIGGER_FAILURES` in its error map without bundling the queue runtime.
 */
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure, InvalidInput, ValidatorDefect } from '@arki/failure';

export const QUEUE_DEFINITION_ERROR_CODES = {
  /**
   * A job, schedule or flow definition has no name.
   * @fix Give the job, schedule or flow a non-empty name before building its definition.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingName: 'ARKI_QUEUE_E006',
  /**
   * A handler was declared before its input schema.
   * @fix Call .input(schema) before defining the handler or building the declaration.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingInput: 'ARKI_QUEUE_E007',
  /**
   * A flow definition has no steps.
   * @fix Add at least one .step(...) before building a flow.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingSteps: 'ARKI_QUEUE_E008',
  /**
   * A flow step depends on an undeclared step.
   * @fix Reference only step ids declared in the same flow.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  unknownStepDependency: 'ARKI_QUEUE_E009',
  /**
   * Flow step dependencies contain a cycle.
   * @fix Remove dependency cycles so the flow steps form a directed acyclic graph.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  circularStepDependency: 'ARKI_QUEUE_E010',
  /**
   * A cron interval or time is outside its supported range.
   * @fix Pass cron intervals and times within the helper limits stated by the error.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  invalidCronValue: 'ARKI_QUEUE_E011',
  /**
   * A schedule wrapping a job declares schedule-level middleware.
   * @fix Remove schedule-level .use() when wrapping a job; put middleware on the job instead.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  scheduleMiddlewareWithJob: 'ARKI_QUEUE_E012',
  /**
   * Two schedules use the same name.
   * @fix Give each schedule a distinct .name(...), including schedules wrapping the same job.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  duplicateScheduleName: 'ARKI_QUEUE_E013',
  /**
   * A flow step has more than one dependent.
   * @fix Reshape the flow so a step has at most one dependent; use a supported dependency tree.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  stepWithManyDependents: 'ARKI_QUEUE_E017',
  /**
   * A job name contains characters unsupported by the queue backend.
   * @fix Rename the job with only letters, digits and _ - . / (for example "orders.process"); a job name is its queue name, and BullMQ and pg-boss reject other characters such as ":".
   * @verify bun run test -- src/builder-guards.spec.ts
   */
  invalidJobName: 'ARKI_QUEUE_E020',
} as const;

export class QueueDefinitionError extends Error {
  readonly code: (typeof QUEUE_DEFINITION_ERROR_CODES)[keyof typeof QUEUE_DEFINITION_ERROR_CODES];
  readonly remediation: string;

  constructor(args: {
    readonly code: (typeof QUEUE_DEFINITION_ERROR_CODES)[keyof typeof QUEUE_DEFINITION_ERROR_CODES];
    readonly message: string;
    readonly remediation: string;
  }) {
    super(args.message);
    this.name = 'QueueDefinitionError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}

/** Two schedules share a name. The name is the job scheduler id, so the second would replace the first. */
export function duplicateScheduleError(name: string): QueueDefinitionError {
  return new QueueDefinitionError({
    code: QUEUE_DEFINITION_ERROR_CODES.duplicateScheduleName,
    message: `Schedule "${name}" is already registered.`,
    remediation: 'Give each schedule its own name with .name("..."); two schedules of one job need different names.',
  });
}

export const QUEUE_INPUT_ERROR_CODES = {
  /**
   * The enqueue input does not satisfy the flow input schema.
   * @fix Pass enqueue input accepted by the declared flow input schema.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  invalidFlowInput: 'ARKI_QUEUE_E018',
} as const;

/**
 * Data handed to `enqueue()` failed its schema. Thrown before anything is
 * written to Redis, so no part of the flow starts. `cause` is the schema error.
 */
export class QueueInputError extends Error {
  readonly code: (typeof QUEUE_INPUT_ERROR_CODES)[keyof typeof QUEUE_INPUT_ERROR_CODES];
  readonly remediation: string;

  constructor(args: {
    readonly code: (typeof QUEUE_INPUT_ERROR_CODES)[keyof typeof QUEUE_INPUT_ERROR_CODES];
    readonly message: string;
    readonly remediation: string;
    readonly cause: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = 'QueueInputError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}

/**
 * The job has no active queue transport.
 * @fix Register and start the queue before triggering this job.
 * @verify bun run test -- src/trigger.spec.ts
 */
export const QueueUnavailable = defineFailure('queue.unavailable', {
  status: 503,
  message: 'The job has no active queue transport.',
  remediation: 'Register and start the queue before triggering this job.',
});
/**
 * The queue could not confirm whether the job was accepted.
 * @fix Inspect the job by its idempotency key before enqueueing it again.
 * @verify bun run test -- src/trigger.spec.ts
 */
export const QueueAcceptanceUnknown = defineFailure('queue.acceptance_unknown', {
  status: 503,
  message: 'The queue could not confirm whether the job was accepted.',
  remediation: 'Inspect the job by its idempotency key before enqueueing it again.',
});
/**
 * The queue worker started in the background and failed (Redis down, a slow start, a context factory that threw), so no job runs.
 * @fix Check Redis connectivity and the worker context factory, then restart the app; use `blocking: true` to fail `app.start()` instead.
 * @verify bun run test -- src/dot.spec.ts
 */
export const QueueWorkerStartFailed = /* @__PURE__ */ defineFailure('queue.worker_start_failed', {
  status: 503,
  message: 'The queue worker failed to start, so no job runs.',
  remediation:
    'Check Redis connectivity and the worker context factory, then restart the app; use blocking: true to fail app.start() instead.',
});
/** Every failure a job trigger can return — spread it into a contract's error map. */
export const JOB_TRIGGER_FAILURES = [
  InvalidInput,
  ValidatorDefect,
  QueueUnavailable,
  QueueAcceptanceUnknown,
  ...ID_GENERATION_FAILURES,
] as const;
export type JobTriggerFailure = ReturnType<(typeof JOB_TRIGGER_FAILURES)[number]>;
