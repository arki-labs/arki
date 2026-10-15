/**
 * Coded errors for mistakes in job, schedule, flow and cron declarations.
 *
 * Most builder-order mistakes are already compile errors; these throws are
 * the runtime backstop for plain JS, casts, and the checks types cannot
 * express (unknown step ids, dependency cycles, out-of-range cron values,
 * duplicate schedule names).
 */

export const QUEUE_DEFINITION_ERROR_CODES = {
  missingName: 'ARKI_QUEUE_E006',
  missingInput: 'ARKI_QUEUE_E007',
  missingSteps: 'ARKI_QUEUE_E008',
  unknownStepDependency: 'ARKI_QUEUE_E009',
  circularStepDependency: 'ARKI_QUEUE_E010',
  invalidCronValue: 'ARKI_QUEUE_E011',
  scheduleMiddlewareWithJob: 'ARKI_QUEUE_E012',
  duplicateScheduleName: 'ARKI_QUEUE_E013',
  stepWithManyDependents: 'ARKI_QUEUE_E017',
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
