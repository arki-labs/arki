// BullMQ stores job options in Redis, so a job's `Backoff` cannot travel with the job.
// These checks pin the bridge: BullMQ's attempt count and its custom strategy must say
// exactly what the `Backoff` says, or jobs retry too often, too soon, or never.

import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import {
  defineFailure,
  InvalidInput,
  isFailure,
  UnexpectedDefect,
  UnexpectedFailure,
  ValidatorDefect,
} from '@arki/failure';
import { backoff } from '@arki/resilience';

import { jobDefaultOptions } from './job-options.ts';
import {
  customJobBackoff,
  defaultJobRetry,
  jobAttempts,
  markThrown,
  retryReason,
  ReturnedFailureError,
  throwIfReturnedFailure,
  workerBackoffStrategy,
} from './job-retry.ts';

describe('job retry bridge to BullMQ', () => {
  it('sets BullMQ attempts to the retries plus the first try', () => {
    expect(jobAttempts(backoff.constant(10).upTo(4))).toBe(5);
    expect(jobAttempts(backoff.constant(10).upTo(0))).toBe(1);
    // Unlimited retries: BullMQ must never cut them short, and the count must survive JSON.
    expect(jobAttempts(backoff.constant(10))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('answers BullMQ with the backoff delay, and -1 to stop', () => {
    const strategy = workerBackoffStrategy(
      backoff
        .exponential({ base: 1000 })
        .upTo(2)
        .while(error => !(error instanceof RangeError)),
    );
    expect(strategy(1, 'custom', new Error('flaky'))).toBe(1000);
    expect(strategy(2, 'custom', new Error('flaky'))).toBe(2000);
    expect(strategy(3, 'custom', new Error('flaky'))).toBe(-1);
    expect(strategy(1, 'custom', new RangeError('bad input'))).toBe(-1);
  });

  it('keeps the old default: 3 tries, 1 s then 2 s apart, through the custom strategy', () => {
    expect(jobDefaultOptions({})).toMatchObject({ attempts: 3, backoff: customJobBackoff });
    expect([1, 2].map(attempt => defaultJobRetry.delay(attempt, new Error('flaky')))).toEqual([1000, 2000]);
  });

  it('stops invalid input and validator defects bridged by schema execution', () => {
    const strategy = workerBackoffStrategy(defaultJobRetry);
    expect(strategy(1, 'custom', new UnexpectedFailure(InvalidInput({ issues: [{ message: 'bad args' }] })))).toBe(-1);
    expect(strategy(1, 'custom', new UnexpectedFailure(ValidatorDefect({ cause: new Error('private defect') })))).toBe(
      -1,
    );
  });

  it('keeps Backoff authoritative even if plain JavaScript supplies native retry overrides', () => {
    const options = jobDefaultOptions({
      retry: backoff.constant(5).upTo(1),
      // @ts-expect-error Native retry options would diverge from the pg-boss lane.
      bullmqOptions: { attempts: 9 },
    });
    expect(options).toMatchObject({ attempts: 2, backoff: customJobBackoff });
  });
});

// A handler returns a failure for an expected outcome, such as a declined card. Running the
// job again repeats the outcome at best, and charges the customer again at worst, so the
// job fails at once. Only a failure the job's `while` asks for, such as a database timeout,
// runs again. BullMQ sees the failure as the error the worker threw, and stores its message.
/** The error the worker throws for a handler's result. */
function thrownFor(result: unknown): unknown {
  try {
    throwIfReturnedFailure(result);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a handler that returns a failure', () => {
  const CardDeclined = defineFailure('card.declined', {
    status: 402,
    data: z.object({ last4: z.string() }),
    message: 'card {last4} was declined',
  });
  const DbTimeout = defineFailure('db.timeout', { status: 503 });

  it('fails the job without a retry: a declined card is tried once, not 3 times', () => {
    const error = thrownFor(CardDeclined({ last4: '4242' }));
    expect(error).toBeInstanceOf(ReturnedFailureError);
    if (!(error instanceof ReturnedFailureError)) return;
    // The default retry allows 3 tries, but it never spends one on an expected failure.
    expect(workerBackoffStrategy(defaultJobRetry)(1, 'custom', error)).toBe(-1);
  });

  it('keeps code, message, status and data in the failed reason, for the board and the foreman', () => {
    const error = thrownFor(CardDeclined({ last4: '4242' }));
    if (!(error instanceof Error)) throw new Error('the failure did not fail the job');
    // BullMQ stores `error.message` as the job's failedReason.
    expect(JSON.parse(error.message)).toMatchObject({
      code: 'card.declined',
      message: 'card 4242 was declined',
      status: 402,
      data: { last4: '4242' },
    });
  });

  it('runs the job again for a failure that while() accepts, such as a database timeout', () => {
    const strategy = workerBackoffStrategy(
      backoff
        .exponential({ base: 1000 })
        .upTo(2)
        .while(reason => isFailure(reason) && reason.code === 'db.timeout'),
    );
    const timeout = thrownFor(DbTimeout());
    const declined = thrownFor(CardDeclined({ last4: '4242' }));
    if (!(timeout instanceof Error && declined instanceof Error)) throw new Error('the failures did not fail the job');
    expect(strategy(1, 'custom', timeout)).toBe(1000);
    expect(strategy(2, 'custom', timeout)).toBe(2000);
    expect(strategy(1, 'custom', declined)).toBe(-1);
  });

  it('a thrown error keeps the default retries, and a plain result completes the job', () => {
    expect(workerBackoffStrategy(defaultJobRetry)(1, 'custom', new Error('redis blip'))).toBe(1000);
    expect(thrownFor({ charged: true })).toBeUndefined();
  });
});

// WHY: A-23. `executeJob` turns a throw into the returned failure UnexpectedDefect for results
// and telemetry. The retry decision must still see a throw as a throw, or `upTo(2)` runs once.
describe('retryReason', () => {
  it('hands the thrown error to the backoff, so a throw follows the retry policy', () => {
    const boom = new Error('boom');
    const defect = markThrown(UnexpectedDefect({ cause: boom }), boom);
    const retry = backoff.constant(10).upTo(2);
    expect(retry.delay(1, retryReason(defect))).toBe(10);
    expect(retry.delay(1, retryReason(new ReturnedFailureError(defect)))).toBe(10);
    expect(workerBackoffStrategy(retry)(1, 'custom', new ReturnedFailureError(defect))).toBe(10);
  });

  it('keeps a handler-returned UnexpectedDefect a failure: not retried without while()', () => {
    const returned = UnexpectedDefect({ cause: new Error('returned on purpose') });
    expect(backoff.constant(10).upTo(2).delay(1, retryReason(returned))).toBeUndefined();
    expect(backoff.constant(10).upTo(2).while(UnexpectedDefect).delay(1, retryReason(returned))).toBe(10);
  });
});
