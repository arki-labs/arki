// The Node version a project says it targets, and whether a given Node meets it.
// Its own module: it reads files, so it lives with the host code, and it needs
// no semver dependency for the few range forms version files use.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Warning } from '../core/types.js';

export type DeclaredNode = {
  /** Where the declaration was found, e.g. `/repo/.nvmrc` or `/repo/package.json (engines.node)`. */
  source: string;
  /** The range as written, e.g. `v26` or `>=22.10`. */
  range: string;
};

type Version = readonly [number, number, number];
type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; version: Version };

const PIN_FILES = ['.nvmrc', '.node-version'] as const;

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readPackageJson(file: string): { volta?: string; engines?: string } {
  const text = readText(file);
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const volta = 'volta' in parsed && typeof parsed.volta === 'object' ? parsed.volta : null;
    const engines = 'engines' in parsed && typeof parsed.engines === 'object' ? parsed.engines : null;
    const voltaNode = volta !== null && 'node' in volta && typeof volta.node === 'string' ? volta.node : undefined;
    const enginesNode =
      engines !== null && 'node' in engines && typeof engines.node === 'string' ? engines.node : undefined;
    return {
      ...(voltaNode === undefined ? {} : { volta: voltaNode }),
      ...(enginesNode === undefined ? {} : { engines: enginesNode }),
    };
  } catch {
    return {};
  }
}

/**
 * The Node version the project declares for the file at `from`, walking up
 * from its directory. A pin (`.nvmrc`, `.node-version`, `package.json`
 * `volta.node`) found anywhere up the tree wins, nearest first: it names the
 * Node to develop and measure on. Without a pin, the nearest `package.json`
 * `engines.node` is used. Undefined when the project declares nothing.
 */
export function findDeclaredNode(from: string): DeclaredNode | undefined {
  let engines: DeclaredNode | undefined;
  for (let dir = path.dirname(path.resolve(from)); ; dir = path.dirname(dir)) {
    for (const name of PIN_FILES) {
      const file = path.join(dir, name);
      const range = existsSync(file) ? readText(file)?.split('\n')[0]?.trim() : undefined;
      if (range) return { source: file, range };
    }
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const found = readPackageJson(manifest);
      if (found.volta !== undefined) return { source: `${manifest} (volta.node)`, range: found.volta };
      if (engines === undefined && found.engines !== undefined) {
        engines = { source: `${manifest} (engines.node)`, range: found.engines };
      }
    }
    if (path.dirname(dir) === dir) return engines;
  }
}

/** `26`, `v26.1`, `22.13.1`, `x`, `*` → numbers, with `undefined` for a missing or wildcard part. */
function parsePartial(text: string): readonly [number | undefined, number | undefined, number | undefined] | undefined {
  const match = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return undefined;
  const part = (value: string | undefined): number | undefined =>
    value === undefined || /^[x*]$/i.test(value) ? undefined : Number(value);
  return [part(match[1]), part(match[2]), part(match[3])];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** One range term (`>=22.10`, `^26`, `~22.1`, `26`, `26.x`) as comparators, or undefined if unreadable. */
function termToComparators(term: string): readonly Comparator[] | undefined {
  const match = /^(>=|<=|[<>=^~])?(.+)$/.exec(term);
  const operator = match?.[1] ?? '';
  const partial = match?.[2] === undefined ? undefined : parsePartial(match[2]);
  if (!partial) return undefined;
  const [major, minor, patch] = partial;
  if (major === undefined) return operator === '' || operator === '>=' || operator === '=' ? [] : undefined;
  const low: Version = [major, minor ?? 0, patch ?? 0];
  const next = (...parts: Version): Comparator => ({ op: '<', version: parts });
  switch (operator) {
    case '>=': {
      return [{ op: '>=', version: low }];
    }
    case '>': {
      return minor === undefined
        ? [{ op: '>=', version: [major + 1, 0, 0] }]
        : patch === undefined
          ? [{ op: '>=', version: [major, minor + 1, 0] }]
          : [{ op: '>', version: low }];
    }
    case '<': {
      return [{ op: '<', version: low }];
    }
    case '<=': {
      return minor === undefined
        ? [next(major + 1, 0, 0)]
        : patch === undefined
          ? [next(major, minor + 1, 0)]
          : [{ op: '<=', version: low }];
    }
    case '^': {
      return [{ op: '>=', version: low }, next(major + 1, 0, 0)];
    }
    case '~': {
      return [{ op: '>=', version: low }, minor === undefined ? next(major + 1, 0, 0) : next(major, minor + 1, 0)];
    }
    default: {
      // A bare or `=` version: a missing part is a wildcard (`26` is any 26.x.y), a full version is exact.
      if (minor === undefined) return [{ op: '>=', version: low }, next(major + 1, 0, 0)];
      if (patch === undefined) return [{ op: '>=', version: low }, next(major, minor + 1, 0)];
      return [{ op: '=', version: low }];
    }
  }
}

function holds(version: Version, { op, version: bound }: Comparator): boolean {
  const order = compare(version, bound);
  switch (op) {
    case '<': {
      return order < 0;
    }
    case '<=': {
      return order <= 0;
    }
    case '>': {
      return order > 0;
    }
    case '>=': {
      return order >= 0;
    }
    case '=': {
      return order === 0;
    }
  }
}

/**
 * Whether `version` (e.g. `22.13.1`) meets `range` (a version file line or an
 * `engines.node` range: `26`, `v26.1`, `>=22.10`, `^26`, `~22.1`, `>=20 <27`,
 * `22 || 26`). `undefined` when the range is something this reads as no
 * constraint it can judge (`lts/*`, `node`, tags), so an unclear declaration
 * never blocks a run.
 */
export function satisfiesNode(version: string, range: string): boolean | undefined {
  const parsed = parsePartial(version);
  if (!parsed || parsed[0] === undefined) return undefined;
  const actual: Version = [parsed[0], parsed[1] ?? 0, parsed[2] ?? 0];
  const alternatives = range.split('||').map(alternative => alternative.trim());
  let judged = false;
  for (const alternative of alternatives) {
    // Terms are separated by whitespace; "> = 1" style spacing is not supported.
    const terms = alternative.split(/\s+/).filter(term => term.length > 0);
    const comparators = terms.map(term => termToComparators(term));
    if (terms.length === 0 || comparators.includes(undefined)) continue;
    judged = true;
    if (comparators.every(item => item?.every(comparator => holds(actual, comparator)))) return true;
  }
  return judged ? false : undefined;
}

/**
 * Marks a Node result that ran on a Node the project does not target: a
 * blocking `node-version-mismatch` warning naming both versions. Other
 * runtimes, and results that meet the declared range, come back unchanged.
 */
export function withNodeVersionCheck<
  T extends {
    environment: { runtime: { name: string; version: string } };
    warnings: readonly Warning[];
    publishable: boolean;
  },
>(result: T, declared: DeclaredNode | undefined): T {
  const { name, version } = result.environment.runtime;
  if (declared === undefined || name !== 'node') return result;
  if (satisfiesNode(version, declared.range) !== false) return result;
  const warning: Warning = {
    code: 'node-version-mismatch',
    message:
      `Measured on Node ${version}, but the project targets Node ${declared.range} (${declared.source}). ` +
      'Run on the target Node (--node <path> or ARKI_BENCH_NODE) before trusting or publishing these numbers.',
  };
  return { ...result, warnings: [...result.warnings, warning], publishable: false };
}
