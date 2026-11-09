/**
 * Number preconditions of the factory and performance helpers
 *
 * Why: a count or threshold the type allows but the helper cannot honour used to fail silently or as a raw
 * error from deep inside: `Array.from({ length: -1 })` threw a raw RangeError, a `NaN` count made zero
 * instances, a `NaN` maxMs let every run pass, and 0 iterations reported `NaN` statistics. Each is a caller
 * bug, so it is the documented invariant failure before any work runs.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { FAILURE_ERROR_CODES } from '@arki/failure';

import { createEmbedder, createJudge } from './ai/judge';
import { dumpTable } from './debug';
import { createFactory, createMany } from './factories';
import {
  assertPerformance,
  benchmarkQuery,
  comparePerformance,
  createPerformanceTracker,
  measurePerformance,
} from './performance';
import { mailbox } from './services/mailpit';

const invariantBroken = expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant });
const point = createFactory(() => ({ x: 1 }));

describe('createMany count', () => {
  it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])('count %s throws the invariant failure', count => {
    expect(() => createMany(point, count)).toThrow(invariantBroken);
  });

  it('0 is an empty list and 3 makes three', () => {
    expect(createMany(point, 0)).toEqual([]);
    expect(createMany(point, 3)).toHaveLength(3);
  });
});

describe('performance thresholds and iterations', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'maxMs %s throws the invariant failure before the operation runs',
    async maxMs => {
      let ran = 0;
      const operation = () => {
        ran += 1;
        return Promise.resolve(1);
      };
      await expect(measurePerformance('op', operation, { maxMs, logResult: false })).rejects.toThrow(invariantBroken);
      await expect(assertPerformance('op', operation, maxMs)).rejects.toThrow(invariantBroken);
      await expect(createPerformanceTracker().measure('op', operation, { maxMs })).rejects.toThrow(invariantBroken);
      expect(ran).toBe(0);
    },
  );

  it.each([0, -1, Number.NaN, 2.5])('iterations %s throws the invariant failure before any run', async iterations => {
    let ran = 0;
    const query = () => {
      ran += 1;
      return Promise.resolve(1);
    };
    await expect(benchmarkQuery('q', query, iterations)).rejects.toThrow(invariantBroken);
    await expect(comparePerformance({ q: query }, iterations)).rejects.toThrow(invariantBroken);
    expect(ran).toBe(0);
  });

  it('comparePerformance with no operations throws the invariant failure, not a raw TypeError', async () => {
    await expect(comparePerformance({})).rejects.toThrow(invariantBroken);
  });

  it('one iteration is allowed, and a met threshold passes', async () => {
    const stats = await benchmarkQuery('q', () => Promise.resolve(1), 1);
    expect(stats.iterations).toBe(1);
    await expect(
      measurePerformance('op', () => Promise.resolve(1), { maxMs: 60_000, logResult: false }),
    ).resolves.toMatchObject({ passed: true });
  });
});

// Why: `AbortSignal.timeout` throws for a fraction, NaN or a negative delay, inside the call's try, so a bad
// timeout read as `OllamaUnavailable` (the daemon down) on every call. Checked before Ollama is even asked.
describe('judge and embedder options', () => {
  const nowhere = 'http://127.0.0.1:1';

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('timeoutMs %s throws the invariant failure', async timeoutMs => {
    await expect(createJudge({ url: nowhere, model: 'm', timeoutMs })).rejects.toThrow(invariantBroken);
    await expect(createEmbedder({ url: nowhere, model: 'm', timeoutMs })).rejects.toThrow(invariantBroken);
  });

  it('seed and maxTokens must be whole numbers', async () => {
    await expect(createJudge({ url: nowhere, model: 'm', seed: 1.5 })).rejects.toThrow(invariantBroken);
    await expect(createJudge({ url: nowhere, model: 'm', maxTokens: 0 })).rejects.toThrow(invariantBroken);
  });

  it('valid options reach the daemon check (nothing listens here)', async () => {
    await expect(createJudge({ url: nowhere, model: 'm', timeoutMs: 1000 })).rejects.toThrow(/OLLAMA_NOT_RUNNING/);
  });
});

describe('dumpTable limit', () => {
  it.each([-1, Number.NaN, 2.5])('limit %s throws the invariant failure before any query', async limit => {
    // A pool that would fail to connect: the precondition is checked before any query.
    const unreachable = drizzle('postgres://127.0.0.1:1/none');
    await expect(dumpTable(unreachable, 'users', limit)).rejects.toThrow(invariantBroken);
  });
});

// Why: a NaN wait made the deadline pass at once, so the test failed as MAIL_NOT_RECEIVED with no wait at all.
describe('mailbox waitFor timeoutMs', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'timeoutMs %s throws the invariant failure before polling',
    async timeoutMs => {
      await expect(mailbox('http://127.0.0.1:1').waitFor({ to: 'a@app.test', timeoutMs })).rejects.toThrow(
        invariantBroken,
      );
    },
  );
});
