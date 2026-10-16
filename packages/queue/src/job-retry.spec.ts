// BullMQ stores job options in Redis, so a job's `Backoff` cannot travel with the job.
// These checks pin the bridge: BullMQ's attempt count and its custom strategy must say
// exactly what the `Backoff` says, or jobs retry too often, too soon, or never.

import { describe, expect, it } from 'vitest';

import { backoff } from '@arki/resilience';

import { jobDefaultOptions } from './job-options.ts';
import { customJobBackoff, defaultJobRetry, jobAttempts, workerBackoffStrategy } from './job-retry.ts';

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

  it('lets bullmqOptions override what retry sets', () => {
    expect(jobDefaultOptions({ retry: backoff.constant(5).upTo(1), bullmqOptions: { attempts: 9 } })).toMatchObject({
      attempts: 9,
    });
  });
});
