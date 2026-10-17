/**
 * `@arki/testing/ai/vitest` — importing this file adds `toScore` to Vitest's `expect`. Use the
 * `expect` it exports: it is the same function, typed with `toScore`.
 *
 *   await expect(summary).toScore(grounded({ source }), { judge });
 */
import { expect as vitestExpect } from 'vitest';

import type { ScoreOptions } from './matcher.js';
import type { Scorer } from './score.js';
import { scoreMatch } from './matcher.js';

export type ScoreAssertion<TOutput> = {
  /** Same matcher, negated. A scorer that cannot score still throws: missing evidence is never a pass. */
  readonly not: ScoreAssertion<TOutput>;
  /** Fails when the scorer scores below its bar, and when it cannot score at all. */
  toScore<TInput = unknown, TExpected = unknown>(
    scorer: Scorer<TOutput, TInput, TExpected>,
    options?: ScoreOptions<TInput, TExpected>,
  ): Promise<void>;
};

export type AiExpect = Omit<typeof vitestExpect, never> &
  (<TOutput>(actual: TOutput, message?: string) => ReturnType<typeof vitestExpect<TOutput>> & ScoreAssertion<TOutput>);

vitestExpect.extend({
  async toScore(received: unknown, scorer: Scorer<unknown>, options?: ScoreOptions) {
    const match = await scoreMatch(received, scorer, options);
    return { pass: match.pass, message: () => match.message() };
  },
});

// Erasure seam: `expect.extend` adds the matcher at runtime; Vitest's own typing cannot say so without a global declaration.
export const expect = vitestExpect as unknown as AiExpect;
