/**
 * `@arki/testing/ai/playwright` — Playwright's `expect` with `toScore`.
 *
 *   await expect(summary).toScore(grounded({ source }), { judge });
 */
import { expect as playwrightExpect } from '@playwright/test';

import type { ScoreOptions } from './matcher.js';
import type { Scorer } from './score.js';
import { scoreMatch } from './matcher.js';

export const expect = playwrightExpect.extend({
  async toScore<TOutput, TInput = unknown, TExpected = unknown>(
    received: TOutput,
    scorer: Scorer<TOutput, TInput, TExpected>,
    options?: ScoreOptions<TInput, TExpected>,
  ) {
    const match = await scoreMatch(received, scorer, options);
    return { pass: match.pass, message: () => match.message(), name: 'toScore' };
  },
});
