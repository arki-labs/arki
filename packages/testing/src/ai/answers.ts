/**
 * The answers the judge returns, as plain TS types. They are the source: `schemas.ts` checks Ollama's output
 * against them, and `../schemas.test-d.ts` locks each schema to its type both ways, so the public `.d.ts` names
 * no Zod type.
 */

/** The judge's verdict: whether the answer passes, and why. */
export type Verdict = { pass: boolean; reason: string };

/** One claim from an answer, whether the context supports it, and the quote that does. */
export type CheckedClaim = { claim: string; supported: boolean; quote: string };
