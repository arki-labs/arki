/**
 * Coded errors for mistakes in job, schedule, flow and cron declarations.
 *
 * Most builder-order mistakes are already compile errors; these throws are
 * the runtime backstop for plain JS, casts, and the checks types cannot
 * express (unknown step ids, dependency cycles, out-of-range cron values,
 * duplicate schedule names).
 */

export const QUEUE_DEFINITION_ERROR_CODES = {
  /**
   * @fix Give the job, schedule or flow a non-empty name before building its definition.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingName: 'ARKI_QUEUE_E006',
  /**
   * @fix Call .input(schema) before defining the handler or building the declaration.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingInput: 'ARKI_QUEUE_E007',
  /**
   * @fix Add at least one .step(...) before building a flow.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  missingSteps: 'ARKI_QUEUE_E008',
  /**
   * @fix Reference only step ids declared in the same flow.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  unknownStepDependency: 'ARKI_QUEUE_E009',
  /**
   * @fix Remove dependency cycles so the flow steps form a directed acyclic graph.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  circularStepDependency: 'ARKI_QUEUE_E010',
  /**
   * @fix Pass cron intervals and times within the helper limits stated by the error.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  invalidCronValue: 'ARKI_QUEUE_E011',
  /**
   * @fix Remove schedule-level .use() when wrapping a job; put middleware on the job instead.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  scheduleMiddlewareWithJob: 'ARKI_QUEUE_E012',
  /**
   * @fix Give each schedule a distinct .name(...), including schedules wrapping the same job.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  duplicateScheduleName: 'ARKI_QUEUE_E013',
  /**
   * @fix Reshape the flow so a step has at most one dependent; use a supported dependency tree.
   * @verify bun run test -- src/builder-guards.spec.ts src/flow-builder.spec.ts
   */
  stepWithManyDependents: 'ARKI_QUEUE_E017',
  /**
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
