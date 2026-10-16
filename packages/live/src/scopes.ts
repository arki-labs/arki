/**
 * @internal The scope declaration as every consumer reads it: checked once
 * (`checkScopes`), then looked up by table. And `normalizeKey`, which writes
 * a key the way Postgres prints it, so a key from JavaScript and a key from a
 * trigger compare equal.
 */
import type { LiveKeyKind, LiveScopedTable, LiveScopes } from './types.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { liveScopesSchema } from './schema.js';

/** A checked declaration: its dimensions, each with one key kind, and its tables by `tagKey`. */
export type CheckedScopes = {
  readonly kinds: ReadonlyMap<string, LiveKeyKind>;
  readonly byTag: ReadonlyMap<string, LiveScopedTable>;
};

const EMPTY: CheckedScopes = { kinds: new Map(), byTag: new Map() };

/**
 * The declaration, or E001: valid names, every table in a declared dimension and in only one,
 * one key kind per dimension (one key space), every dimension with a table. `undefined`: no
 * table is scoped.
 */
export function checkScopes(scopes: LiveScopes | undefined, where: string): CheckedScopes {
  if (scopes === undefined) return EMPTY;
  const fail = (problem: string, remediation: string): never => {
    throw liveError(LIVE_ERROR_CODES.config, `${where}: bad scopes: ${problem}`, remediation);
  };
  const parsed = liveScopesSchema.safeParse(scopes);
  if (!parsed.success) {
    return fail(parsed.error.message, 'Build the declaration with liveScopes({ org: [[posts, posts.orgId]] }).');
  }
  const declared = new Set<string>();
  for (const dimension of parsed.data.dimensions) {
    if (declared.has(dimension)) fail(`dimension ${dimension} is declared twice`, 'Name each dimension once.');
    declared.add(dimension);
  }
  const kinds = new Map<string, LiveKeyKind>();
  const byTag = new Map<string, LiveScopedTable>();
  for (const table of parsed.data.tables) {
    const key = tagKey(table.tag);
    if (!declared.has(table.dimension)) {
      fail(
        `table ${key} names dimension ${table.dimension}, which is not declared`,
        'List the dimension in `dimensions`.',
      );
    }
    if (byTag.has(key)) fail(`table ${key} is scoped twice`, 'A table has one dimension and one key column.');
    const known = kinds.get(table.dimension);
    if (known !== undefined && known !== table.kind) {
      fail(
        `dimension ${table.dimension} mixes key kinds (${known} and ${table.kind})`,
        'One dimension is one key space: give every table of it the same column type (uuid, text or integer).',
      );
    }
    kinds.set(table.dimension, table.kind);
    byTag.set(key, table);
  }
  for (const dimension of declared) {
    if (!kinds.has(dimension))
      fail(`dimension ${dimension} has no table`, 'Scope at least one table by it, or drop it.');
  }
  return { kinds, byTag };
}

const UUID_HEX = /^[\da-f]{32}$/;
const INTEGER = /^[+-]?\d+$/;

/**
 * A key as Postgres prints it for `kind`, or `undefined` when it is not one: a UUID in lower case
 * with hyphens (from any form Postgres reads: upper case, braces, no hyphens), an integer in plain
 * decimal (no sign for zero or positives, no leading zeros), text as it is.
 */
export function normalizeKey(kind: LiveKeyKind, key: string): string | undefined {
  switch (kind) {
    case 'text': {
      return key;
    }
    case 'uuid': {
      const hex = key
        .toLowerCase()
        .replace(/^\{(.*)\}$/, '$1')
        .replaceAll('-', '');
      if (!UUID_HEX.test(hex)) return undefined;
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 'int': {
      return INTEGER.test(key) ? BigInt(key).toString() : undefined;
    }
  }
}
