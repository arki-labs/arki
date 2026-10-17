/**
 * The scorer contract. A scorer looks at one output and answers with a `Score`: a number in 0..1
 * with a reason, or "could not score". "Could not score" is a result of its own: it is never a pass
 * and never a zero, so missing evidence cannot hide inside a mean.
 */
import type { Json } from '../stack/index.js';
import type { Embedder, Judge } from './judge.js';

export type Score = { readonly name: string; readonly reason: string } & (
  | { readonly status: 'scored'; readonly value: number; readonly pass: boolean; readonly details?: Json }
  | { readonly status: 'unscorable' }
);

/** What a scorer judges: the output, and the input and expectation it came with. */
export type Sample<TOutput, TInput = unknown, TExpected = unknown> = {
  readonly output: TOutput;
  readonly input: TInput;
  readonly expected: TExpected;
};

/** What a scorer may use. They come from the stack; a scorer never builds a client. */
export type AiTools = { readonly judge?: Judge; readonly embedder?: Embedder };

export type Scorer<TOutput, TInput = unknown, TExpected = unknown> = {
  readonly name: string;
  /** `code` needs no model, `embedding` needs an embedder, `judge` needs a judge model. */
  readonly kind: 'code' | 'embedding' | 'judge';
  /** Bump when the scorer's logic or prompt changes, so a diff can refuse to compare across versions. */
  readonly version?: string;
  score(sample: Sample<TOutput, TInput, TExpected>, tools: AiTools): Promise<Score>;
};

export const defineScorer = <TOutput, TInput = unknown, TExpected = unknown>(
  scorer: Scorer<TOutput, TInput, TExpected>,
): Scorer<TOutput, TInput, TExpected> => scorer;

/** A value, or a function of the sample: `grounded({ source: ({ input }) => input.text })`. */
export type FromSample<TValue extends string | readonly string[], TOutput, TInput, TExpected> =
  TValue | ((sample: Sample<TOutput, TInput, TExpected>) => TValue);

export function resolveFromSample<TValue extends string | readonly string[], TOutput, TInput, TExpected>(
  value: FromSample<TValue, TOutput, TInput, TExpected>,
  sample: Sample<TOutput, TInput, TExpected>,
): TValue {
  return typeof value === 'function' ? value(sample) : value;
}

export const scored = (name: string, value: number, pass: boolean, reason: string, details?: Json): Score =>
  details === undefined
    ? { name, status: 'scored', value, pass, reason }
    : { name, status: 'scored', value, pass, reason, details };

export const unscorable = (name: string, reason: string): Score => ({ name, status: 'unscorable', reason });

export function requireJudge(tools: AiTools, scorer: string): Judge {
  if (tools.judge === undefined) {
    throw new Error(
      `JUDGE_REQUIRED: ${scorer} is a judge scorer. Pass a judge: expect(output).toScore(scorer, { judge }).`,
    );
  }
  return tools.judge;
}

export function requireEmbedder(tools: AiTools, scorer: string): Embedder {
  if (tools.embedder === undefined) {
    throw new Error(
      `EMBEDDER_REQUIRED: ${scorer} needs an embedder. Pass one: expect(output).toScore(scorer, { embedder }).`,
    );
  }
  return tools.embedder;
}
