/** `@arki/testing/ai` — scorers, the judge, and the score contract. Node and Bun; no test runner needed. */
export type { AiTools, FromSample, Sample, Score, Scorer } from './score.js';
export { defineScorer } from './score.js';
export type { Embedder, Judge, JudgeOptions, OllamaFailure, Verdict } from './judge.js';
export { cosine, createEmbedder, createJudge, OLLAMA_FAILURES, OllamaAnswerInvalid, OllamaUnavailable } from './judge.js';
export type { GroundedOptions } from './scorers.js';
export { containsFacts, grounded, rubric, shape, similarTo } from './scorers.js';
export type { ScoreMatch, ScoreOptions } from './matcher.js';
export { scoreMatch, UnscorableError } from './matcher.js';
