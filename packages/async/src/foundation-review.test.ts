import { expect, it } from 'vitest';

import { UnexpectedDefect } from '@arki/failure';

import { all, mapConcurrent, race, timeout } from './concurrency.js';
import { sleep } from './sleep.js';

it('timeout aborts the task signal and returns Deadline, never a lost rejection', async () => {
  let aborted = false;
  const result = await timeout(
    signal =>
      new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      }),
    5,
  );
  expect(aborted).toBe(true);
  expect(result).toMatchObject({ code: 'async.deadline' });
});

it('a rejecting task in all() returns UnexpectedDefect and aborts the siblings', async () => {
  let siblingAborted = false;
  const result = await all([
    () => Promise.reject(new Error('boom')),
    signal => new Promise<void>(resolve => signal.addEventListener('abort', () => ((siblingAborted = true), resolve()))),
  ]);
  expect(UnexpectedDefect.is(result)).toBe(true);
  expect(siblingAborted).toBe(true);
});

it('an already-aborted signal returns async.cancelled for mapConcurrent, race and sleep', async () => {
  const signal = AbortSignal.abort('stop');
  expect(await mapConcurrent([1], () => Promise.resolve(1), { signal })).toMatchObject({ code: 'async.cancelled' });
  expect(await race([() => Promise.resolve(1)], { signal })).toMatchObject({ code: 'async.cancelled' });
  expect(await sleep(1, { signal })).toMatchObject({ code: 'async.cancelled' });
});

it('invalid concurrency and wait reject the returned promise with a coded AsyncError (caller bug)', async () => {
  await expect(mapConcurrent([1], () => Promise.resolve(1), { concurrency: 0 })).rejects.toMatchObject({ code: 'ARKI_ASYNC_E005' });
  await expect(sleep(-1)).rejects.toMatchObject({ code: 'ARKI_ASYNC_E001' });
  await expect(race([])).rejects.toBeInstanceOf(AggregateError);
});
