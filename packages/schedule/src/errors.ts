import { z } from 'zod';

import { defineFailure, UnexpectedDefect } from '@arki/failure';

export const SCHEDULE_ERROR_CODES = {
  /**
   * @fix Correct the schedule name, timing and configuration reported by the error; trigger only registered schedules.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  invalidDefinition: 'ARKI_SCHEDULE_E001',
  /**
   * @fix Give each schedule a unique name within the schedule plugin.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  duplicateSchedule: 'ARKI_SCHEDULE_E002',
  /**
   * @fix Inspect the schedule handler failure and repair its private cause before triggering again; this legacy code is no longer emitted by the runtime.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  handlerFailure: 'ARKI_SCHEDULE_E003',
  /**
   * @fix Inspect the lock provider and restore lock acquisition before triggering again; current runtimes return schedule.lock_failed instead.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  lockAcquireFailure: 'ARKI_SCHEDULE_E004',
  /**
   * @fix Mount durableScheduler from @arki/queue/dot and pass its durable backend, or remove durable: true.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  durableBackendMissing: 'ARKI_SCHEDULE_E005',
  /** A feature-owned schedule (`schedules(needs, defs)`) declared `durable: true`.
   * @fix Remove durable: true from the feature-owned schedule or declare a driver-context durable schedule.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  durableFeatureSchedule: 'ARKI_SCHEDULE_E006',
  /** `clock: 'host'` combined with a durable schedule or backend: two clocks would fire it.
   * @fix Use the scheduler clock with durable schedules, or remove the durable backend and durable declarations when the host owns timing.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  durableWithHostClock: 'ARKI_SCHEDULE_E007',
  /** `composeSchedules` names a schedule the scheduler service does not run.
   * @fix Compose the same mounted features and an app scheduler that serves their schedules.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  scheduleNotServed: 'ARKI_SCHEDULE_E008',
  /** A schedule declared `lock`, but the feature has no `locks` service to take it from.
   * @fix Provide the feature with the locks service from @arki/lock/dot.
   * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
   */
  lockServiceMissing: 'ARKI_SCHEDULE_E009',
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
/** The lock provider refused execution; the original provider error remains private.
 * @fix Inspect the lock provider before triggering this schedule again.
 * @verify bun run test -- src/schedule.test.ts src/outcomes.test.ts src/feature-schedules.test.ts src/schedule-locks.test.ts
 */
/** The lock provider codes a schedule reports; any other provider code stays a private defect. */
export const lockCodeSchema = z.enum(['lost', 'store']);

export const ScheduleLockFailed = defineFailure('schedule.lock_failed', {
  status: 503,
  data: z.object({ lockCode: lockCodeSchema }),
  message: 'The schedule lock failed ({lockCode}).',
  remediation: 'Inspect the lock provider before triggering this schedule again.',
});

export const SCHEDULE_RUNTIME_FAILURES = { lock: ScheduleLockFailed, defect: UnexpectedDefect } as const;
