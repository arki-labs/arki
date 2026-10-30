/**
 * `@arki/cas`: a bounded computer algebra package on `@arki/expr` (RFC
 * `docs/rfcs/2026-10-15-arki-cas.md`). This entry holds the shared types,
 * errors and `conditionToLatex`; the verbs live in `@arki/cas/polynomial`,
 * `@arki/cas/simplify`, `@arki/cas/derivative` and `@arki/cas/derivation`.
 */
import { toLatex } from '@arki/expr/latex';

import type { Condition } from './core.js';

export type {
  AbortSignalLike,
  Assumption,
  Assumptions,
  CasBudget,
  CasErrorCode,
  CasInput,
  CasLimits,
  CasOptions,
  CasResult,
  Condition,
  Relation,
} from './core.js';
export { CasError, CasLimitError, DEFAULT_LIMITS } from './core.js';
export type { CasTextFailure } from './failures.js';
export { CAS_TEXT_FAILURES, NoCasValue, OverCasBudget, UnsupportedText } from './failures.js';

const RELATION = { nonzero: '\\neq 0', positive: '> 0', nonnegative: '\\geq 0', negative: '< 0' } as const;

/** `x \neq 0`, `x > 0`, `x \geq 0`, `x < 0`: math notation, so apps need no translation for it. */
export function conditionToLatex(condition: Condition): string {
  return `${toLatex(condition.subject)} ${RELATION[condition.relation]}`;
}
