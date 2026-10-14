import { InvalidArgumentError } from '@arki/math/errors';

/** Budgets checked while parsing and in `fromJSON` (RFC §11). Each is a positive integer. */
export type Limits = {
  /** Characters of source text, checked before lexing. Default 10 000. */
  readonly length?: number;
  /** Tokens, checked while lexing. Default 5 000. */
  readonly tokens?: number;
  /** Nesting depth of the tree (a leaf is 1), checked while parsing. Also bounds every recursion over the tree. Default 256. */
  readonly depth?: number;
  /** Nodes in the tree, checked while parsing. Default 5 000. */
  readonly nodes?: number;
};

export type ResolvedLimits = {
  readonly length: number;
  readonly tokens: number;
  readonly depth: number;
  readonly nodes: number;
};

export const DEFAULT_LIMITS: ResolvedLimits = Object.freeze({ length: 10_000, tokens: 5000, depth: 256, nodes: 5000 });

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError(`limits.${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export function resolveLimits(limits: Limits | undefined): ResolvedLimits {
  if (limits === undefined) return DEFAULT_LIMITS;
  return {
    length: positive('length', limits.length, DEFAULT_LIMITS.length),
    tokens: positive('tokens', limits.tokens, DEFAULT_LIMITS.tokens),
    depth: positive('depth', limits.depth, DEFAULT_LIMITS.depth),
    nodes: positive('nodes', limits.nodes, DEFAULT_LIMITS.nodes),
  };
}
