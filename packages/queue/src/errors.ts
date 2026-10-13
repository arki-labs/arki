/**
 * Coded errors for mistakes in job, schedule, flow and cron declarations.
 *
 * Most builder-order mistakes are already compile errors; these throws are
 * the runtime backstop for plain JS, casts, and the checks types cannot
 * express (unknown step ids, dependency cycles, out-of-range cron values).
 */

export const QUEUE_DEFINITION_ERROR_CODES = {
  missingName: 'ARKI_QUEUE_E006',
  missingInput: 'ARKI_QUEUE_E007',
  missingSteps: 'ARKI_QUEUE_E008',
  unknownStepDependency: 'ARKI_QUEUE_E009',
  circularStepDependency: 'ARKI_QUEUE_E010',
  invalidCronValue: 'ARKI_QUEUE_E011',
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
