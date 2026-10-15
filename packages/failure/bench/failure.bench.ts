// Speed of @arki/failure against the Result libraries most projects use.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Each run calls a lookup `n` times; one call in four fails with data. The
// caller checks every outcome, sums the successes and reads the failure data,
// the way an app handles a usecase result. Every group states a contract that
// is checked before timing; a library that returns a different answer is
// marked `differs` and shown without a ratio.

import type { Result as NeverResult } from 'neverthrow';
import { err as neverErr, ok as neverOk } from 'neverthrow';
import { Result as TrueMyth } from 'true-myth';

import { compare, defineSuite } from '@arki/bench';
import { defineFailure, isFailure, match } from '@arki/failure';

const NotFound = defineFailure('item.not_found', { status: 404 });

/** One failure every fourth id, the rest succeed with their id as the value. */
const fails = (id: number): boolean => id % 4 === 3;

type Missing = { readonly code: 'item.not_found'; readonly id: number };

const lookupArki = (id: number) => (fails(id) ? NotFound() : id);
const lookupNeverthrow = (id: number): NeverResult<number, Missing> =>
  fails(id) ? neverErr({ code: 'item.not_found', id }) : neverOk(id);
const lookupTrueMyth = (id: number): TrueMyth<number, Missing> =>
  fails(id) ? TrueMyth.err({ code: 'item.not_found', id }) : TrueMyth.ok(id);

const SIZES = [1, 100, 10_000];

export default defineSuite({
  id: '@arki/failure',
  intro:
    'Speed of `@arki/failure` against `neverthrow` and `true-myth`. Each run looks up `n` ids where one in four fails, checks every outcome, sums the successes and counts the failures, the way an app handles usecase results. Each table only ranks libraries that returned the same answer on every checked input.',
  notes: [
    '`@arki/failure` returns the success value unwrapped and the failure as a frozen branded object; the others wrap both sides in a result object.',
    'The `match` group uses each library’s own exhaustive matcher: `match` for `@arki/failure`, `.match` for neverthrow and true-myth.',
  ],
  groups: [
    compare<number>({
      id: 'check',
      title: 'Return and check: narrow each outcome with a type guard',
      contract: {
        id: 'result-check/v1',
        description: 'for ids 0..n-1, the sum of the successful ids and the number of failures',
      },
      inputs: SIZES,
      expected: n => {
        let sum = 0;
        let failed = 0;
        for (let id = 0; id < n; id++) {
          if (fails(id)) failed++;
          else sum += id;
        }
        return `${sum}:${failed}`;
      },
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/failure',
          package: '@arki/failure',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              const outcome = lookupArki(id);
              if (isFailure(outcome)) failed++;
              else sum += outcome;
            }
            return `${sum}:${failed}`;
          },
        },
        neverthrow: {
          label: 'neverthrow',
          package: 'neverthrow',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              const outcome = lookupNeverthrow(id);
              if (outcome.isErr()) failed++;
              else sum += outcome.value;
            }
            return `${sum}:${failed}`;
          },
        },
        trueMyth: {
          label: 'true-myth',
          package: 'true-myth',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              const outcome = lookupTrueMyth(id);
              if (outcome.isErr) failed++;
              else sum += outcome.value;
            }
            return `${sum}:${failed}`;
          },
        },
      },
    }),
    compare<number>({
      id: 'match',
      title: 'Return and match: one handler per branch',
      contract: {
        id: 'result-match/v1',
        description: 'for ids 0..n-1, the sum of the successful ids and the number of failures, via exhaustive match',
      },
      inputs: SIZES,
      expected: n => {
        let sum = 0;
        let failed = 0;
        for (let id = 0; id < n; id++) {
          if (fails(id)) failed++;
          else sum += id;
        }
        return `${sum}:${failed}`;
      },
      baseline: 'arki',
      cases: {
        arki: {
          label: '@arki/failure',
          package: '@arki/failure',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              match(lookupArki(id), { ok: value => (sum += value), 'item.not_found': () => failed++ });
            }
            return `${sum}:${failed}`;
          },
        },
        neverthrow: {
          label: 'neverthrow',
          package: 'neverthrow',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              lookupNeverthrow(id).match(
                value => (sum += value),
                () => failed++,
              );
            }
            return `${sum}:${failed}`;
          },
        },
        trueMyth: {
          label: 'true-myth',
          package: 'true-myth',
          run: n => {
            let sum = 0;
            let failed = 0;
            for (let id = 0; id < n; id++) {
              lookupTrueMyth(id).match({ Ok: value => (sum += value), Err: () => failed++ });
            }
            return `${sum}:${failed}`;
          },
        },
      },
    }),
  ],
});
