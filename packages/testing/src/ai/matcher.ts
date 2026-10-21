/**
 * `await expect(output).toScore(scorer)` — the runner-neutral part. Vitest and Playwright each
 * wrap `scoreMatch` in their own `expect.extend`.
 */
import type { AiTools, Sample, Score, Scorer } from './score.js';

export type ScoreOptions<TInput = unknown, TExpected = unknown> = AiTools & {
  readonly input?: TInput;
  readonly expected?: TExpected;
};

/**
 * Thrown when a scorer could not score. Never a pass, and not turned into a pass by `.not`.
 *
 * @fix Read `score.reason`. Usually the judge or embedder is unreachable, or the output has the wrong shape. Start the judge model or fix the output, then run the test again.
 * @verify bun run test -- src/ai/ai.test.ts
 */
export class UnscorableError extends Error {
  constructor(readonly score: Score) {
    super(`UNSCORABLE: ${score.name} could not score the output: ${score.reason}`);
    this.name = 'UnscorableError';
  }
}

export type ScoreMatch = { readonly pass: boolean; readonly score: Score; message(): string };

export async function scoreMatch<TOutput, TInput, TExpected>(
  output: TOutput,
  scorer: Scorer<TOutput, TInput, TExpected>,
  options: ScoreOptions<TInput, TExpected> = {},
): Promise<ScoreMatch> {
  const { input, expected, ...tools } = options;
  // Erasure seam: a sample without an input or expectation carries `undefined`; the scorer's types say what it reads.
  const sample = { output, input, expected } as Sample<TOutput, TInput, TExpected>;
  const score = await scorer.score(sample, tools);
  if (score.status === 'unscorable') throw new UnscorableError(score);
  return {
    pass: score.pass,
    score,
    message: () =>
      `${score.name} scored ${score.value.toFixed(2)} and ${score.pass ? 'passed' : 'failed'}: ${score.reason}${
        score.details === undefined ? '' : `\n${JSON.stringify(score.details, null, 2)}`
      }`,
  };
}
