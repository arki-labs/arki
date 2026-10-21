/**
 * argv → a raw input object, by `node:util` `parseArgs` tokens and the
 * command's `FlagSpec`s. The parser only maps and coerces; defaults, ranges
 * and enum membership are the schema's job when it validates the result.
 */
import { parseArgs } from 'node:util';

import type { FlagSpec } from './flags.js';

export type ParseIssue = {
  /** The input key, when the issue is about one. */
  readonly key: string | undefined;
  /** The flag or argument as the user typed it. */
  readonly flag: string | undefined;
  readonly message: string;
};

export type ParseResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

/** `-5`, `-1.5`, `-.5`: a negative number, never a short flag. */
const NEGATIVE_NUMBER = /^-(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

type Occurrence = { readonly spec: FlagSpec; readonly raw: string; readonly label: string; readonly positional?: boolean };

function coerce(spec: FlagSpec, raw: string, label: string): { value: unknown } | { issue: ParseIssue } {
  if (spec.kind === 'integer' && !INTEGER.test(raw)) {
    return { issue: { key: spec.key, flag: label, message: `${label} expected an integer, received "${raw}"` } };
  }
  if (spec.kind === 'number' && !NUMBER.test(raw)) {
    return { issue: { key: spec.key, flag: label, message: `${label} expected a number, received "${raw}"` } };
  }
  if (spec.kind === 'integer' || spec.kind === 'number') return { value: Number(raw) };
  if (spec.kind === 'boolean') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { issue: { key: spec.key, flag: label, message: `${label} expected true or false, received "${raw}"` } };
  }
  return { value: raw };
}

/**
 * The comma pieces of an array flag's value; `a,,b` drops the empty piece. A positional is never
 * split: the shell already made it one argument (`"Smith, John"`, `node -e "f(a, b)"`).
 */
function pieces(spec: FlagSpec, raw: string, positional: boolean): readonly string[] {
  return spec.array && !positional ? raw.split(',').filter(piece => piece !== '') : [raw];
}

/**
 * Parse `argv` against `specs`. Unknown flags, duplicate scalars, a missing
 * flag value, uncoercible numbers and extra positionals are issues; all
 * issues are collected, not just the first.
 */
export function parse(specs: readonly FlagSpec[], argv: readonly string[]): ParseResult {
  const byFlag = new Map(specs.map(spec => [spec.flag, spec]));
  const positionalSpecs = specs
    .filter(spec => spec.position !== undefined)
    .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const options = Object.fromEntries(
    specs.map(spec => [
      spec.flag,
      {
        type: spec.kind === 'boolean' ? ('boolean' as const) : ('string' as const),
        ...(spec.short === undefined ? {} : { short: spec.short }),
      },
    ]),
  );
  const { tokens } = parseArgs({
    args: [...argv],
    options,
    strict: false,
    allowPositionals: true,
    allowNegative: true,
    tokens: true,
  });

  const issues: ParseIssue[] = [];
  const occurrences: Occurrence[] = [];
  const positionals: string[] = [];
  const seenIndex = new Set<number>();

  for (const token of tokens) {
    if (token.kind === 'option-terminator') continue;
    if (token.kind === 'positional') {
      positionals.push(token.value);
      continue;
    }
    const arg = argv[token.index] ?? token.rawName;
    // A short-option group token from `-5` or `-1.5`: the whole argument is a positional.
    if (NEGATIVE_NUMBER.test(arg) && !arg.startsWith('--')) {
      if (!seenIndex.has(token.index)) positionals.push(arg);
      seenIndex.add(token.index);
      continue;
    }
    const negated = token.rawName.startsWith('--no-') && token.rawName !== `--${token.name}`;
    const long = token.rawName.startsWith('--');
    const found = byFlag.get(token.name);
    // A short flag counts only as the alias its spec declares: `-x` never reaches a long flag named `x`.
    const spec = long || found?.short === token.rawName.slice(1) ? found : undefined;
    if (spec === undefined || (negated && spec.kind !== 'boolean')) {
      issues.push({ key: undefined, flag: token.rawName, message: `Unknown flag ${token.rawName}` });
      continue;
    }
    const label = `--${spec.flag}`;
    if (spec.kind === 'boolean') {
      if (negated && token.value !== undefined) {
        issues.push({ key: spec.key, flag: token.rawName, message: `${token.rawName} takes no value` });
      } else {
        occurrences.push({ spec, raw: negated ? 'false' : (token.value ?? 'true'), label });
      }
      continue;
    }
    if (token.value === undefined) {
      issues.push({ key: spec.key, flag: label, message: `${label} needs a value` });
      continue;
    }
    // parseArgs takes the next argument whatever it is; `--label --yes` must not eat `--yes`.
    if (
      !token.inlineValue &&
      token.value !== '-' &&
      token.value.startsWith('-') &&
      !NEGATIVE_NUMBER.test(token.value)
    ) {
      issues.push({
        key: spec.key,
        flag: label,
        message: `${label} needs a value; to pass "${token.value}" write ${label}=${token.value}`,
      });
      continue;
    }
    occurrences.push({ spec, raw: token.value, label });
  }

  const last = positionalSpecs.at(-1);
  for (const [index, raw] of positionals.entries()) {
    const spec = positionalSpecs[index] ?? (last?.variadic === true ? last : undefined);
    if (spec === undefined) {
      issues.push({ key: undefined, flag: raw, message: `Unexpected argument "${raw}"` });
      continue;
    }
    occurrences.push({ spec, raw, label: `<${spec.flag}>`, positional: true });
  }

  const value: Record<string, unknown> = {};
  const counts = new Map<string, number>();
  for (const { spec, raw, label, positional } of occurrences) {
    const count = (counts.get(spec.key) ?? 0) + 1;
    counts.set(spec.key, count);
    if (!spec.array && count > 1) {
      issues.push({ key: spec.key, flag: label, message: `${label} given more than once` });
      continue;
    }
    for (const piece of pieces(spec, raw, positional === true)) {
      const result = coerce(spec, piece, label);
      if ('issue' in result) {
        issues.push(result.issue);
        continue;
      }
      const previous = value[spec.key];
      value[spec.key] = spec.array ? [...(Array.isArray(previous) ? previous : []), result.value] : result.value;
    }
  }

  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}
