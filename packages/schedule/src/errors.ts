export const SCHEDULE_ERROR_CODES = {
  invalidDefinition: 'ARKI_SCHEDULE_E001',
  duplicateSchedule: 'ARKI_SCHEDULE_E002',
  handlerFailure: 'ARKI_SCHEDULE_E003',
  lockAcquireFailure: 'ARKI_SCHEDULE_E004',
  durableBackendMissing: 'ARKI_SCHEDULE_E005',
} as const;

export class ScheduleError extends Error {
  readonly code: (typeof SCHEDULE_ERROR_CODES)[keyof typeof SCHEDULE_ERROR_CODES];
  readonly remediation: string;

  constructor(args: {
    readonly code: (typeof SCHEDULE_ERROR_CODES)[keyof typeof SCHEDULE_ERROR_CODES];
    readonly message: string;
    readonly remediation: string;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'ScheduleError';
    this.code = args.code;
    this.remediation = args.remediation;
  }
}
